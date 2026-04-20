import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, getBaseUrl } from "./setup";

describe("E2E: Anthropic Translation Path", () => {
  beforeAll(async () => { await startTestServer(); }, 30000);
  afterAll(() => { stopTestServer(); });

  test("non-Anthropic model via /v1/messages uses translation path", async () => {
    const resp = await fetch(`${getBaseUrl()}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 50,
        stream: false,
        messages: [{ role: "user", content: "Reply with just: OK" }],
      }),
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    // Should return Anthropic-format response (translated from OpenAI)
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toBeArray();
    expect(body.stop_reason).toBeDefined();
    expect(body.usage).toBeDefined();
  }, 30000);
});
