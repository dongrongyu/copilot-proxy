import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, getBaseUrl } from "./setup";

describe("E2E: Models", () => {
  beforeAll(async () => { await startTestServer(); }, 30000);
  afterAll(() => { stopTestServer(); });

  test("/v1/models returns model list", async () => {
    const resp = await fetch(`${getBaseUrl()}/v1/models`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.data).toBeArray();
    expect(body.data.length).toBeGreaterThan(0);
  });

  test("model list contains claude-opus-4.6", async () => {
    const resp = await fetch(`${getBaseUrl()}/v1/models`);
    const body = await resp.json() as any;
    const ids = body.data.map((m: any) => m.id);
    expect(ids).toContain("claude-opus-4.6");
  });

  test("model list contains claude-opus-4.6-1m", async () => {
    const resp = await fetch(`${getBaseUrl()}/v1/models`);
    const body = await resp.json() as any;
    const ids = body.data.map((m: any) => m.id);
    expect(ids).toContain("claude-opus-4.6-1m");
  });

  test("/models (no v1 prefix) also works", async () => {
    const resp = await fetch(`${getBaseUrl()}/models`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.data).toBeArray();
  });
});
