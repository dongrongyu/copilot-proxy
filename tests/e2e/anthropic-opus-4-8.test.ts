import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, postMessages, parseSSEEvents } from "./setup";

describe("E2E: claude-opus-4.8", () => {
  beforeAll(async () => { await startTestServer(); }, 30000);
  afterAll(() => { stopTestServer(); });

  test("claude-opus-4-8 maps to claude-opus-4.8 and returns OK (non-streaming)", async () => {
    const resp = await postMessages("claude-opus-4-8", "Reply with just: OK");
    expect(resp.status).toBe(200);

    const body = await resp.json() as any;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toBeArray();
    expect(body.content[0].type).toBe("text");
    expect(body.content[0].text).toBeDefined();
    expect(body.usage).toBeDefined();
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
  }, 30000);

  test("dot-form claude-opus-4.8 passes through (non-streaming)", async () => {
    const resp = await postMessages("claude-opus-4.8", "Reply with just: hi");
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.type).toBe("message");
  }, 30000);

  test("streaming request returns SSE events", async () => {
    const resp = await postMessages("claude-opus-4-8", "Reply with just: hi", true);
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
  }, 30000);
});
