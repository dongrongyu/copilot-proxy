/**
 * Translate OpenAI Chat Completions response to Gemini GenerateContentResponse.
 *
 * Gemini response shape:
 *   {
 *     candidates: [{
 *       content: { role: "model", parts: Part[] },
 *       finishReason: "STOP" | "MAX_TOKENS" | "SAFETY" | "RECITATION" | "OTHER",
 *       index: 0,
 *     }],
 *     usageMetadata: { promptTokenCount, candidatesTokenCount, totalTokenCount },
 *     modelVersion: string,
 *     responseId: string,
 *   }
 */

/**
 * Map OpenAI finish_reason -> Gemini FinishReason.
 */
export function mapFinishReason(openaiFinish: string | null | undefined): string {
  switch (openaiFinish) {
    case "stop":
      return "STOP";
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    case "tool_calls":
      // Tool use completes a turn; Gemini uses STOP with functionCall parts.
      return "STOP";
    case null:
    case undefined:
    case "":
      return "FINISH_REASON_UNSPECIFIED";
    default:
      return "OTHER";
  }
}

/**
 * Convert a single OpenAI message (from choices[0].message) to Gemini Part[].
 */
export function convertOpenAIMessageToGeminiParts(message: any): any[] {
  const parts: any[] = [];
  if (message?.content) {
    if (typeof message.content === "string") {
      parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          parts.push({ text: block.text });
        }
      }
    }
  }

  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (tc?.type !== "function" && tc?.function === undefined) continue;
      const fn = tc.function ?? {};
      let args: any = {};
      if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
        try {
          args = JSON.parse(fn.arguments);
        } catch {
          args = { _raw: fn.arguments };
        }
      } else if (typeof fn.arguments === "object" && fn.arguments !== null) {
        args = fn.arguments;
      }
      parts.push({
        functionCall: {
          id: tc.id,
          name: fn.name ?? "",
          args,
        },
      });
    }
  }

  if (parts.length === 0) parts.push({ text: "" });
  return parts;
}

/**
 * Convert a complete OpenAI chat completion response to a Gemini response.
 */
export function convertOpenAIResponseToGemini(
  openaiResp: any,
  modelVersion: string,
): any {
  const choice = openaiResp?.choices?.[0];
  const message = choice?.message ?? {};
  const parts = convertOpenAIMessageToGeminiParts(message);

  const usage = openaiResp?.usage ?? {};
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: mapFinishReason(choice?.finish_reason),
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: promptTokens,
      candidatesTokenCount: completionTokens,
      totalTokenCount: promptTokens + completionTokens,
    },
    modelVersion,
    responseId: openaiResp?.id ?? undefined,
  };
}
