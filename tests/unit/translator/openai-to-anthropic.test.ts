import { describe, expect, test } from "bun:test";
import { translateOpenaiToAnthropic } from "../../../src/translator/openai-to-anthropic";

describe("OpenAI to Anthropic Translation", () => {
  test("basic text response", () => {
    const result = translateOpenaiToAnthropic({
      id: "chatcmpl-123", model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(result.type).toBe("message");
    expect(result.role).toBe("assistant");
    expect(result.content[0]).toEqual({ type: "text", text: "Hello!" });
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
  });

  test("tool_calls -> tool_use blocks", () => {
    const result = translateOpenaiToAnthropic({
      id: "chatcmpl-123", model: "gpt-4o",
      choices: [{
        message: {
          role: "assistant", content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    expect(result.stop_reason).toBe("tool_use");
    expect(result.content[0].type).toBe("tool_use");
    expect(result.content[0].id).toBe("call_1");
    expect(result.content[0].name).toBe("get_weather");
    expect(result.content[0].input).toEqual({ city: "NYC" });
  });

  test("finish_reason length -> max_tokens", () => {
    const result = translateOpenaiToAnthropic({
      id: "chatcmpl-123", model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "truncated" }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 100 },
    });
    expect(result.stop_reason).toBe("max_tokens");
  });

  test("cached tokens mapped to cache_read_input_tokens", () => {
    const result = translateOpenaiToAnthropic({
      id: "chatcmpl-123", model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } },
    });
    expect(result.usage.cache_read_input_tokens).toBe(80);
  });

  test("no cached tokens -> no cache_read_input_tokens field", () => {
    const result = translateOpenaiToAnthropic({
      id: "chatcmpl-123", model: "gpt-4o",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 5 },
    });
    expect(result.usage.cache_read_input_tokens).toBeUndefined();
  });

  test("empty choices -> empty content", () => {
    const result = translateOpenaiToAnthropic({ id: "chatcmpl-123", model: "gpt-4o", choices: [] });
    expect(result.content).toEqual([]);
    expect(result.stop_reason).toBe("end_turn");
  });

  test("text + tool_calls combined", () => {
    const result = translateOpenaiToAnthropic({
      id: "chatcmpl-123", model: "gpt-4o",
      choices: [{
        message: {
          role: "assistant", content: "Let me search",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: '{"q":"test"}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe("text");
    expect(result.content[1].type).toBe("tool_use");
  });

  test("invalid JSON in arguments -> empty object", () => {
    const result = translateOpenaiToAnthropic({
      id: "chatcmpl-123", model: "gpt-4o",
      choices: [{
        message: {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: "not json" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: {},
    });
    expect(result.content[0].input).toEqual({});
  });
});
