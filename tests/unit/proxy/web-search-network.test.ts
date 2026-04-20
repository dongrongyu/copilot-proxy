import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { initState, getState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";

// Test the search provider functions by mocking fetch
describe("Web Search - Provider Functions", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    initState({
      ...DEFAULT_CONFIG,
      web_search: { ...DEFAULT_CONFIG.web_search, enabled: true },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("Tavily provider calls correct endpoint", async () => {
    let calledUrl = "";
    let calledBody: any = null;
    globalThis.fetch = (async (url: string, init?: any) => {
      calledUrl = url;
      calledBody = JSON.parse(init?.body ?? "{}");
      return {
        ok: true,
        json: async () => ({
          results: [
            { title: "Test", url: "https://test.com", content: "test content" },
          ],
        }),
      };
    }) as any;

    getState().config.web_search.provider = "tavily";
    getState().config.web_search.tavily_api_key = "test-key";

    const { applyWebSearchFallback } = await import("../../../src/proxy/web-search");
    const payload = {
      messages: [{ role: "user", content: "test query" }],
      tools: [{ type: "web_search", name: "web_search" }],
      tool_choice: "auto",
    };
    const result = await applyWebSearchFallback(payload);

    expect(calledUrl).toBe("https://api.tavily.com/search");
    expect(calledBody.query).toBe("test query");
    expect(calledBody.api_key).toBe("test-key");
    // web_search tools should be removed
    expect(result.payload.tools).toBeUndefined();
    // messages should have injected tool_use/tool_result
    expect(result.payload.messages.length).toBeGreaterThan(1);
    expect(result.query).toBe("test query");
    expect(result.results.length).toBe(1);
  });

  test("SearXNG provider calls correct endpoint", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return {
        ok: true,
        json: async () => ({
          results: [{ title: "SearX Result", url: "https://s.com", content: "content" }],
        }),
      };
    }) as any;

    getState().config.web_search.provider = "searxng";
    getState().config.web_search.searxng_url = "http://localhost:8888";

    const { applyWebSearchFallback } = await import("../../../src/proxy/web-search");
    const payload = {
      messages: [{ role: "user", content: "searx test" }],
      tools: [{ type: "web_search" }],
    };
    await applyWebSearchFallback(payload);

    expect(calledUrl).toContain("http://localhost:8888/search");
    expect(calledUrl).toContain("q=");
    expect(calledUrl).toContain("searx");
  });

  test("Tavily handles fetch failure gracefully", async () => {
    globalThis.fetch = (async () => { throw new Error("network error"); }) as any;

    getState().config.web_search.provider = "tavily";
    getState().config.web_search.tavily_api_key = "key";

    const { applyWebSearchFallback } = await import("../../../src/proxy/web-search");
    const payload = {
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "web_search" }],
    };
    // Should not throw, just return payload with no results injected
    const result = await applyWebSearchFallback(payload);
    expect(result.payload.messages.length).toBeGreaterThan(1); // tool_use/tool_result injected
    expect(result.payload.tools).toBeUndefined();
    expect(result.results.length).toBe(0);
  });

  test("SearXNG handles non-ok response", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500 })) as any;

    getState().config.web_search.provider = "searxng";

    const { applyWebSearchFallback } = await import("../../../src/proxy/web-search");
    const payload = {
      messages: [{ role: "user", content: "test" }],
      tools: [{ type: "web_search" }],
    };
    const result = await applyWebSearchFallback(payload);
    expect(result.payload.tools).toBeUndefined();
  });
});
