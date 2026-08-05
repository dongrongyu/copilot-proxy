import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { initState, getState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import {
  getCopilotBaseUrl,
  refreshCopilotToken,
  ensureCopilotToken,
  fetchModels,
  supportsDirectAnthropicApi,
  supportsResponsesApi,
} from "../../../src/auth/copilot-token";

describe("Copilot Token - Network Functions", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    initState({ ...DEFAULT_CONFIG });
    getState().github_token = "test-gh-token";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("refreshCopilotToken sets token on success", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ token: "cp-token-123", refresh_in: 1800 }),
    })) as any;

    getState().copilot_token = "";
    getState().token_expires_at = 0;
    await refreshCopilotToken();

    expect(getState().copilot_token).toBe("cp-token-123");
    expect(getState().token_expires_at).toBeGreaterThan(0);
  });

  test("refreshCopilotToken uses the configured GHE API", async () => {
    let requestedUrl = "";
    getState().config.github_api_base_url = "https://api.msft.ghe.com";
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({ token: "ghe-cp-token", refresh_in: 1800 }),
      };
    }) as any;

    await refreshCopilotToken();
    expect(requestedUrl).toBe(
      "https://api.msft.ghe.com/copilot_internal/v2/token",
    );
  });

  test("refreshCopilotToken throws on failure", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    })) as any;

    getState().copilot_token = "";
    getState().token_expires_at = 0;
    await expect(refreshCopilotToken()).rejects.toThrow("Failed to get Copilot token");
  });

  test("refreshCopilotToken skips if token still valid", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; }) as any;

    getState().copilot_token = "valid-token";
    getState().token_expires_at = Date.now() / 1000 + 3600; // expires in 1 hour

    await refreshCopilotToken();
    expect(fetchCalled).toBe(false);
  });

  test("ensureCopilotToken refreshes when expired", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ token: "new-token", refresh_in: 1800 }),
    })) as any;

    getState().copilot_token = "";
    getState().token_expires_at = 0;
    await ensureCopilotToken();
    expect(getState().copilot_token).toBe("new-token");
  });

  test("ensureCopilotToken skips when valid", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; }) as any;

    getState().copilot_token = "existing";
    getState().token_expires_at = Date.now() / 1000 + 3600;
    await ensureCopilotToken();
    expect(fetchCalled).toBe(false);
  });

  test("fetchModels populates state.models", async () => {
    // First call for ensureCopilotToken, second for models
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) {
        // ensureCopilotToken
        return { ok: true, json: async () => ({ token: "t", refresh_in: 1800 }) };
      }
      // fetchModels
      return {
        ok: true,
        json: async () => ({ data: [{ id: "claude-opus-4.6", supported_endpoints: ["/v1/messages"] }] }),
      };
    }) as any;

    getState().copilot_token = "";
    getState().token_expires_at = 0;
    await fetchModels();
    expect(getState().models?.data).toHaveLength(1);
    expect(getState().models?.data[0].id).toBe("claude-opus-4.6");
  });

  test("fetchModels handles failure gracefully", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
    })) as any;

    getState().copilot_token = "valid";
    getState().token_expires_at = Date.now() / 1000 + 3600;
    await fetchModels();
    // Should not throw, models stays null
  });

  test("fetchModels uses the configured GHE Copilot API", async () => {
    let requestedUrl = "";
    getState().config.copilot_api_base_url = "https://copilot-api.msft.ghe.com";
    getState().copilot_token = "valid";
    getState().token_expires_at = Date.now() / 1000 + 3600;
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ data: [] }) };
    }) as any;

    await fetchModels();
    expect(requestedUrl).toBe("https://copilot-api.msft.ghe.com/models");
  });
});
