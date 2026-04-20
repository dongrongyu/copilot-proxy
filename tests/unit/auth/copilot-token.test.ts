import { describe, expect, test, beforeEach } from "bun:test";
import { initState, getState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import { getCopilotBaseUrl, supportsDirectAnthropicApi, supportsResponsesApi } from "../../../src/auth/copilot-token";

describe("Copilot Token Utilities", () => {
  beforeEach(() => {
    initState({ ...DEFAULT_CONFIG });
  });

  describe("getCopilotBaseUrl", () => {
    test("individual account", () => {
      getState().config.account_type = "individual";
      expect(getCopilotBaseUrl()).toBe("https://api.githubcopilot.com");
    });

    test("business account", () => {
      getState().config.account_type = "business";
      expect(getCopilotBaseUrl()).toBe("https://api.business.githubcopilot.com");
    });

    test("enterprise account", () => {
      getState().config.account_type = "enterprise";
      expect(getCopilotBaseUrl()).toBe("https://api.enterprise.githubcopilot.com");
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
