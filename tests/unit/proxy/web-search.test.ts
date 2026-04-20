import { describe, expect, test, beforeEach } from "bun:test";
import { initState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import {
  isWebSearchUnsupportedError,
  hasWebSearchTool,
  extractSearchQuery,
  formatSearchResults,
  injectSearchResults,
  removeWebSearchTools,
} from "../../../src/proxy/web-search";

describe("Web Search Utilities", () => {
  beforeEach(() => {
    initState({ ...DEFAULT_CONFIG });
  });

  describe("isWebSearchUnsupportedError", () => {
    test("returns true for 400 + web search unsupported", () => {
      expect(isWebSearchUnsupportedError(400, "Web search tool is unsupported")).toBe(true);
    });
    test("returns true for 422 + not supported", () => {
      expect(isWebSearchUnsupportedError(422, "Web Search is not supported for this model")).toBe(true);
    });
    test("returns false for 200", () => {
      expect(isWebSearchUnsupportedError(200, "web search unsupported")).toBe(false);
    });
    test("returns false for 400 without web search mention", () => {
      expect(isWebSearchUnsupportedError(400, "invalid request")).toBe(false);
    });
    test("returns false for 500", () => {
      expect(isWebSearchUnsupportedError(500, "web search unsupported")).toBe(false);
    });
    test("case insensitive", () => {
      expect(isWebSearchUnsupportedError(400, "WEB SEARCH is UNSUPPORTED")).toBe(true);
    });
  });

  describe("hasWebSearchTool", () => {
    test("returns true for web_search tool", () => {
      expect(hasWebSearchTool({ tools: [{ type: "web_search_20250305", name: "web_search" }] })).toBe(true);
    });
    test("returns true for web_search prefix", () => {
      expect(hasWebSearchTool({ tools: [{ type: "web_search" }] })).toBe(true);
    });
    test("returns false for no web_search", () => {
      expect(hasWebSearchTool({ tools: [{ type: "function", name: "get_weather" }] })).toBe(false);
    });
    test("returns false for no tools", () => {
      expect(hasWebSearchTool({})).toBe(false);
    });
    test("returns false for empty tools", () => {
      expect(hasWebSearchTool({ tools: [] })).toBe(false);
    });
  });

  describe("extractSearchQuery", () => {
    test("extracts from string content", () => {
      const payload = { messages: [{ role: "user", content: "What is TypeScript?" }] };
      expect(extractSearchQuery(payload)).toBe("What is TypeScript?");
    });

    test("extracts from last user message", () => {
      const payload = {
        messages: [
          { role: "user", content: "first question" },
          { role: "assistant", content: "response" },
          { role: "user", content: "second question" },
        ],
      };
      expect(extractSearchQuery(payload)).toBe("second question");
    });

    test("extracts from list content", () => {
      const payload = {
        messages: [{ role: "user", content: [{ type: "text", text: "Search this" }] }],
      };
      expect(extractSearchQuery(payload)).toBe("Search this");
    });

    test("truncates to 200 chars", () => {
      const long = "x".repeat(300);
      const payload = { messages: [{ role: "user", content: long }] };
      expect(extractSearchQuery(payload).length).toBe(200);
    });

    test("returns empty for no user messages", () => {
      const payload = { messages: [{ role: "assistant", content: "hi" }] };
      expect(extractSearchQuery(payload)).toBe("");
    });

    test("returns empty for empty messages", () => {
      expect(extractSearchQuery({ messages: [] })).toBe("");
      expect(extractSearchQuery({})).toBe("");
    });
  });

  describe("formatSearchResults", () => {
    test("formats results", () => {
      const results = [
        { title: "Result 1", url: "https://example.com/1", content: "Desc 1" },
        { title: "Result 2", url: "https://example.com/2", content: "Desc 2" },
      ];
      const formatted = formatSearchResults("test query", results);
      expect(formatted).toContain("[Web Search Results]");
      expect(formatted).toContain("test query");
      expect(formatted).toContain("1. Result 1");
      expect(formatted).toContain("URL: https://example.com/1");
      expect(formatted).toContain("2. Result 2");
    });

    test("handles empty results", () => {
      const formatted = formatSearchResults("test", []);
      expect(formatted).toContain("No results found");
      expect(formatted).toContain("test");
    });

    test("handles missing url/content", () => {
      const results = [{ title: "Only Title", url: "", content: "" }];
      const formatted = formatSearchResults("q", results);
      expect(formatted).toContain("1. Only Title");
    });
  });

  describe("injectSearchResults", () => {
    test("injects tool_use and tool_result messages", () => {
      const payload = { messages: [{ role: "user", content: "hello" }] };
      const result = injectSearchResults(payload, "search text", "test query");
      expect(result.messages).toHaveLength(3);
      // assistant tool_use
      const assistant = result.messages[1];
      expect(assistant.role).toBe("assistant");
      expect(assistant.content[0].type).toBe("tool_use");
      expect(assistant.content[0].name).toBe("web_search");
      expect(assistant.content[0].input.query).toBe("test query");
      // user tool_result
      const user = result.messages[2];
      expect(user.role).toBe("user");
      expect(user.content[0].type).toBe("tool_result");
      expect(user.content[0].tool_use_id).toBe(assistant.content[0].id);
      expect(user.content[0].content).toBe("search text");
    });

    test("reuses existing web_search tool_use id from last assistant message", () => {
      const payload = {
        messages: [
          { role: "user", content: "search something" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_existing_123", name: "web_search", input: { query: "q" } }],
          },
        ],
      };
      const result = injectSearchResults(payload, "results", "q");
      const injectedAssistant = result.messages[2];
      expect(injectedAssistant.content[0].id).toBe("toolu_existing_123");
    });

    test("does not mutate original payload", () => {
      const payload = { messages: [{ role: "user", content: "hi" }] };
      const result = injectSearchResults(payload, "new", "q");
      expect(payload.messages).toHaveLength(1);
      expect(result.messages).toHaveLength(3);
    });

    test("system prompt is untouched", () => {
      const payload = { system: "You are helpful", messages: [{ role: "user", content: "hi" }] };
      const result = injectSearchResults(payload, "results", "q");
      expect(result.system).toBe("You are helpful");
    });
  });

  describe("removeWebSearchTools", () => {
    test("removes web_search tools", () => {
      const payload = {
        tools: [
          { type: "web_search_20250305", name: "web_search" },
          { type: "function", name: "get_weather" },
        ],
        tool_choice: "auto",
      };
      const result = removeWebSearchTools(payload);
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe("get_weather");
      expect(result.tool_choice).toBe("auto");
    });

    test("removes tool_choice when all tools removed", () => {
      const payload = {
        tools: [{ type: "web_search", name: "web_search" }],
        tool_choice: "auto",
      };
      const result = removeWebSearchTools(payload);
      expect(result.tools).toBeUndefined();
      expect(result.tool_choice).toBeUndefined();
    });

    test("returns payload unchanged when no tools", () => {
      const payload = { messages: [] };
      const result = removeWebSearchTools(payload);
      expect(result).toEqual(payload);
    });
  });
});
