import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, getBaseUrl } from "./setup";

describe("E2E: claude-opus-4.8 with max reasoning effort", () => {
  beforeAll(async () => { await startTestServer(); }, 30000);
  afterAll(() => { stopTestServer(); });

  test("thinking.type=enabled is accepted by upstream (proxy picks max effort)", async () => {
    const resp = await fetch(`${getBaseUrl()}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 2048,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [{ role: "user", content: "Reply with just: OK" }],
      }),
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.usage).toBeDefined();
    expect(body.usage.output_tokens).toBeGreaterThan(0);
  }, 60000);
});
