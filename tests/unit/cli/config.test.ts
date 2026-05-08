import { describe, expect, test } from "bun:test";
import {
  filterAndSortModels,
  buildClaudeEnv,
  mergeClaudeSettings,
  buildCodexProxyToml,
  buildCodexAoaiToml,
  mergeCodexToml,
  pickMaxReasoningEffort,
} from "../../../src/cli/config";

describe("Config Utilities", () => {
  describe("filterAndSortModels", () => {
    test("filters out accounts/ and text-embedding models", () => {
      const input = [
        "claude-opus-4.6",
        "accounts/msft/routers/abc",
        "text-embedding-3-small",
        "gpt-4o",
      ];
      const result = filterAndSortModels(input);
      expect(result).not.toContain("accounts/msft/routers/abc");
      expect(result).not.toContain("text-embedding-3-small");
      expect(result).toContain("claude-opus-4.6");
      expect(result).toContain("gpt-4o");
    });

    test("sorts claude models first", () => {
      const input = ["gpt-4o", "claude-sonnet-4", "gemini-2.5-pro", "claude-opus-4.6"];
      const result = filterAndSortModels(input);
      expect(result[0]).toBe("claude-opus-4.6");
      expect(result[1]).toBe("claude-sonnet-4");
      expect(result[2]).toBe("gemini-2.5-pro");
      expect(result[3]).toBe("gpt-4o");
    });

    test("handles empty input", () => {
      expect(filterAndSortModels([])).toEqual([]);
    });

    test("handles all filtered out", () => {
      const input = ["accounts/msft/routers/x", "text-embedding-ada-002"];
      expect(filterAndSortModels(input)).toEqual([]);
    });
  });

  describe("buildClaudeEnv", () => {
    test("builds correct env object", () => {
      const env = buildClaudeEnv("http://localhost:8989", "claude-opus-4.6");
      expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:8989");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("copilot-proxy");
      expect(env.ANTHROPIC_MODEL).toBe("claude-opus-4.6");
      expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-opus-4.6");
      expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-opus-4.6");
      expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-opus-4.6");
      expect(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1");
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
      expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
    });

    test("does not include ANTHROPIC_API_KEY", () => {
      const env = buildClaudeEnv("http://localhost:8989", "claude-opus-4.6");
      expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    });
  });

  describe("mergeClaudeSettings", () => {
    test("merges env into empty settings", () => {
      const env = { ANTHROPIC_BASE_URL: "http://localhost:8989" };
      const result = mergeClaudeSettings({}, env);
      expect(result.env.ANTHROPIC_BASE_URL).toBe("http://localhost:8989");
    });

    test("preserves existing env keys", () => {
      const existing = {
        env: { EXISTING_KEY: "keep_me", ANTHROPIC_BASE_URL: "old" },
      };
      const env = { ANTHROPIC_BASE_URL: "new" };
      const result = mergeClaudeSettings(existing, env);
      expect(result.env.EXISTING_KEY).toBe("keep_me");
      expect(result.env.ANTHROPIC_BASE_URL).toBe("new");
    });

    test("preserves non-env keys", () => {
      const existing = { env: {}, permissions: { allow: ["Bash(git:*)"] } };
      const env = { ANTHROPIC_BASE_URL: "http://localhost:8989" };
      const result = mergeClaudeSettings(existing, env);
      expect(result.permissions.allow).toEqual(["Bash(git:*)"]);
    });

    test("does not mutate original", () => {
      const existing = { env: { OLD: "value" } };
      const env = { NEW: "value" };
      mergeClaudeSettings(existing, env);
      expect(existing.env).not.toHaveProperty("NEW");
    });
  });

  describe("buildCodexProxyToml", () => {
    test("emits required keys and section (no reasoning_effort when unsupported)", () => {
      const toml = buildCodexProxyToml("http://localhost:8989", "gpt-4o");
      expect(toml).toContain(`model_provider = "copilot-proxy"`);
      expect(toml).toContain(`model = "gpt-4o"`);
      expect(toml).toContain(`approval_policy = "never"`);
      expect(toml).toContain(`sandbox_mode = "danger-full-access"`);
      expect(toml).toContain(`[model_providers.copilot-proxy]`);
      expect(toml).toContain(`base_url = "http://localhost:8989/v1"`);
      expect(toml).toContain(`wire_api = "responses"`);
      expect(toml).not.toContain("model_reasoning_effort");
      expect(toml).not.toContain("profile =");
      expect(toml).not.toContain("env_key");
    });

    test("uses max effort from supported list (gpt-5 → xhigh)", () => {
      const toml = buildCodexProxyToml("http://x", "gpt-5", [
        "low",
        "medium",
        "high",
        "xhigh",
      ]);
      expect(toml).toContain(`model_reasoning_effort = "xhigh"`);
    });

    test("uses max effort from supported list (claude-opus-4.6 → high)", () => {
      const toml = buildCodexProxyToml("http://x", "claude-opus-4.6", [
        "low",
        "medium",
        "high",
      ]);
      expect(toml).toContain(`model_reasoning_effort = "high"`);
    });

    test("uses pinned effort when API exposes only one (claude-opus-4.7-xhigh)", () => {
      const toml = buildCodexProxyToml("http://x", "claude-opus-4.7-xhigh", [
        "xhigh",
      ]);
      expect(toml).toContain(`model_reasoning_effort = "xhigh"`);
    });

    test("omits reasoning_effort line for empty list", () => {
      const toml = buildCodexProxyToml("http://x", "gpt-4o", []);
      expect(toml).not.toContain("model_reasoning_effort");
    });
  });

  describe("pickMaxReasoningEffort", () => {
    test("picks xhigh when present", () => {
      expect(pickMaxReasoningEffort(["low", "medium", "high", "xhigh"])).toBe(
        "xhigh",
      );
    });
    test("picks high when xhigh absent", () => {
      expect(pickMaxReasoningEffort(["low", "medium", "high"])).toBe("high");
    });
    test("returns null for empty/undefined/null", () => {
      expect(pickMaxReasoningEffort([])).toBeNull();
      expect(pickMaxReasoningEffort(undefined)).toBeNull();
      expect(pickMaxReasoningEffort(null)).toBeNull();
    });
    test("ignores unknown values", () => {
      expect(pickMaxReasoningEffort(["bogus"])).toBeNull();
    });
  });

  describe("buildCodexAoaiToml", () => {
    test("emits AOAI provider section with env_key and query_params", () => {
      const toml = buildCodexAoaiToml({
        baseUrl: "https://x.cognitiveservices.azure.com/openai",
        model: "gpt-5.3-codex",
        envKey: "AZURE_OPENAI_API_KEY",
      });
      expect(toml).toContain(`model_provider = "copilot-proxy"`);
      expect(toml).toContain(`model = "gpt-5.3-codex"`);
      expect(toml).toContain(`model_reasoning_effort = "xhigh"`);
      expect(toml).toContain(`[model_providers.copilot-proxy]`);
      expect(toml).toContain(`name = "AzureOpenAI"`);
      expect(toml).toContain(`base_url = "https://x.cognitiveservices.azure.com/openai"`);
      expect(toml).toContain(`env_key = "AZURE_OPENAI_API_KEY"`);
      expect(toml).toContain(`query_params = { api-version = "2025-04-01-preview" }`);
      expect(toml).toContain(`wire_api = "responses"`);
    });

    test("uses custom api-version when provided", () => {
      const toml = buildCodexAoaiToml({
        baseUrl: "https://x/openai",
        model: "m",
        envKey: "K",
        apiVersion: "2024-10-01-preview",
      });
      expect(toml).toContain(`api-version = "2024-10-01-preview"`);
    });
  });

  describe("mergeCodexToml", () => {
    test("preserves unrelated sections", () => {
      const existing = `foo = "bar"

[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp"]
`;
      const incoming = buildCodexProxyToml("http://localhost:8989", "gpt-5");
      const merged = mergeCodexToml(existing, incoming);
      expect(merged).toContain(`[mcp_servers.playwright]`);
      expect(merged).toContain(`command = "npx"`);
      expect(merged).toContain(`[model_providers.copilot-proxy]`);
      expect(merged).toContain(`model = "gpt-5"`);
    });

    test("replaces same-named section", () => {
      const existing = `[model_providers.copilot-proxy]
name = "Old"
base_url = "http://old"
wire_api = "responses"
`;
      const incoming = buildCodexProxyToml("http://localhost:8989", "gpt-5");
      const merged = mergeCodexToml(existing, incoming);
      expect(merged).not.toContain(`base_url = "http://old"`);
      expect(merged).toContain(`base_url = "http://localhost:8989/v1"`);
      // only one [model_providers.copilot-proxy] section
      const occurrences = merged.split(`[model_providers.copilot-proxy]`).length - 1;
      expect(occurrences).toBe(1);
    });

    test("overrides root-level keys from incoming", () => {
      const existing = `model = "old-model"
model_provider = "old"

[other.section]
key = "value"
`;
      const incoming = buildCodexProxyToml("http://localhost:8989", "gpt-5");
      const merged = mergeCodexToml(existing, incoming);
      expect(merged).toContain(`model = "gpt-5"`);
      expect(merged).not.toContain(`model = "old-model"`);
      expect(merged).toContain(`model_provider = "copilot-proxy"`);
      expect(merged).toContain(`[other.section]`);
    });

    test("aoai incoming replaces proxy section", () => {
      const existing = buildCodexProxyToml("http://localhost:8989", "gpt-5");
      const incoming = buildCodexAoaiToml({
        baseUrl: "https://x/openai",
        model: "gpt-5.3-codex",
        envKey: "AZURE_OPENAI_API_KEY",
      });
      const merged = mergeCodexToml(existing, incoming);
      expect(merged).toContain(`name = "AzureOpenAI"`);
      expect(merged).not.toContain(`name = "Copilot Proxy"`);
      expect(merged).toContain(`env_key = "AZURE_OPENAI_API_KEY"`);
      expect(merged).toContain(`model_reasoning_effort = "xhigh"`);
    });
  });
});
