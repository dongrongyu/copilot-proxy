/**
 * Adapt an OpenAI Responses stream into synthetic Chat Completions chunks, so
 * the existing Anthropic stream translator can consume it unchanged.
 *
 * The Anthropic route reaches Copilot's `/responses`-only models by composing:
 *
 *   Responses SSE -> responsesEventToChatChunks -> translateChunkToAnthropicEvents
 *
 * Two properties of Copilot's Responses implementation drive this design:
 *
 * 1. `item_id` is NOT a stable correlation key. Copilot returns it as an opaque
 *    encrypted blob that differs on every event for the same item — the
 *    `output_item.added`, `function_call_arguments.delta` and `output_item.done`
 *    events for one tool call each carry a different `item_id`. Only
 *    `output_index` is stable across an item's events, so it is the key here.
 *    `call_id` is stable too, and is what must reach the client as the
 *    Anthropic `tool_use.id` — the client addresses its next-turn `tool_result`
 *    to that value.
 *
 * 2. Items must be serialized. `translateChunkToAnthropicEvents` emits every
 *    `input_json_delta` against whatever content block is currently open, so two
 *    items streaming at once would splice the second's arguments into the
 *    first's block and produce invalid JSON. Only one item may forward deltas at
 *    a time; the rest buffer and flush when promoted. Text and tool items share
 *    this mechanism — a text delta arriving mid-tool-call would otherwise close
 *    the tool block and reroute its arguments.
 */

interface ResponseItem {
  kind: "text" | "tool";
  /** Stable id handed to the client as the Anthropic `tool_use.id`. */
  callId: string;
  name: string;
  /** Deltas received while another item held the stream. */
  buf: string;
  /** Dense tool ordinal. `output_index` also counts message/reasoning items, so
   *  it is too sparse to use as the chat `tool_calls[].index`. */
  ordinal: number;
  promoted: boolean;
  /** Its `output_item.done` has arrived. */
  ended: boolean;
}

export class ResponsesChunkState {
  responseId = "";
  model = "";
  /** Keyed by `output_index` — the only stable per-item key. */
  items = new Map<number, ResponseItem>();
  /** Announcement order, so promotion is deterministic. */
  order: number[] = [];
  openIndex: number | null = null;
  toolOrdinal = 0;
  sawToolCall = false;
  finished = false;
}

/**
 * Mint a client-facing message id.
 *
 * Copilot returns `response.id` as a ~400-character encrypted blob that is
 * opaque to us and to the client, and it changes shape between events. Passing
 * it through would put that payload on every message for no traceability gain —
 * requests are already correlated by the proxy's own request_id in the logs.
 */
function newMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

function textChunk(text: string): any {
  return { choices: [{ index: 0, delta: { content: text } }] };
}

function toolOpenChunk(item: ResponseItem): any {
  return {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: item.ordinal,
          // The id is what opens a tool_use block downstream; omitting it here
          // would leave the arguments with nowhere to go.
          id: item.callId,
          type: "function",
          function: {
            name: item.name,
            // Must be empty: a non-empty value here is emitted as an
            // input_json_delta and would duplicate the argument prefix.
            arguments: "",
          },
        }],
      },
    }],
  };
}

function toolArgsChunk(item: ResponseItem, args: string): any {
  return {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: item.ordinal, function: { arguments: args } }] },
    }],
  };
}

/**
 * Re-key a Responses `usage` object into the Chat Completions shape the
 * Anthropic translator reads.
 *
 * Copilot also reports `input_tokens_details.cache_write_tokens`, but the
 * downstream translator hardcodes cache-creation to 0 and no model reachable on
 * this path bills a separate cache-write rate, so it is not carried over.
 */
