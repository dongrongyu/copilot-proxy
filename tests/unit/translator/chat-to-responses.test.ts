import { describe, expect, test } from "bun:test";
import { chatToResponsesRequest } from "../../../src/translator/chat-to-responses";
import { translateResponsesToChat } from "../../../src/translator/responses-to-chat";

describe("chatToResponsesRequest", () => {
  test("system message is hoisted to instructions, not input", () => {
    const r = chatToResponsesRequest({
      model: "gpt-5.6-sol",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ],
    });

    expect(r.instructions).toBe("You are helpful.");
    expect(r.input).toHaveLength(1);
    expect(r.input[0].role).toBe("user");
  });

  test("user string becomes an input_text message item", () => {
    const r = chatToResponsesRequest({
      model: "m",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(r.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    });
  });

  test("image_url part becomes input_image with a flat url string", () => {
    const r = chatToResponsesRequest({
      model: "m",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      }],
    });

    expect(r.input[0].content).toEqual([
      { type: "input_text", text: "what is this" },
      { type: "input_image", image_url: "data:image/png;base64,AAA" },
    ]);
  });

  test("assistant text + tool_calls fan out to separate items, text first", () => {
    const r = chatToResponsesRequest({
      model: "m",
      messages: [{
        role: "assistant",
        content: "let me check",
        tool_calls: [
          { id: "toolu_a", type: "function", function: { name: "read", arguments: '{"p":"a"}' } },
          { id: "toolu_b", type: "function", function: { name: "read", arguments: '{"p":"b"}' } },
        ],
      }],
    });

    expect(r.input).toHaveLength(3);
    expect(r.input[0]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "let me check" }],
    });
    // call_id must survive verbatim — the client's next turn addresses its
    // tool_result to it.
    expect(r.input[1]).toEqual({
      type: "function_call", call_id: "toolu_a", name: "read", arguments: '{"p":"a"}',
    });
    expect(r.input[2].call_id).toBe("toolu_b");
  });

  test("assistant with empty content emits no message item", () => {
    const r = chatToResponsesRequest({
      model: "m",
      messages: [{
        role: "assistant",
        content: "",
        tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }],
      }],
    });

    expect(r.input).toHaveLength(1);
    expect(r.input[0].type).toBe("function_call");
  });

  test("tool role becomes function_call_output keyed by tool_call_id", () => {
    const r = chatToResponsesRequest({
      model: "m",
      messages: [{ role: "tool", tool_call_id: "toolu_a", content: "file contents" }],
    });

    expect(r.input[0]).toEqual({
      type: "function_call_output", call_id: "toolu_a", output: "file contents",
    });
  });

  test("tools are flattened out of the chat function wrapper", () => {
    const r = chatToResponsesRequest({
      model: "m",
      messages: [],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      }],
    });

    expect(r.tools).toEqual([{
      type: "function",
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    }]);
  });

  test("tool_choice: scalars pass through, named function is flattened", () => {
    expect(chatToResponsesRequest({ messages: [], tool_choice: "required" }).tool_choice)
      .toBe("required");
    expect(chatToResponsesRequest({
      messages: [],
      tool_choice: { type: "function", function: { name: "X" } },
    }).tool_choice).toEqual({ type: "function", name: "X" });
  });

  test("both max_tokens spellings collapse onto max_output_tokens", () => {
    expect(chatToResponsesRequest({ messages: [], max_tokens: 100 }).max_output_tokens).toBe(100);
    expect(chatToResponsesRequest({ messages: [], max_completion_tokens: 200 }).max_output_tokens)
      .toBe(200);
  });

  test("reasoning_effort is nested into reasoning.effort", () => {
    const r = chatToResponsesRequest({ messages: [], reasoning_effort: "xhigh" });
    expect(r.reasoning).toEqual({ effort: "xhigh" });
  });

  test("stop and stream_options are dropped (no Responses equivalent)", () => {
    const r = chatToResponsesRequest({
      model: "m",
      messages: [],
      stream: true,
      stop: ["\n\n"],
      stream_options: { include_usage: true },
    });

    expect(r.stop).toBeUndefined();
    expect(r.stream_options).toBeUndefined();
    expect(r.stream).toBe(true);
  });

  test("round-trips back through translateResponsesToChat", () => {
    const chat = {
      model: "gpt-5.6-sol",
      stream: false,
      messages: [
        { role: "system", content: "sys prompt" },
        { role: "user", content: "do a thing" },
        {
          role: "assistant",
          content: "calling",
          tool_calls: [{ id: "toolu_1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "toolu_1", content: "result" },
      ],
      tools: [{
        type: "function",
        function: { name: "f", description: "d", parameters: { type: "object" } },
      }],
    };

    const back = translateResponsesToChat(chatToResponsesRequest(chat));

    expect(back.messages).toEqual([
      { role: "system", content: "sys prompt" },
      { role: "user", content: "do a thing" },
      { role: "assistant", content: "calling" },
      { role: "assistant", content: null, tool_calls: [
        { id: "toolu_1", type: "function", function: { name: "f", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "toolu_1", content: "result" },
    ]);
    expect(back.tools[0].function.name).toBe("f");
  });
});
