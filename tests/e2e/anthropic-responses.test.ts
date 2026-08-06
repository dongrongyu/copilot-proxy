import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, getBaseUrl, parseSSEEvents } from "./setup";

/**
 * Covers the Anthropic -> Responses path: Claude Code driving a Copilot model
 * that is served on `/responses` only (the GPT-5.5 / 5.6 line), plus the
 * `/chat/completions` sibling path so a regression in one is not masked by the
 * other.
 */
describe("E2E: Anthropic over the Responses API", () => {
  beforeAll(async () => { await startTestServer(); }, 30000);
  afterAll(() => { stopTestServer(); });

  const post = (body: any) =>
    fetch(`${getBaseUrl()}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const WEATHER_TOOL = {
    name: "get_weather",
    description: "Get the current weather for a city",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  };

  test("responses-only model answers in Anthropic shape", async () => {
    const resp = await post({
      model: "gpt-5.6-sol",
      max_tokens: 128,
      messages: [{ role: "user", content: "Reply with just: OK" }],
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toBeArray();
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage.output_tokens).toBeGreaterThan(0);
    // Copilot's own response id is a ~400-char encrypted blob and must not leak.
    expect(body.id).toMatch(/^msg_[0-9a-f]{32}$/);
  }, 60000);

  test("the [1m] marker resolves to the bare model id", async () => {
    const resp = await post({
      model: "gpt-5.6-sol[1m]",
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with just: OK" }],
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.model).toBe("gpt-5.6-sol");
  }, 60000);

  test("streaming opens and closes the message exactly once", async () => {
    const resp = await post({
      model: "gpt-5.6-sol",
      max_tokens: 128,
      stream: true,
      messages: [{ role: "user", content: "Reply with just: OK" }],
    });

    expect(resp.status).toBe(200);
    const events = await parseSSEEvents(resp);
    const types = events.map((e) => e.type);

    expect(types[0]).toBe("message_start");
    expect(types[types.length - 1]).toBe("message_stop");
    expect(types.filter((t) => t === "message_start")).toHaveLength(1);
    expect(types.filter((t) => t === "message_delta")).toHaveLength(1);
    expect(types.filter((t) => t === "message_stop")).toHaveLength(1);
  }, 60000);

  test("parallel tool calls stream as separate, uncontaminated blocks", async () => {
    const resp = await post({
      model: "gpt-5.6-sol",
      max_tokens: 512,
      stream: true,
      messages: [{
        role: "user",
        content: "What is the weather in Paris and Tokyo? Call the tool once per city.",
      }],
      tools: [WEATHER_TOOL],
    });

    expect(resp.status).toBe(200);
    const events = await parseSSEEvents(resp);

    const starts = events.filter(
      (e) => e.type === "content_block_start" && e.data.content_block?.type === "tool_use"
    );
    expect(starts.length).toBeGreaterThanOrEqual(2);
    // Distinct block indices and distinct upstream call ids.
    expect(new Set(starts.map((e) => e.data.index)).size).toBe(starts.length);
    expect(new Set(starts.map((e) => e.data.content_block.id)).size).toBe(starts.length);

    // Each block's arguments must be whole, parseable JSON — the failure mode
    // this guards is one item's deltas being appended to another's block.
    const args: Record<number, string> = {};
    for (const e of events) {
      if (e.type === "content_block_delta" && e.data.delta?.type === "input_json_delta") {
        args[e.data.index] = (args[e.data.index] ?? "") + e.data.delta.partial_json;
      }
    }
    for (const start of starts) {
      const raw = args[start.data.index];
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!).city).toBeString();
    }

    const delta = events.find((e) => e.type === "message_delta")!;
    expect(delta.data.delta.stop_reason).toBe("tool_use");
  }, 90000);

  test("a tool result is accepted back on the next turn", async () => {
    const first = await post({
      model: "gpt-5.6-sol",
      max_tokens: 256,
      messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
      tools: [WEATHER_TOOL],
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    const toolUse = firstBody.content.find((b: any) => b.type === "tool_use");
    expect(toolUse).toBeDefined();

    // Round-tripping this id is the whole point: it comes from the upstream
    // call_id, and the next turn addresses its tool_result to it.
    const second = await post({
      model: "gpt-5.6-sol",
      max_tokens: 256,
      messages: [
        { role: "user", content: "What is the weather in Paris? Use the tool." },
        { role: "assistant", content: firstBody.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "18C, light rain" }],
        },
      ],
      tools: [WEATHER_TOOL],
    });

    expect(second.status).toBe(200);
    const secondBody = await second.json() as any;
    expect(secondBody.stop_reason).toBe("end_turn");
    const text = secondBody.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    expect(text).toContain("18");
  }, 90000);

  test("gpt-5.4 answers (regression guard for the max_tokens spelling)", async () => {
    const resp = await post({
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "Reply with just: OK" }],
    });

    expect(resp.status).toBe(200);
    expect((await resp.json() as any).type).toBe("message");
  }, 60000);

  test("a chat/completions-only model still works", async () => {
    const resp = await post({
      model: "gemini-3.6-flash",
      max_tokens: 128,
      messages: [{ role: "user", content: "Reply with just: OK" }],
    });

    expect(resp.status).toBe(200);
    expect((await resp.json() as any).type).toBe("message");
  }, 60000);
});
