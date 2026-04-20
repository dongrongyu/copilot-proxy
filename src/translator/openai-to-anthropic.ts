/**
 * Translate OpenAI chat completion response to Anthropic message format.
 */

export function translateOpenaiToAnthropic(openaiResp: any): any {
  const choice = openaiResp.choices?.[0];
  if (!choice) {
    return {
      id: openaiResp.id ?? crypto.randomUUID(),
      type: "message",
      role: "assistant",
      content: [],
      model: openaiResp.model ?? "unknown",
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const content: any[] = [];
  const message = choice.message;

  // Text content
  if (message?.content) {
    content.push({ type: "text", text: message.content });
  }

  // Tool calls
  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      let input: any = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {}
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  // Map finish_reason
  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") {
    stopReason = "tool_use";
  } else if (choice.finish_reason === "length") {
    stopReason = "max_tokens";
  } else if (choice.finish_reason === "content_filter") {
    stopReason = "refusal";
  }

  const usage = openaiResp.usage ?? {};
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;

  return {
    id: openaiResp.id ?? crypto.randomUUID(),
    type: "message",
    role: "assistant",
    content,
    model: openaiResp.model ?? "unknown",
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: (usage.prompt_tokens ?? 0) - cachedTokens,
      output_tokens: usage.completion_tokens ?? 0,
      ...(cachedTokens > 0 ? { cache_read_input_tokens: cachedTokens } : {}),
    },
  };
}
