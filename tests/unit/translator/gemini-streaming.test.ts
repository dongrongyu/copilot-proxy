import { describe, expect, test } from "bun:test";
import {
  GeminiStreamState,
  translateOpenAIChunkToGemini,
  buildGeminiErrorStreamChunk,
} from "../../../src/translator/gemini-streaming";

describe("translateOpenAIChunkToGemini", () => {
  test("text delta -> text part chunk", () => {
    const state = new GeminiStreamState("gemini-2.5-pro");
    const out = translateOpenAIChunkToGemini(
      {
        id: "resp-1",
        choices: [{ delta: { content: "hello" }, index: 0 }],
      },
      state,
    );
    expect(out).toHaveLength(1);
    expect(out[0].candidates[0].content.parts).toEqual([{ text: "hello" }]);
    expect(out[0].modelVersion).toBe("gemini-2.5-pro");
    expect(out[0].responseId).toBe("resp-1");
    expect(state.responseId).toBe("resp-1");
  });

  test("empty delta without finish -> no output", () => {
    const state = new GeminiStreamState("gemini-2.5-pro");
    const out = translateOpenAIChunkToGemini(
      { choices: [{ delta: {}, index: 0 }] },
      state,
    );
    expect(out).toHaveLength(0);
  });

  test("tool_call delta accumulates, flushes on finish", () => {
    const state = new GeminiStreamState("gemini-2.5-pro");
    let out = translateOpenAIChunkToGemini(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "c1",
                  function: { name: "lookup", arguments: '{"q":"' },
                },
              ],
            },
          },
        ],
      },
      state,
    );
    expect(out).toHaveLength(0);

    out = translateOpenAIChunkToGemini(
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'x"}' } }] } },
        ],
      },
      state,
    );
    expect(out).toHaveLength(0);

    // Finish signal flushes the accumulated tool call + emits final chunk
    out = translateOpenAIChunkToGemini(
      {
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      },
      state,
    );
    expect(out).toHaveLength(2);
    expect(out[0].candidates[0].content.parts[0].functionCall.name).toBe("lookup");
    expect(out[0].candidates[0].content.parts[0].functionCall.args).toEqual({
      q: "x",
    });
    expect(out[1].candidates[0].finishReason).toBe("STOP");
    expect(out[1].usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 3,
      totalTokenCount: 13,
    });
  });

  test("finish_reason=length -> MAX_TOKENS", () => {
    const state = new GeminiStreamState("gemini-2.5-pro");
    const out = translateOpenAIChunkToGemini(
      { choices: [{ delta: {}, finish_reason: "length" }] },
      state,
    );
    expect(out[0].candidates[0].finishReason).toBe("MAX_TOKENS");
  });
});

describe("buildGeminiErrorStreamChunk", () => {
  test("returns complete error chunk", () => {
    const state = new GeminiStreamState("gemini-2.5-pro");
    state.totalInputTokens = 3;
    state.totalOutputTokens = 1;
    const chunk = buildGeminiErrorStreamChunk("boom", state);
    expect(chunk.candidates[0].finishReason).toBe("OTHER");
    expect(chunk.candidates[0].content.parts[0].text).toBe("boom");
    expect(chunk.usageMetadata.totalTokenCount).toBe(4);
    expect(chunk.modelVersion).toBe("gemini-2.5-pro");
  });
});
