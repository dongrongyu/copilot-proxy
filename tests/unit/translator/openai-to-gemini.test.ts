import { describe, expect, test } from "bun:test";
import {
  mapFinishReason,
  convertOpenAIMessageToGeminiParts,
  convertOpenAIResponseToGemini,
} from "../../../src/translator/openai-to-gemini";

describe("mapFinishReason", () => {
  test("stop -> STOP", () => {
    expect(mapFinishReason("stop")).toBe("STOP");
  });
  test("tool_calls -> STOP", () => {
    expect(mapFinishReason("tool_calls")).toBe("STOP");
  });
  test("length -> MAX_TOKENS", () => {
    expect(mapFinishReason("length")).toBe("MAX_TOKENS");
  });
  test("content_filter -> SAFETY", () => {
    expect(mapFinishReason("content_filter")).toBe("SAFETY");
  });
  test("null/undefined/empty -> FINISH_REASON_UNSPECIFIED", () => {
    expect(mapFinishReason(null)).toBe("FINISH_REASON_UNSPECIFIED");
    expect(mapFinishReason(undefined)).toBe("FINISH_REASON_UNSPECIFIED");
    expect(mapFinishReason("")).toBe("FINISH_REASON_UNSPECIFIED");
  });
  test("unknown -> OTHER", () => {
    expect(mapFinishReason("mystery")).toBe("OTHER");
  });
});

describe("convertOpenAIMessageToGeminiParts", () => {
  test("text string -> single text part", () => {
    expect(convertOpenAIMessageToGeminiParts({ content: "hi" })).toEqual([
      { text: "hi" },
    ]);
  });

  test("text block array -> text parts", () => {
    expect(
      convertOpenAIMessageToGeminiParts({
        content: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
      }),
    ).toEqual([{ text: "A" }, { text: "B" }]);
  });

  test("tool_calls -> functionCall parts", () => {
    const parts = convertOpenAIMessageToGeminiParts({
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "lookup", arguments: '{"q":"x"}' },
        },
      ],
    });
    expect(parts).toHaveLength(1);
    expect(parts[0].functionCall.name).toBe("lookup");
    expect(parts[0].functionCall.args).toEqual({ q: "x" });
    expect(parts[0].functionCall.id).toBe("c1");
  });

  test("malformed json arguments -> _raw fallback", () => {
    const parts = convertOpenAIMessageToGeminiParts({
      tool_calls: [
        { id: "c1", type: "function", function: { name: "f", arguments: "not json" } },
      ],
    });
    expect(parts[0].functionCall.args).toEqual({ _raw: "not json" });
  });

  test("empty message -> empty text part", () => {
    expect(convertOpenAIMessageToGeminiParts({})).toEqual([{ text: "" }]);
  });
});

describe("convertOpenAIResponseToGemini", () => {
  test("full response shape + usage metadata", () => {
    const resp = convertOpenAIResponseToGemini(
      {
        id: "chatcmpl-xxx",
        choices: [
          {
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
      "gemini-2.5-pro",
    );
    expect(resp.modelVersion).toBe("gemini-2.5-pro");
    expect(resp.responseId).toBe("chatcmpl-xxx");
    expect(resp.candidates).toHaveLength(1);
    expect(resp.candidates[0].content.role).toBe("model");
    expect(resp.candidates[0].content.parts).toEqual([{ text: "hi" }]);
    expect(resp.candidates[0].finishReason).toBe("STOP");
    expect(resp.usageMetadata).toEqual({
      promptTokenCount: 5,
      candidatesTokenCount: 2,
      totalTokenCount: 7,
    });
  });

  test("missing usage -> zeros", () => {
    const resp = convertOpenAIResponseToGemini(
      { choices: [{ message: { content: "x" }, finish_reason: "stop" }] },
      "gemini-2.5-pro",
    );
    expect(resp.usageMetadata).toEqual({
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    });
  });
});
