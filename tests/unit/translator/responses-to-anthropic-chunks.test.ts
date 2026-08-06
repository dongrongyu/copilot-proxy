import { describe, expect, test } from "bun:test";
import {
  ResponsesChunkState,
  responsesEventToChatChunks,
  finalizeResponsesStream,
  responsesToChatResponse,
} from "../../../src/translator/responses-to-anthropic-chunks";
import {
  AnthropicStreamState,
  translateChunkToAnthropicEvents,
} from "../../../src/translator/streaming";

/** Drive a whole Responses event sequence through both translators. */
function runStream(events: any[]): { events: any[]; anthropic: AnthropicStreamState } {
  const rState = new ResponsesChunkState();
  const aState = new AnthropicStreamState();
  const out: any[] = [];
  for (const e of events) {
    for (const chunk of responsesEventToChatChunks(e, rState)) {
      out.push(...translateChunkToAnthropicEvents(chunk, aState));
    }
  }
  for (const chunk of finalizeResponsesStream(rState)) {
    out.push(...translateChunkToAnthropicEvents(chunk, aState));
  }
  return { events: out, anthropic: aState };
}

const created = {
  type: "response.created",
  response: { id: "resp_1", model: "gpt-5.6-sol" },
};

function toolAdded(outputIndex: number, callId: string, name = "get_weather", itemId = "blob") {
  return {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: { type: "function_call", id: itemId, call_id: callId, name },
  };
}

function argsDelta(outputIndex: number, delta: string, itemId = "blob") {
  return {
    type: "response.function_call_arguments.delta",
    output_index: outputIndex,
    item_id: itemId,
    delta,
  };
}

function itemDone(outputIndex: number, itemId = "blob") {
  return { type: "response.output_item.done", output_index: outputIndex, item_id: itemId };
}

const completed = (usage?: any) => ({
  type: "response.completed",
  response: { status: "completed", usage },
});

