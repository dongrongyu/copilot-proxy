/**
 * SSE stream translator: OpenAI streaming chunks -> Anthropic SSE events.
 */

export class AnthropicStreamState {
  messageStartSent = false;
  contentBlockIndex = -1;
  currentBlockType: "text" | "tool_use" | null = null;
  toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
  totalInputTokens = 0;
  totalOutputTokens = 0;
  cacheReadInputTokens = 0;
  model = "unknown";
}

interface AnthropicEvent {
  type: string;
  [key: string]: any;
}

/**
 * Convert an OpenAI streaming chunk to Anthropic SSE events.
 */
export function translateChunkToAnthropicEvents(
  chunk: any,
  state: AnthropicStreamState
): AnthropicEvent[] {
  const events: AnthropicEvent[] = [];
  const choice = chunk.choices?.[0];

  // Track usage from final chunk
  if (chunk.usage) {
    state.totalInputTokens = chunk.usage.prompt_tokens ?? 0;
    state.totalOutputTokens = chunk.usage.completion_tokens ?? 0;
    state.cacheReadInputTokens =
      chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
  }

  if (chunk.model) {
    state.model = chunk.model;
  }

  if (!choice) return events;

  const delta = choice.delta;

  // Send message_start on first chunk
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    events.push({
      type: "message_start",
      message: {
        id: chunk.id ?? crypto.randomUUID(),
        type: "message",
        role: "assistant",
        content: [],
        model: state.model,
        usage: {
          input_tokens: state.totalInputTokens,
          output_tokens: 0,
          ...(state.cacheReadInputTokens > 0 ? { cache_read_input_tokens: state.cacheReadInputTokens } : {}),
        },
      },
    });
  }

  // Text content
  if (delta?.content) {
    if (state.currentBlockType !== "text") {
      // Close previous block if needed
      if (state.currentBlockType !== null) {
        events.push(...closeCurrentBlock(state));
      }
      state.contentBlockIndex++;
      state.currentBlockType = "text";
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: { type: "text", text: "" },
      });
    }
    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: { type: "text_delta", text: delta.content },
    });
  }

  // Tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const tcIndex = tc.index ?? 0;

      if (tc.id) {
        // New tool call - close previous block
        if (state.currentBlockType !== null) {
          events.push(...closeCurrentBlock(state));
        }
        state.contentBlockIndex++;
        state.currentBlockType = "tool_use";
        state.toolCalls.set(tcIndex, {
          id: tc.id,
          name: tc.function?.name ?? "",
          args: "",
        });
        events.push({
          type: "content_block_start",
          index: state.contentBlockIndex,
          content_block: {
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name ?? "",
            input: {},
          },
        });
      }

      // Accumulate arguments
      if (tc.function?.arguments) {
        const existing = state.toolCalls.get(tcIndex);
        if (existing) {
          existing.args += tc.function.arguments;
        }
        events.push({
          type: "content_block_delta",
          index: state.contentBlockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: tc.function.arguments,
          },
        });
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    if (state.currentBlockType !== null) {
      events.push(...closeCurrentBlock(state));
    }

    let stopReason = "end_turn";
    if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
    else if (choice.finish_reason === "length") stopReason = "max_tokens";

    events.push({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: state.totalInputTokens,
        output_tokens: state.totalOutputTokens,
        ...(state.cacheReadInputTokens > 0 ? { cache_read_input_tokens: state.cacheReadInputTokens } : {}),
      },
    });
    events.push({ type: "message_stop" });
  }

  return events;
}

function closeCurrentBlock(state: AnthropicStreamState): AnthropicEvent[] {
  return [
    {
      type: "content_block_stop",
      index: state.contentBlockIndex,
    },
  ];
}

/**
 * Reconstruct a complete OpenAI response from accumulated chunks.
 */
export function reconstructOpenaiResponse(chunks: any[]): any | null {
  if (chunks.length === 0) return null;

  let content = "";
  const toolCalls: any[] = [];
  let finishReason = "stop";
  let model = "unknown";
  let id = "";
  let usage: any = {};
  const toolCallMap = new Map<number, any>();

  for (const chunk of chunks) {
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.delta?.content) content += choice.delta.content;

    if (choice.delta?.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, {
            id: tc.id ?? "",
            type: "function",
            function: { name: "", arguments: "" },
          });
        }
        const existing = toolCallMap.get(idx)!;
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name = tc.function.name;
        if (tc.function?.arguments)
          existing.function.arguments += tc.function.arguments;
      }
    }
  }

  for (const [, tc] of [...toolCallMap.entries()].sort((a, b) => a[0] - b[0])) {
    toolCalls.push(tc);
  }

  return {
    id,
    model,
    choices: [
      {
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}
