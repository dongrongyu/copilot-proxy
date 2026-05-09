/**
 * Stream translator: OpenAI SSE chunks -> Gemini streamGenerateContent JSON chunks.
 *
 * Each Gemini stream chunk is a FULL GenerateContentResponse shape.
 * - Text deltas emit { candidates: [{ content: { role, parts: [{ text }] } }] }
 * - Tool-call deltas accumulate arguments by index; when the arguments JSON
 *   becomes parseable we emit one { functionCall } part.
 * - The final chunk carries finishReason + usageMetadata.
 */

export class GeminiStreamState {
  model: string;
  responseId?: string;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  cacheReadInputTokens = 0;
  reasoningTokens = 0;
  finishEmitted = false;
  // Per-index tool call state: id, name, args-so-far, emitted flag
  toolCalls: Map<number, { id: string; name: string; args: string; emitted: boolean }> =
    new Map();

  constructor(model: string) {
    this.model = model;
  }
}

function tryParseJson(s: string): any | null {
  if (!s || !s.trim()) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Translate a single OpenAI streaming chunk into zero or more Gemini chunks.
 * Each Gemini chunk is a complete GenerateContentResponse object.
 */
export function translateOpenAIChunkToGemini(
  chunk: any,
  state: GeminiStreamState,
): any[] {
  const out: any[] = [];

  if (chunk?.id && !state.responseId) state.responseId = chunk.id;
  if (chunk?.usage) {
    const promptTokens = chunk.usage.prompt_tokens ?? 0;
    const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
    const completionTokens = chunk.usage.completion_tokens ?? 0;
    const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
    state.totalInputTokens = Math.max(0, promptTokens - cachedTokens);
    state.cacheReadInputTokens = cachedTokens;
    state.reasoningTokens = reasoningTokens;
    state.totalOutputTokens = Math.max(0, completionTokens - reasoningTokens);
  }

  const choice = chunk?.choices?.[0];
  if (!choice) {
    // Trailing usage-only chunk (OpenAI stream_options.include_usage). Emit a
    // Gemini chunk carrying the final usageMetadata so it isn't lost.
    if (chunk?.usage && state.finishEmitted) {
      out.push({
        candidates: [
          { content: { role: "model", parts: [] }, index: 0 },
        ],
        usageMetadata: {
          promptTokenCount: state.totalInputTokens,
          candidatesTokenCount: state.totalOutputTokens,
          totalTokenCount: state.totalInputTokens + state.totalOutputTokens,
        },
        modelVersion: state.model,
        responseId: state.responseId,
      });
    }
    return out;
  }

  const delta = choice.delta ?? {};

  // Text delta
  if (typeof delta.content === "string" && delta.content.length > 0) {
    out.push({
      candidates: [
        {
          content: { role: "model", parts: [{ text: delta.content }] },
          index: 0,
        },
      ],
      modelVersion: state.model,
      responseId: state.responseId,
    });
  }

  // Tool-call deltas
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      let entry = state.toolCalls.get(idx);
      if (!entry) {
        entry = { id: "", name: "", args: "", emitted: false };
        state.toolCalls.set(idx, entry);
      }
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name = tc.function.name;
      if (typeof tc.function?.arguments === "string") {
        entry.args += tc.function.arguments;
      }
    }
  }

  // On finish, flush any tool calls and emit the final chunk.
  if (choice.finish_reason) {
    for (const [, entry] of state.toolCalls) {
      if (entry.emitted || !entry.name) continue;
      const parsed = tryParseJson(entry.args) ?? {};
      out.push({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: entry.id || undefined,
                    name: entry.name,
                    args: parsed,
                  },
                },
              ],
            },
            index: 0,
          },
        ],
        modelVersion: state.model,
        responseId: state.responseId,
      });
      entry.emitted = true;
    }

    out.push({
      candidates: [
        {
          content: { role: "model", parts: [] },
          finishReason: mapStreamFinishReason(choice.finish_reason),
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: state.totalInputTokens,
        candidatesTokenCount: state.totalOutputTokens,
        totalTokenCount: state.totalInputTokens + state.totalOutputTokens,
      },
      modelVersion: state.model,
      responseId: state.responseId,
    });
    state.finishEmitted = true;
  }

  return out;
}

function mapStreamFinishReason(openaiFinish: string): string {
  switch (openaiFinish) {
    case "stop":
    case "tool_calls":
      return "STOP";
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    default:
      return "OTHER";
  }
}

/**
 * Build an error stream chunk that signals a failure to the Gemini client.
 */
export function buildGeminiErrorStreamChunk(
  message: string,
  state: GeminiStreamState,
): any {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text: message }] },
        finishReason: "OTHER",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: state.totalInputTokens,
      candidatesTokenCount: state.totalOutputTokens,
      totalTokenCount: state.totalInputTokens + state.totalOutputTokens,
    },
    modelVersion: state.model,
    responseId: state.responseId,
  };
}