describe("responsesEventToChatChunks", () => {
  test("response.created yields exactly message_start, carrying a clean id and the model", () => {
    const { events } = runStream([created, completed()]);
    expect(events[0].type).toBe("message_start");
    expect(events[0].message.model).toBe("gpt-5.6-sol");
    // Copilot's own response.id is a ~400-char encrypted blob; it must not be
    // forwarded to the client.
    expect(events[0].message.id).toMatch(/^msg_[0-9a-f]{32}$/);
    expect(events[0].message.id).not.toBe("resp_1");
  });

  test("text deltas become a text content block", () => {
    const { events } = runStream([
      created,
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "x" } },
      { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
      { type: "response.output_text.delta", output_index: 0, delta: " world" },
      itemDone(0),
      completed(),
    ]);

    const starts = events.filter((e) => e.type === "content_block_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].content_block.type).toBe("text");
    const text = events
      .filter((e) => e.type === "content_block_delta")
      .map((e) => e.delta.text)
      .join("");
    expect(text).toBe("Hello world");
  });

  test("tool_use id comes from call_id, never from item.id", () => {
    const { events } = runStream([
      created,
      toolAdded(0, "call_STABLE", "get_weather", "item_blob_1"),
      argsDelta(0, '{"city":"Paris"}'),
      itemDone(0),
      completed(),
    ]);

    const start = events.find((e) => e.type === "content_block_start")!;
    expect(start.content_block.type).toBe("tool_use");
    expect(start.content_block.id).toBe("call_STABLE");
    expect(start.content_block.name).toBe("get_weather");
  });

  test("correlates by output_index even when item_id changes on every event", () => {
    // Copilot returns item_id as an opaque blob that differs per event; only
    // output_index is stable. Keying on item_id would lose every delta.
    const { events } = runStream([
      created,
      toolAdded(0, "call_A", "get_weather", "blob_added"),
      argsDelta(0, '{"city":', "blob_delta_totally_different"),
      argsDelta(0, '"Paris"}', "blob_delta_different_again"),
      itemDone(0, "blob_done_yet_another"),
      completed(),
    ]);

    const args = events
      .filter((e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta")
      .map((e) => e.delta.partial_json)
      .join("");
    expect(args).toBe('{"city":"Paris"}');
  });

  test("two sequential tool calls land in separate blocks with distinct ids", () => {
    const { events } = runStream([
      created,
      toolAdded(0, "call_A"),
      argsDelta(0, '{"city":"Paris"}'),
      itemDone(0),
      toolAdded(1, "call_B"),
      argsDelta(1, '{"city":"Tokyo"}'),
      itemDone(1),
      completed(),
    ]);

    const starts = events.filter((e) => e.type === "content_block_start");
    expect(starts).toHaveLength(2);
    expect(starts[0].content_block.id).toBe("call_A");
    expect(starts[1].content_block.id).toBe("call_B");
    expect(starts[0].index).toBe(0);
    expect(starts[1].index).toBe(1);

    // Each block's arguments must stay whole — no cross-contamination.
    const byIndex: Record<number, string> = {};
    for (const e of events) {
      if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
        byIndex[e.index] = (byIndex[e.index] ?? "") + e.delta.partial_json;
      }
    }
    expect(byIndex[0]).toBe('{"city":"Paris"}');
    expect(byIndex[1]).toBe('{"city":"Tokyo"}');
  });

  test("an item announced while another is open buffers, then flushes on close", () => {
    const { events } = runStream([
      created,
      toolAdded(0, "call_A"),
      toolAdded(1, "call_B"),              // announced early
      argsDelta(1, '{"city":"Tokyo"}'),    // arrives before A closed
      argsDelta(0, '{"city":"Paris"}'),
      itemDone(0),
      itemDone(1),
      completed(),
    ]);

    const starts = events.filter((e) => e.type === "content_block_start");
    expect(starts).toHaveLength(2);
    expect(starts[0].content_block.id).toBe("call_A");
    expect(starts[1].content_block.id).toBe("call_B");

    const byIndex: Record<number, string> = {};
    for (const e of events) {
      if (e.type === "content_block_delta" && e.delta?.type === "input_json_delta") {
        byIndex[e.index] = (byIndex[e.index] ?? "") + e.delta.partial_json;
      }
    }
    expect(byIndex[0]).toBe('{"city":"Paris"}');
    expect(byIndex[1]).toBe('{"city":"Tokyo"}');
  });

  test("reasoning items are ignored and never take a turn", () => {
    const rState = new ResponsesChunkState();
    responsesEventToChatChunks(created, rState);
    const chunks = responsesEventToChatChunks({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "r1" },
    }, rState);

    expect(chunks).toEqual([]);
    expect(rState.openIndex).toBeNull();
    expect(rState.items.size).toBe(0);

    // A following text item still streams normally.
    const { events } = runStream([
      created,
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning" } },
      { type: "response.output_item.added", output_index: 1, item: { type: "message" } },
      { type: "response.output_text.delta", output_index: 1, delta: "answer" },
      itemDone(1),
      completed(),
    ]);
    expect(events.filter((e) => e.type === "content_block_delta")[0].delta.text).toBe("answer");
  });

  test("stop_reason is tool_use when tools ran, end_turn otherwise", () => {
    const withTool = runStream([
      created, toolAdded(0, "call_A"), argsDelta(0, "{}"), itemDone(0), completed(),
    ]);
    expect(withTool.events.find((e) => e.type === "message_delta")!.delta.stop_reason)
      .toBe("tool_use");

    const textOnly = runStream([
      created,
      { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
      { type: "response.output_text.delta", output_index: 0, delta: "hi" },
      itemDone(0),
      completed(),
    ]);
    expect(textOnly.events.find((e) => e.type === "message_delta")!.delta.stop_reason)
      .toBe("end_turn");
  });

  test("usage is re-keyed into the five-category split", () => {
    const { anthropic } = runStream([
      created,
      completed({
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 80 },
        output_tokens: 50,
        output_tokens_details: { reasoning_tokens: 20 },
      }),
    ]);

    expect(anthropic.totalInputTokens).toBe(20);
    expect(anthropic.cacheReadInputTokens).toBe(80);
    expect(anthropic.totalOutputTokens).toBe(30);
    expect(anthropic.reasoningTokens).toBe(20);
  });

  test("the stream terminates exactly once", () => {
    const { events } = runStream([created, completed()]);
    expect(events.filter((e) => e.type === "message_delta")).toHaveLength(1);
    expect(events.filter((e) => e.type === "message_stop")).toHaveLength(1);
  });

  test("a second response.completed is ignored", () => {
    const state = new ResponsesChunkState();
    responsesEventToChatChunks(created, state);
    expect(responsesEventToChatChunks(completed(), state)).toHaveLength(1);
    expect(responsesEventToChatChunks(completed(), state)).toEqual([]);
  });

  test("response.incomplete for max_output_tokens maps to max_tokens", () => {
    const { events } = runStream([
      created,
      {
        type: "response.incomplete",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      },
    ]);
    expect(events.find((e) => e.type === "message_delta")!.delta.stop_reason).toBe("max_tokens");
  });

  test("response.in_progress and part events produce nothing", () => {
    const state = new ResponsesChunkState();
    for (const t of [
      "response.in_progress",
      "response.content_part.added",
      "response.content_part.done",
      "response.output_text.done",
      "response.function_call_arguments.done",
    ]) {
      expect(responsesEventToChatChunks({ type: t, output_index: 0 }, state)).toEqual([]);
    }
  });
});

