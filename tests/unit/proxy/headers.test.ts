import { describe, expect, test, beforeEach } from "bun:test";
import { initState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import {
  getCopilotHeaders,
  getAnthropicHeaders,
  hasVisionContent,
  isAgentCall,
} from "../../../src/proxy/headers";

describe("Headers", () => {
  beforeEach(() => {
    const state = initState({ ...DEFAULT_CONFIG });
    state.copilot_token = "test-copilot-token";
  });

  describe("getCopilotHeaders", () => {
    test("includes all required headers", () => {
      const h = getCopilotHeaders();
      expect(h["Authorization"]).toBe("Bearer test-copilot-token");
      expect(h["Content-Type"]).toBe("application/json");
      expect(h["Copilot-Integration-Id"]).toBe("vscode-chat");
      expect(h["Editor-Version"]).toContain("vscode/");
      expect(h["Editor-Plugin-Version"]).toContain("copilot-chat/");
      expect(h["User-Agent"]).toContain("GitHubCopilotChat/");
      expect(h["OpenAI-Intent"]).toBe("conversation-panel");
      expect(h["X-GitHub-Api-Version"]).toBe("2025-04-01");
      expect(h["X-Request-Id"]).toBeDefined();
      expect(h["X-VSCode-User-Agent-Library-Version"]).toBe("electron-fetch");
    });

    test("no vision header by default", () => {
      const h = getCopilotHeaders();
      expect(h["Copilot-Vision-Request"]).toBeUndefined();
    });

    test("includes vision header when enabled", () => {
      const h = getCopilotHeaders(true);
      expect(h["Copilot-Vision-Request"]).toBe("true");
    });

    test("X-Request-Id is unique per call", () => {
      const h1 = getCopilotHeaders();
      const h2 = getCopilotHeaders();
      expect(h1["X-Request-Id"]).not.toBe(h2["X-Request-Id"]);
    });
  });

  describe("getAnthropicHeaders", () => {
    test("includes anthropic-version", () => {
      const h = getAnthropicHeaders();
      expect(h["anthropic-version"]).toBe("2023-06-01");
    });

    test("includes all copilot headers too", () => {
      const h = getAnthropicHeaders();
      expect(h["Authorization"]).toBe("Bearer test-copilot-token");
      expect(h["Copilot-Integration-Id"]).toBe("vscode-chat");
    });

    test("vision header propagated", () => {
      const h = getAnthropicHeaders(true);
      expect(h["Copilot-Vision-Request"]).toBe("true");
      expect(h["anthropic-version"]).toBe("2023-06-01");
    });
  });

  describe("hasVisionContent", () => {
    test("returns false for text-only messages", () => {
      expect(hasVisionContent([
        { role: "user", content: "hello" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ])).toBe(false);
    });

    test("returns true for image content", () => {
      expect(hasVisionContent([
        { role: "user", content: [{ type: "image", source: { type: "base64" } }] },
      ])).toBe(true);
    });

    test("returns false for empty messages", () => {
      expect(hasVisionContent([])).toBe(false);
    });
  });

  describe("isAgentCall", () => {
    test("returns false for user-only messages", () => {
      expect(isAgentCall([
        { role: "user", content: "hi" },
      ])).toBe(false);
    });

    test("returns true when assistant message exists", () => {
      expect(isAgentCall([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ])).toBe(true);
    });

    test("returns false for empty messages", () => {
      expect(isAgentCall([])).toBe(false);
    });
  });
});
