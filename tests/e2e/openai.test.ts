import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, getBaseUrl } from "./setup";

describe("E2E: OpenAI Routes", () => {
  beforeAll(async () => { await startTestServer(); }, 30000);
  afterAll(() => { stopTestServer(); });

  test("/v1/chat/completions works", async () => {
    const resp = await fetch(`${getBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 50,
        messages: [{ role: "user", content: "Reply with just: OK" }],
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.choices).toBeArray();
    expect(body.choices.length).toBeGreaterThan(0);
    expect(body.choices[0].message.content).toBeDefined();
  }, 30000);

  test("/chat/completions (no v1 prefix) also works", async () => {
    const resp = await fetch(`${getBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 50,
        messages: [{ role: "user", content: "Reply: test" }],
      }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.choices).toBeArray();
  }, 30000);
});
