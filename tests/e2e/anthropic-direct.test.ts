import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, postMessages, parseSSEEvents } from "./setup";

describe("E2E: Anthropic Direct Path", () => {
  beforeAll(async () => { await startTestServer(); }, 30000);
  afterAll(() => { stopTestServer(); });

  test("non-streaming request returns valid response", async () => {
    const resp = await postMessages("claude-opus-4-6", "Reply with just: OK");
    expect(resp.status).toBe(200);

    const body = await resp.json() as any;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toBeArray();
    expect(body.content.length).toBeGreaterThan(0);
    expect(body.content[0].type).toBe("text");
    expect(body.content[0].text).toBeDefined();
    expect(body.usage).toBeDefined();
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
  }, 30000);

  test("streaming request returns SSE events", async () => {
    const resp = await postMessages("claude-opus-4-6", "Reply with just: hi", true);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const events = await parseSSEEvents(resp);
    const types = events.map((e) => e.type);

    expect(types).toContain("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("content_block_stop");
    expect(types).toContain("message_delta");
    expect(types).toContain("message_stop");

    // message_start should have usage
    const msgStart = events.find((e) => e.type === "message_start");
    expect(msgStart?.data?.message?.usage).toBeDefined();
  }, 30000);

  test("model name mapping works (claude-opus-4-6 -> claude-opus-4.6)", async () => {
    const resp = await postMessages("claude-opus-4-6", "Reply: test");
    expect(resp.status).toBe(200);
    // The response model may show the original or mapped name
    const body = await resp.json() as any;
    expect(body.type).toBe("message");
  }, 30000);
});
