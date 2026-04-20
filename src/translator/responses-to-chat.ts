/**
 * Translate OpenAI Responses API <-> Chat Completions API.
 *
 * Some Copilot models (e.g. Claude) do not support /v1/responses. When the
 * client (e.g. codex CLI) sends a Responses-style request for such a model,
 * we translate it to /chat/completions, then translate the response back.
 */

// ============================================================
// Request: Responses -> Chat Completions
// ============================================================

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: any;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Convert a single Responses input item to a chat message (or null if skipped).
 */
function inputItemToChatMessage(item: any): ChatMessage | ChatMessage[] | null {
  if (!item || typeof item !== "object") return null;

  // message item: { type: "message", role, content: [{type:"input_text"|"output_text", text}] }
  if (item.type === "message" || (item.role && item.content !== undefined)) {
    const role = item.role as "user" | "assistant" | "system";
    const content = normalizeResponsesContent(item.content);
    return { role, content };
  }

  // function_call: { type: "function_call", call_id, name, arguments }
  if (item.type === "function_call") {
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: item.call_id ?? item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments ?? "" },
        },
      ],
    };
  }

  // function_call_output: { type: "function_call_output", call_id, output }
  if (item.type === "function_call_output") {
    return {
      role: "tool",
      tool_call_id: item.call_id,
      content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
    };
  }

  // reasoning items: drop — chat completions cannot consume them
  if (item.type === "reasoning") return null;

  return null;
}

/**
 * Normalize Responses content (string | array of parts) to Chat Completions content.
 */
function normalizeResponsesContent(content: any): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const parts: any[] = [];
  for (const p of content) {
    if (!p) continue;
    if (typeof p === "string") { parts.push({ type: "text", text: p }); continue; }
    if (p.type === "input_text" || p.type === "output_text" || p.type === "text") {
      parts.push({ type: "text", text: p.text ?? "" });
    } else if (p.type === "input_image" || p.type === "image_url") {
      const url = p.image_url?.url ?? p.image_url ?? p.url;
      if (url) parts.push({ type: "image_url", image_url: { url } });
    } else if (p.type === "refusal" && p.refusal) {
      parts.push({ type: "text", text: p.refusal });
    }
  }
  // If all parts are text and there's only one, flatten to string
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  if (parts.length === 0) return "";
  return parts;
}

/**
 * Translate a Responses-style request payload to a Chat Completions payload.
 */
export function translateResponsesToChat(payload: any): any {
  const out: any = {
    model: payload.model,
    stream: payload.stream ?? false,
  };

  const messages: ChatMessage[] = [];

  // instructions -> system
  if (typeof payload.instructions === "string" && payload.instructions.length > 0) {
    messages.push({ role: "system", content: payload.instructions });
  } else if (Array.isArray(payload.instructions)) {
    const text = payload.instructions
      .map((i: any) => (typeof i === "string" ? i : i?.text ?? ""))
      .filter(Boolean)
      .join("\n");
    if (text) messages.push({ role: "system", content: text });
  }

  // input -> messages
  if (typeof payload.input === "string") {
    messages.push({ role: "user", content: payload.input });
  } else if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      const m = inputItemToChatMessage(item);
      if (!m) continue;
      if (Array.isArray(m)) messages.push(...m);
      else messages.push(m);
    }
  }

  out.messages = messages;

  // Tools — Responses uses {type:"function", name, description, parameters, strict}
  // or {type:"custom", name, description, format}. Chat Completions only supports
  // {type:"function", function:{...}}.
  if (Array.isArray(payload.tools)) {
    const converted: any[] = [];
    for (const t of payload.tools) {
      if (!t || typeof t !== "object") continue;
      if (t.type === "function" && t.function) { converted.push(t); continue; }
      if (t.type === "function" && t.name) {
        converted.push({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            strict: t.strict,
          },
        });
        continue;
      }
      if (t.type === "custom" && t.name) {
        // Represent custom/freeform tools as a function taking a single string `input`
        const desc = t.description ?? "";
        const fmt = t.format ? `\n\nInput format: ${JSON.stringify(t.format)}` : "";
        converted.push({
          type: "function",
          function: {
            name: t.name,
            description: desc + fmt,
            parameters: {
              type: "object",
              properties: { input: { type: "string", description: "Raw tool input" } },
              required: ["input"],
            },
          },
        });
        continue;
      }
      // Unknown tool types — skip to avoid upstream 400s.
    }
    if (converted.length > 0) out.tools = converted;
  }

  if (payload.tool_choice !== undefined) out.tool_choice = payload.tool_choice;
  if (payload.parallel_tool_calls !== undefined) out.parallel_tool_calls = payload.parallel_tool_calls;

  // Sampling params
  if (payload.temperature !== undefined) out.temperature = payload.temperature;
  if (payload.top_p !== undefined) out.top_p = payload.top_p;
  if (payload.max_output_tokens !== undefined) out.max_tokens = payload.max_output_tokens;
  if (payload.max_tokens !== undefined) out.max_tokens = payload.max_tokens;
  if (payload.stop !== undefined) out.stop = payload.stop;
  if (payload.user !== undefined) out.user = payload.user;

  if (out.stream) {
    out.stream_options = { include_usage: true };
  }

  return out;
}

