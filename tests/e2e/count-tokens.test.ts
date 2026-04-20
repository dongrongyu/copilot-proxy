import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, getBaseUrl } from "./setup";

describe("E2E: Count Tokens", () => {
  beforeAll(async () => { await startTestServer(); }, 30000);
  afterAll(() => { stopTestServer(); });

  test("/v1/messages/count_tokens returns token count", async () => {
    const resp = await fetch(`${getBaseUrl()}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello, how are you doing today?" }],
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  test("count_tokens with system prompt", async () => {
    const resp = await fetch(`${getBaseUrl()}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  test("count_tokens with tools adds overhead", async () => {
    const withoutTools = await fetch(`${getBaseUrl()}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    const withTools = await fetch(`${getBaseUrl()}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ name: "test", description: "A test tool", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
      }),
    });

    const without = await withoutTools.json() as any;
    const with_ = await withTools.json() as any;
    expect(with_.input_tokens).toBeGreaterThan(without.input_tokens);
  });
});
