import { describe, expect, test, beforeEach } from "bun:test";
import { initState, getState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import { getCopilotBaseUrl, supportsDirectAnthropicApi, supportsResponsesApi } from "../../../src/auth/copilot-token";

describe("Copilot Token Utilities", () => {
  beforeEach(() => {
    initState({ ...DEFAULT_CONFIG });
  });

  describe("getCopilotBaseUrl", () => {
    test("falls back to the individual host before any token refresh", () => {
      // copilot_base_url starts empty until the first token response is parsed.
      expect(getCopilotBaseUrl()).toBe("https://api.githubcopilot.com");
    });

    test("returns the host captured from the token response (endpoints.api)", () => {
      getState().copilot_base_url = "https://api.enterprise.githubcopilot.com";
      expect(getCopilotBaseUrl()).toBe("https://api.enterprise.githubcopilot.com");
    });

    test("returns the business host when that is what the token reported", () => {
      getState().copilot_base_url = "https://api.business.githubcopilot.com";
      expect(getCopilotBaseUrl()).toBe("https://api.business.githubcopilot.com");
    });
  });

  describe("supportsDirectAnthropicApi", () => {
    test("returns false when no models loaded", () => {
      expect(supportsDirectAnthropicApi("claude-opus-4.6")).toBe(false);
    });

    test("returns false for unknown model", () => {
      getState().models = { data: [{ id: "gpt-4", supported_endpoints: ["/chat/completions"] }] };
      expect(supportsDirectAnthropicApi("claude-opus-4.6")).toBe(false);
    });

    test("returns true for model with /v1/messages", () => {
      getState().models = {
        data: [{ id: "claude-opus-4.6", supported_endpoints: ["/v1/messages", "/chat/completions"] }],
      };
      expect(supportsDirectAnthropicApi("claude-opus-4.6")).toBe(true);
    });

    test("returns false for model without /v1/messages", () => {
      getState().models = {
        data: [{ id: "gpt-4o", supported_endpoints: ["/chat/completions"] }],
      };
      expect(supportsDirectAnthropicApi("gpt-4o")).toBe(false);
    });
  });

  describe("supportsResponsesApi", () => {
    test("returns false when no models", () => {
      expect(supportsResponsesApi("gpt-4o")).toBe(false);
    });

    test("returns true for model with /responses", () => {
      getState().models = {
        data: [{ id: "gpt-4o", supported_endpoints: ["/chat/completions", "/responses"] }],
      };
      expect(supportsResponsesApi("gpt-4o")).toBe(true);
    });

    test("returns false for model without /responses", () => {
      getState().models = {
        data: [{ id: "claude-opus-4.6", supported_endpoints: ["/v1/messages"] }],
      };
      expect(supportsResponsesApi("claude-opus-4.6")).toBe(false);
    });
  });
});