// ============================================================
// Response: Chat Completions -> Responses (non-streaming)
// ============================================================

/**
 * Translate a non-streaming Chat Completions response to a Responses object.
 */
export function translateChatToResponses(chatResp: any, model: string): any {
  const id = chatResp?.id ?? `resp_${Date.now()}`;
  const created = chatResp?.created ?? Math.floor(Date.now() / 1000);
  const choice = chatResp?.choices?.[0] ?? {};
  const msg = choice.message ?? {};

  const output: any[] = [];

  // Text content
  if (typeof msg.content === "string" && msg.content.length > 0) {
    output.push({
      id: `msg_${id}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: msg.content, annotations: [] }],
    });
  } else if (Array.isArray(msg.content)) {
    const textParts = msg.content
      .filter((p: any) => p?.type === "text" || p?.type === "output_text")
      .map((p: any) => ({ type: "output_text", text: p.text ?? "", annotations: [] }));
    if (textParts.length > 0) {
      output.push({
        id: `msg_${id}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: textParts,
      });
    }
  }

  // Tool calls -> function_call items
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc?.type === "function") {
        output.push({
          id: tc.id ?? `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: "function_call",
          status: "completed",
          call_id: tc.id,
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
        });
      }
    }
  }

  const usage = chatResp?.usage ?? {};
  return {
    id,
    object: "response",
    created_at: created,
    status: "completed",
    model,
    output,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
  };
}

// ============================================================
// Streaming: Chat Completions SSE -> Responses SSE events
// ============================================================

export class ResponsesStreamState {
  responseId: string;
  model: string;
  created: number;
  /** index of the text message item, if any */
  textItemId: string | null = null;
  textOpened = false;
  textBuffer = "";
  /** tool calls keyed by index: { id, name, args } */
  toolCalls = new Map<number, { id: string; name: string; args: string; itemId: string; opened: boolean }>();
  outputIndex = 0;
  emittedCreated = false;
  usage: any = {};
  finalText = "";

  constructor(model: string) {
    this.responseId = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.model = model;
    this.created = Math.floor(Date.now() / 1000);
  }
}

function sse(event: any): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Translate a single Chat Completions SSE chunk (parsed JSON) into zero or more
 * Responses-API SSE events. Returns SSE-formatted string to write to client.
 */
export function translateChatChunkToResponses(chunk: any, state: ResponsesStreamState): string {
  const events: string[] = [];

  // Initial response.created
  if (!state.emittedCreated) {
    state.emittedCreated = true;
    events.push(sse({
      type: "response.created",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress",
        model: state.model,
        output: [],
      },
    }));
  }

  const choice = chunk?.choices?.[0];
  if (choice) {
    const delta = choice.delta ?? {};

    // Text delta
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!state.textOpened) {
        state.textOpened = true;
        state.textItemId = `msg_${state.responseId}`;
        const itemIndex = state.outputIndex;
        state.outputIndex++;
        events.push(sse({
          type: "response.output_item.added",
          output_index: itemIndex,
          item: {
            id: state.textItemId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        }));
        events.push(sse({
          type: "response.content_part.added",
          item_id: state.textItemId,
          output_index: itemIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }));
      }
      state.textBuffer += delta.content;
      state.finalText += delta.content;
      events.push(sse({
        type: "response.output_text.delta",
        item_id: state.textItemId,
        output_index: 0,
        content_index: 0,
        delta: delta.content,
      }));
    }

    // Tool call deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = state.toolCalls.get(idx);
        if (!entry) {
          const itemIndex = state.outputIndex;
          state.outputIndex++;
          entry = {
            id: tc.id ?? `call_${Date.now()}_${idx}`,
            name: tc.function?.name ?? "",
            args: "",
            itemId: `fc_${state.responseId}_${idx}`,
            opened: false,
          };
          state.toolCalls.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;

        if (!entry.opened && entry.name) {
          entry.opened = true;
          events.push(sse({
            type: "response.output_item.added",
            output_index: idx + (state.textOpened ? 1 : 0),
            item: {
              id: entry.itemId,
              type: "function_call",
              status: "in_progress",
              call_id: entry.id,
              name: entry.name,
              arguments: "",
            },
          }));
        }

        const argDelta: string = tc.function?.arguments ?? "";
        if (argDelta) {
          entry.args += argDelta;
          events.push(sse({
            type: "response.function_call_arguments.delta",
            item_id: entry.itemId,
            output_index: idx + (state.textOpened ? 1 : 0),
            delta: argDelta,
          }));
        }
      }
    }

    // Finish
    if (choice.finish_reason) {
      if (state.textOpened) {
        events.push(sse({
          type: "response.output_text.done",
          item_id: state.textItemId,
          output_index: 0,
          content_index: 0,
          text: state.textBuffer,
        }));
        events.push(sse({
          type: "response.content_part.done",
          item_id: state.textItemId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: state.textBuffer, annotations: [] },
        }));
        events.push(sse({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            id: state.textItemId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: state.textBuffer, annotations: [] }],
          },
        }));
      }
      for (const [idx, entry] of state.toolCalls) {
        const outIdx = idx + (state.textOpened ? 1 : 0);
        events.push(sse({
          type: "response.function_call_arguments.done",
          item_id: entry.itemId,
          output_index: outIdx,
          arguments: entry.args,
        }));
        events.push(sse({
          type: "response.output_item.done",
          output_index: outIdx,
          item: {
            id: entry.itemId,
            type: "function_call",
            status: "completed",
            call_id: entry.id,
            name: entry.name,
            arguments: entry.args,
          },
        }));
      }
    }
  }

  if (chunk?.usage) state.usage = chunk.usage;

  return events.join("");
}

/**
 * Emit the final response.completed event.
 */
export function emitResponsesCompleted(state: ResponsesStreamState): string {
  const output: any[] = [];
  if (state.textOpened) {
    output.push({
      id: state.textItemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: state.textBuffer, annotations: [] }],
    });
  }
  for (const entry of state.toolCalls.values()) {
    output.push({
      id: entry.itemId,
      type: "function_call",
      status: "completed",
      call_id: entry.id,
      name: entry.name,
      arguments: entry.args,
    });
  }
  return sse({
    type: "response.completed",
    response: {
      id: state.responseId,
      object: "response",
      created_at: state.created,
      status: "completed",
      model: state.model,
      output,
      usage: {
        input_tokens: state.usage.prompt_tokens ?? 0,
        output_tokens: state.usage.completion_tokens ?? 0,
        total_tokens: state.usage.total_tokens ?? 0,
      },
    },
  });
}
