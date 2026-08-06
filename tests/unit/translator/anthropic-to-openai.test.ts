import { describe, expect, test } from "bun:test";
import { translateAnthropicToOpenai } from "../../../src/translator/anthropic-to-openai";

describe("Anthropic to OpenAI Translation", () => {
  describe("system prompt", () => {
    test("string system -> system message", () => {
      const result = translateAnthropicToOpenai({
        model: "test", messages: [{ role: "user", content: "hi" }],
        system: "You are helpful",
      });
      expect(result.messages[0]).toEqual({ role: "system", content: "You are helpful" });
    });

    test("list system -> joined system message", () => {
      const result = translateAnthropicToOpenai({
        model: "test", messages: [{ role: "user", content: "hi" }],
        system: [{ type: "text", text: "Part 1" }, { type: "text", text: "Part 2" }],
      });
      expect(result.messages[0].role).toBe("system");
      expect(result.messages[0].content).toContain("Part 1");
      expect(result.messages[0].content).toContain("Part 2");
    });

    test("filters billing header blocks", () => {
      const result = translateAnthropicToOpenai({
        model: "test", messages: [{ role: "user", content: "hi" }],
        system: [
          { type: "text", text: "x-anthropic-billing-header: something" },
          { type: "text", text: "Keep this" },
        ],
      });
      expect(result.messages[0].content).toBe("Keep this");
    });

    test("no system -> no system message", () => {
      const result = translateAnthropicToOpenai({
        model: "test", messages: [{ role: "user", content: "hi" }],
      });
      expect(result.messages[0].role).toBe("user");
    });
  });

  describe("user messages", () => {
    test("string content", () => {
      const result = translateAnthropicToOpenai({
        model: "test", messages: [{ role: "user", content: "hello" }],
      });
      expect(result.messages[0]).toEqual({ role: "user", content: "hello" });
    });

    test("text blocks", () => {
      const result = translateAnthropicToOpenai({
        model: "test",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      });
      expect(result.messages[0].content[0]).toEqual({ type: "text", text: "hello" });
    });

    test("image blocks -> image_url", () => {
      const result = translateAnthropicToOpenai({
        model: "test",
        messages: [{
          role: "user",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
        }],
      });
      expect(result.messages[0].content[0].type).toBe("image_url");
      expect(result.messages[0].content[0].image_url.url).toBe("data:image/png;base64,abc");
    });

    test("tool_result -> role:tool message", () => {
      const result = translateAnthropicToOpenai({
        model: "test",
        messages: [{
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result text" }],
        }],
      });
      expect(result.messages[0]).toEqual({
        role: "tool", tool_call_id: "toolu_1", content: "result text",
      });
    });
  });

  describe("assistant messages", () => {
    test("string content", () => {
      const result = translateAnthropicToOpenai({
        model: "test",
        messages: [{ role: "assistant", content: "hi" }],
      });
      expect(result.messages[0]).toEqual({ role: "assistant", content: "hi" });
    });

    test("tool_use -> tool_calls", () => {
      const result = translateAnthropicToOpenai({
        model: "test",
        messages: [{
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "NYC" } }],
        }],
      });
      const msg = result.messages[0];
      expect(msg.tool_calls).toHaveLength(1);
      expect(msg.tool_calls[0].id).toBe("toolu_1");
      expect(msg.tool_calls[0].function.name).toBe("get_weather");
      expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ city: "NYC" });
    });

    test("text + tool_use combined", () => {
      const result = translateAnthropicToOpenai({
        model: "test",
        messages: [{
          role: "assistant",
          content: [
            { type: "text", text: "Let me check" },
            { type: "tool_use", id: "toolu_1", name: "search", input: { q: "test" } },
          ],
        }],
      });
      const msg = result.messages[0];
      expect(msg.content).toBe("Let me check");
      expect(msg.tool_calls).toHaveLength(1);
    });
  });

  describe("tools", () => {
    test("converts tools format", () => {
      const result = translateAnthropicToOpenai({
        model: "test", messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object" } }],
      });
      expect(result.tools[0]).toEqual({
        type: "function",
        function: { name: "get_weather", description: "Get weather", parameters: { type: "object" } },
      });
    });

    test("tool_choice any -> required", () => {
      const result = translateAnthropicToOpenai({
        model: "test", messages: [{ role: "user", content: "hi" }],
        tool_choice: { type: "any" },
      });
      expect(result.tool_choice).toBe("required");
    });

    test("tool_choice auto -> auto", () => {
      const result = translateAnthropicToOpenai({
        model: "test", messages: [{ role: "user", content: "hi" }],
        tool_choice: { type: "auto" },
      });
      expect(result.tool_choice).toBe("auto");
    });

    test("tool_choice tool -> function", () => {
      const result = translateAnthropicToOpenai({
        model: "test", messages: [{ role: "user", content: "hi" }],
        tool_choice: { type: "tool", name: "get_weather" },
      });
      expect(result.tool_choice).toEqual({ type: "function", function: { name: "get_weather" } });
    });
  });

  describe("other fields", () => {
    test("passes through temperature and top_p; max_tokens becomes max_completion_tokens", () => {
      const result = translateAnthropicToOpenai({
        model: "test", messages: [{ role: "user", content: "hi" }],
        temperature: 0.5, top_p: 0.9, max_tokens: 100,
      });
      expect(result.temperature).toBe(0.5);
      expect(result.top_p).toBe(0.9);
      // GPT-5.x rejects the legacy `max_tokens` spelling with a bare 400.
      expect(result.max_completion_tokens).toBe(100);
      expect(result.max_tokens).toBeUndefined();
    });

    test("stop_sequences -> stop", () => {
      const result = translateAnthropicToOpenai({
        model: "test", messages: [{ role: "user", content: "hi" }],
        stop_sequences: ["\n\n"],
      });
      expect(result.stop).toEqual(["\n\n"]);
    });

    test("stream adds stream_options", () => {
      const result = translateAnthropicToOpenai({
        model: "test", messages: [{ role: "user", content: "hi" }], stream: true,
      });
      expect(result.stream).toBe(true);
      expect(result.stream_options).toEqual({ include_usage: true });
    });
  });
});