function usageToChat(usage: any): any {
  const u = usage ?? {};
  return {
    prompt_tokens: u.input_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 },
    completion_tokens: u.output_tokens ?? 0,
    completion_tokens_details: {
      reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

/**
 * Derive the chat `finish_reason`. A Responses `response.completed` reports
 * `status: "completed"` whether or not it produced tool calls, so the tool case
 * has to be tracked as the stream runs — getting this wrong makes the client
 * see `end_turn` and silently skip executing the tools.
 */
function finishReasonFor(state: ResponsesChunkState, truncated: boolean): string {
  if (truncated) return "length";
  return state.sawToolCall ? "tool_calls" : "stop";
}

/**
 * Hand the stream to the next unpromoted item, flushing whatever it buffered.
 * Loops, because an item whose `output_item.done` already arrived while it was
 * buffered closes again immediately.
 */
function promoteReady(state: ResponsesChunkState, out: any[]): void {
  while (state.openIndex === null) {
    const nextIndex = state.order.find((i) => {
      const it = state.items.get(i);
      return it !== undefined && !it.promoted;
    });
    if (nextIndex === undefined) return;

    const item = state.items.get(nextIndex)!;
    item.promoted = true;
    state.openIndex = nextIndex;

    if (item.kind === "tool") {
      out.push(toolOpenChunk(item));
      if (item.buf) {
        out.push(toolArgsChunk(item, item.buf));
        item.buf = "";
      }
    } else if (item.buf) {
      out.push(textChunk(item.buf));
      item.buf = "";
    }

    if (item.ended) state.openIndex = null;
  }
}

/**
 * Translate one Responses SSE event into zero or more Chat Completions chunks.
 */
export function responsesEventToChatChunks(event: any, state: ResponsesChunkState): any[] {
  const type = event?.type;
  if (typeof type !== "string") return [];

  const out: any[] = [];

  switch (type) {
    case "response.created": {
      state.responseId = newMessageId();
      state.model = event.response?.model ?? state.model;
      // A truthy choices[0] is required, or the downstream translator returns
      // before emitting message_start.
      return [{ id: state.responseId, model: state.model, choices: [{ index: 0, delta: {} }] }];
    }

    case "response.output_item.added": {
      const item = event.item ?? {};
      const index = event.output_index;
      if (typeof index !== "number") return [];

      if (item.type === "function_call") {
        state.items.set(index, {
          kind: "tool",
          callId: item.call_id ?? item.id ?? "",
          name: item.name ?? "",
          buf: "",
          ordinal: state.toolOrdinal++,
          promoted: false,
          ended: false,
        });
        state.order.push(index);
        state.sawToolCall = true;
      } else if (item.type === "message") {
        state.items.set(index, {
          kind: "text",
          callId: "",
          name: "",
          buf: "",
          ordinal: -1,
          promoted: false,
          ended: false,
        });
        state.order.push(index);
      } else {
        // Reasoning and any future item type are dropped at announcement, not
        // later: a registered item would take its turn and stall the queue.
        return [];
      }

      promoteReady(state, out);
      return out;
    }

    case "response.output_text.delta":
    case "response.function_call_arguments.delta": {
      const index = event.output_index;
      const item = typeof index === "number" ? state.items.get(index) : undefined;
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!item || !delta) return [];

      if (state.openIndex !== index) {
        item.buf += delta;
        return [];
      }
      return item.kind === "tool" ? [toolArgsChunk(item, delta)] : [textChunk(delta)];
    }

    case "response.output_item.done": {
      const index = event.output_index;
      const item = typeof index === "number" ? state.items.get(index) : undefined;
      if (!item) return [];

      item.ended = true;
      if (state.openIndex === index) {
        state.openIndex = null;
        promoteReady(state, out);
      }
      return out;
    }

    case "response.completed":
    case "response.incomplete": {
      if (state.finished) return [];
      state.finished = true;

      const truncated =
        type === "response.incomplete" &&
        event.response?.incomplete_details?.reason === "max_output_tokens";

      // Usage and finish_reason ride the same chunk: the downstream translator
      // records usage before it handles finish_reason, so message_delta carries
      // the real totals.
      return [{
        usage: usageToChat(event.response?.usage),
        choices: [{ index: 0, delta: {}, finish_reason: finishReasonFor(state, truncated) }],
      }];
    }

    default:
      // response.in_progress, content_part.*, *.done for text/args, and any
      // reasoning events carry nothing the Anthropic stream needs.
      return [];
  }
}

/**
 * Emit a terminator when the upstream stream ended without one. Without this a
 * dropped connection leaves the client waiting on `message_stop` forever.
 */
export function finalizeResponsesStream(state: ResponsesChunkState): any[] {
  if (state.finished) return [];
  state.finished = true;
  return [{ choices: [{ index: 0, delta: {}, finish_reason: finishReasonFor(state, false) }] }];
}

/**
 * Translate a non-streaming Responses body into a Chat Completions response, so
 * `translateOpenaiToAnthropic` can produce the Anthropic message unchanged.
 */
export function responsesToChatResponse(resp: any): any {
  let text = "";
  const toolCalls: any[] = [];

  for (const item of resp?.output ?? []) {
    if (!item || typeof item !== "object") continue;

    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id ?? "",
        type: "function",
        function: { name: item.name ?? "", arguments: item.arguments ?? "" },
      });
    }
    // Reasoning items carry no client-visible content.
  }

  const truncated = resp?.incomplete_details?.reason === "max_output_tokens";
  const finishReason = truncated ? "length" : toolCalls.length > 0 ? "tool_calls" : "stop";

  return {
    id: newMessageId(),
    model: resp?.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReason,
    }],
    usage: usageToChat(resp?.usage),
  };
}
