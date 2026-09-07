/** Five mutually exclusive token categories used by request logging. */
export interface NormalizedOpenAIUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
}

/** Split Chat Completions usage, including Copilot's cache-write extension. */
export function extractOpenAIUsage(usage: any): NormalizedOpenAIUsage {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    input_tokens: Math.max(0, promptTokens - cachedTokens - cacheWriteTokens),
    cache_creation_input_tokens: cacheWriteTokens,
    cache_read_input_tokens: cachedTokens,
    output_tokens: Math.max(0, completionTokens - reasoningTokens),
    reasoning_tokens: reasoningTokens,
  };
}

/** Normalize Responses usage keys, then apply the shared five-category split. */
export function extractResponsesUsage(usage: any): NormalizedOpenAIUsage {
  return extractOpenAIUsage({
    prompt_tokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
    prompt_tokens_details: usage?.input_tokens_details ?? usage?.prompt_tokens_details,
    completion_tokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0,
    completion_tokens_details:
      usage?.output_tokens_details ?? usage?.completion_tokens_details,
  });
}