describe("finalizeResponsesStream", () => {
  test("terminates a stream that was cut off mid-flight", () => {
    const state = new ResponsesChunkState();
    responsesEventToChatChunks(created, state);
    responsesEventToChatChunks(toolAdded(0, "call_A"), state);

    const chunks = finalizeResponsesStream(state);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].finish_reason).toBe("tool_calls");
  });

  test("emits nothing when the stream already completed", () => {
    const state = new ResponsesChunkState();
    responsesEventToChatChunks(created, state);
    responsesEventToChatChunks(completed(), state);
    expect(finalizeResponsesStream(state)).toEqual([]);
  });
});

describe("responsesToChatResponse", () => {
  test("message + function_call becomes content + tool_calls", () => {
    const chat = responsesToChatResponse({
      id: "resp_1",
      model: "gpt-5.6-sol",
      output: [
        { type: "reasoning", id: "r" },
        { type: "message", content: [{ type: "output_text", text: "checking" }] },
        { type: "function_call", call_id: "call_A", name: "get_weather", arguments: '{"city":"Paris"}' },
      ],
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 2 },
      },
    });

    expect(chat.choices[0].message.content).toBe("checking");
    expect(chat.choices[0].message.tool_calls).toEqual([
      { id: "call_A", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
    ]);
    expect(chat.choices[0].finish_reason).toBe("tool_calls");
    expect(chat.usage.prompt_tokens).toBe(10);
    expect(chat.usage.prompt_tokens_details.cached_tokens).toBe(4);
  });

  test("reasoning-only output yields null content and stop", () => {
    const chat = responsesToChatResponse({ id: "r", model: "m", output: [{ type: "reasoning" }] });
    expect(chat.choices[0].message.content).toBeNull();
    expect(chat.choices[0].message.tool_calls).toBeUndefined();
    expect(chat.choices[0].finish_reason).toBe("stop");
  });

  test("truncated response reports length", () => {
    const chat = responsesToChatResponse({
      output: [{ type: "message", content: [{ type: "output_text", text: "part" }] }],
      incomplete_details: { reason: "max_output_tokens" },
    });
    expect(chat.choices[0].finish_reason).toBe("length");
  });
});
