import { describe, expect, test } from "bun:test";
import {
  AnthropicStreamState,
  translateChunkToAnthropicEvents,
  reconstructOpenaiResponse,
} from "../../../src/translator/streaming";

describe("Streaming Translation", () => {
  describe("translateChunkToAnthropicEvents", () => {
    test("first chunk emits message_start + content_block_start + delta", () => {
      const state = new AnthropicStreamState();
      const events = translateChunkToAnthropicEvents({
        id: "chatcmpl-1", model: "gpt-4o",
        choices: [{ delta: { content: "Hello" }, index: 0 }],
      }, state);

      expect(events.length).toBe(3);
      expect(events[0].type).toBe("message_start");
      expect(events[1].type).toBe("content_block_start");
      expect(events[1].content_block.type).toBe("text");
      expect(events[2].type).toBe("content_block_delta");
      expect(events[2].delta.text).toBe("Hello");
    });

    test("subsequent text chunk emits only delta", () => {
      const state = new AnthropicStreamState();
      state.messageStartSent = true;
      state.currentBlockType = "text";
      state.contentBlockIndex = 0;

      const events = translateChunkToAnthropicEvents({
        choices: [{ delta: { content: " world" }, index: 0 }],
      }, state);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("content_block_delta");
      expect(events[0].delta.text).toBe(" world");
    });

    test("finish_reason emits block_stop + message_delta + message_stop", () => {
      const state = new AnthropicStreamState();
      state.messageStartSent = true;
      state.currentBlockType = "text";
      state.contentBlockIndex = 0;

      const events = translateChunkToAnthropicEvents({
        choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      }, state);

      expect(events.map((e) => e.type)).toEqual([
        "content_block_stop", "message_delta", "message_stop",
      ]);
      expect(events[1].delta.stop_reason).toBe("end_turn");
    });

    test("tool_calls finish_reason -> tool_use stop_reason", () => {
      const state = new AnthropicStreamState();
      state.messageStartSent = true;
      state.currentBlockType = "tool_use";
      state.contentBlockIndex = 0;

      const events = translateChunkToAnthropicEvents({
        choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
      }, state);

      const msgDelta = events.find((e) => e.type === "message_delta");
      expect(msgDelta?.delta.stop_reason).toBe("tool_use");
    });

    test("tool_call start emits content_block_start for tool_use", () => {
      const state = new AnthropicStreamState();
      state.messageStartSent = true;
      state.currentBlockType = null;
      state.contentBlockIndex = -1;

      const events = translateChunkToAnthropicEvents({
        choices: [{
          delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "" } }] },
          index: 0,
        }],
      }, state);

      const start = events.find((e) => e.type === "content_block_start");
      expect(start?.content_block.type).toBe("tool_use");
      expect(start?.content_block.id).toBe("call_1");
      expect(start?.content_block.name).toBe("search");
    });

    test("tool_call arguments emits input_json_delta", () => {
      const state = new AnthropicStreamState();
      state.messageStartSent = true;
      state.currentBlockType = "tool_use";
      state.contentBlockIndex = 0;
      state.toolCalls.set(0, { id: "call_1", name: "search", args: "" });

      const events = translateChunkToAnthropicEvents({
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] },
          index: 0,
        }],
      }, state);

      const delta = events.find((e) => e.type === "content_block_delta");
      expect(delta?.delta.type).toBe("input_json_delta");
      expect(delta?.delta.partial_json).toBe('{"q":');
    });

    test("usage chunk updates state", () => {
      const state = new AnthropicStreamState();
      translateChunkToAnthropicEvents({
        usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 80 } },
        choices: [],
      }, state);

      // totalInputTokens is fresh-input-only: prompt_tokens - cached_tokens.
      expect(state.totalInputTokens).toBe(20);
      expect(state.totalOutputTokens).toBe(50);
      expect(state.cacheReadInputTokens).toBe(80);
    });
  });

  describe("reconstructOpenaiResponse", () => {
    test("reconstructs from chunks", () => {
      const chunks = [
        { id: "c1", model: "gpt-4o", choices: [{ delta: { content: "Hello" }, index: 0 }] },
        { id: "c1", model: "gpt-4o", choices: [{ delta: { content: " world" }, index: 0 }] },
        { id: "c1", model: "gpt-4o", choices: [{ delta: {}, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ];
      const result = reconstructOpenaiResponse(chunks);
      expect(result.id).toBe("c1");
      expect(result.model).toBe("gpt-4o");
      expect(result.choices[0].message.content).toBe("Hello world");
      expect(result.choices[0].finish_reason).toBe("stop");
      expect(result.usage.prompt_tokens).toBe(10);
    });

    test("empty chunks returns null", () => {
      expect(reconstructOpenaiResponse([])).toBeNull();
    });

    test("reconstructs tool calls", () => {
      const chunks = [
        { id: "c1", model: "gpt-4o", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "test", arguments: '{"a' } }] }, index: 0 }] },
        { id: "c1", model: "gpt-4o", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":1}' } }] }, index: 0 }] },
        { id: "c1", model: "gpt-4o", choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
      ];
      const result = reconstructOpenaiResponse(chunks);
      expect(result.choices[0].message.tool_calls).toHaveLength(1);
      expect(result.choices[0].message.tool_calls[0].function.arguments).toBe('{"a":1}');
    });
  });
});
