import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, postMessages } from "./setup";

describe("E2E: 1M Context Model", () => {
  beforeAll(async () => { await startTestServer(); }, 30000);
  afterAll(() => { stopTestServer(); });

  test("claude-opus-4-6[1m] maps to claude-opus-4.6-1m and succeeds", async () => {
    const resp = await postMessages("claude-opus-4-6[1m]", "Reply with just: OK");
    expect(resp.status).toBe(200);

    const body = await resp.json() as any;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0].text).toBeDefined();
  }, 30000);

  test("[1m] streaming also works", async () => {
    const resp = await postMessages("claude-opus-4-6[1m]", "Reply: hi", true);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");

    const text = await resp.text();
    expect(text).toContain("message_start");
    expect(text).toContain("message_stop");
  }, 30000);
});
