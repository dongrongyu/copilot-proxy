/**
 * E2E: web search fallback.
 * Sends a request with web_search tool to a model that doesn't support it.
 * The proxy should detect the rejection, search via Tavily, inject results
 * as tool_use/tool_result, and retry successfully.
 *
 * Skipped by default to preserve Tavily quota. Set RUN_TAVILY_E2E=1 to enable.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { startTestServer, stopTestServer, getBaseUrl } from "./setup";

const shouldRun = process.env.RUN_TAVILY_E2E === "1";
const describeFn = shouldRun ? describe : describe.skip;

describeFn("Web Search Fallback", () => {
  beforeAll(async () => {
    await startTestServer();
  }, 30_000);

  afterAll(() => stopTestServer());

  test("fallback injects search results and returns a valid response", async () => {
    const baseUrl = getBaseUrl();

    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4.6",
        max_tokens: 200,
        stream: false,
        messages: [
          { role: "user", content: "What is the latest version of Bun.js? Search the web for this." },
        ],
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 3,
          },
        ],
      }),
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as any;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content).toBeDefined();
    expect(body.content.length).toBeGreaterThan(0);

    // Verify synthetic web search blocks are present
    const serverToolUse = body.content.find((b: any) => b.type === "server_tool_use");
    expect(serverToolUse).toBeDefined();
    expect(serverToolUse.name).toBe("web_search");
    expect(serverToolUse.input.query).toBeDefined();

    const toolResult = body.content.find((b: any) => b.type === "web_search_tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult.tool_use_id).toBe(serverToolUse.id);
    expect(toolResult.content.length).toBeGreaterThan(0);
    expect(toolResult.content[0].type).toBe("web_search_result");
    // Each result carries url + title + snippet (for non-Claude-Code clients).
    expect(toolResult.content[0].url).toBeDefined();
    expect(toolResult.content[0].title).toBeDefined();
  }, 60_000);
});
