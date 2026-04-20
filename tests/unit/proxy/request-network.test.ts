import { describe, expect, test, afterEach } from "bun:test";
import { fetchUpstream } from "../../../src/proxy/request";
import { initState, getState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";

describe("fetchUpstream", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns response on success", async () => {
    initState({ ...DEFAULT_CONFIG });
    getState().copilot_token = "test";
    getState().token_expires_at = Date.now() / 1000 + 3600;

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: "ok" }),
    })) as any;

    const resp = await fetchUpstream("https://test.com/api", { method: "POST" }, { maxRetries: 0 });
    expect(resp.ok).toBe(true);
  });

  test("retries on connection error", async () => {
    initState({ ...DEFAULT_CONFIG });
    getState().copilot_token = "test";
    getState().token_expires_at = Date.now() / 1000 + 3600;

    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error("fetch failed");
      }
      return { ok: true, status: 200 };
    }) as any;

    const resp = await fetchUpstream("https://test.com/api", { method: "POST" }, { maxRetries: 2 });
    expect(resp.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  test("throws after exhausting retries", async () => {
    initState({ ...DEFAULT_CONFIG });
    getState().copilot_token = "test";
    getState().token_expires_at = Date.now() / 1000 + 3600;

    globalThis.fetch = (async () => {
      throw new Error("fetch failed");
    }) as any;

    await expect(
      fetchUpstream("https://test.com/api", { method: "POST" }, { maxRetries: 1 })
    ).rejects.toThrow("fetch failed");
  });

  test("does not retry non-retryable errors", async () => {
    initState({ ...DEFAULT_CONFIG });
    getState().copilot_token = "test";
    getState().token_expires_at = Date.now() / 1000 + 3600;

    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new Error("some other error");
    }) as any;

    await expect(
      fetchUpstream("https://test.com/api", { method: "POST" }, { maxRetries: 3 })
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});
