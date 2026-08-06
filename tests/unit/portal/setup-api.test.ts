import { describe, expect, test, beforeEach } from "bun:test";
import { initState, getState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import { setupPreview } from "../../../src/portal/api";

// A representative slice of the Copilot /models catalog: Claude ids (which
// expose /v1/messages), live GPT-5 ids (gpt-5.6-sol is /responses-only), a dead
// legacy GPT id (empty supported_endpoints), plus a Gemini and a grok id that
// Claude Code cannot target. setupPreview("claude", …) reads getState().models,
// so we populate it directly — no network, no disk.
const CATALOG = [
  { id: "claude-opus-4.8", vendor: "Anthropic", supported_endpoints: ["/v1/messages", "/chat/completions"], capabilities: { limits: { max_context_window_tokens: 1000000 } } },
  { id: "claude-sonnet-4.6", vendor: "Anthropic", supported_endpoints: ["/v1/messages", "/chat/completions"], capabilities: { limits: { max_context_window_tokens: 200000 } } },
  { id: "claude-haiku-4.5", vendor: "Anthropic", supported_endpoints: ["/v1/messages"], capabilities: { limits: { max_context_window_tokens: 200000 } } },
  { id: "gpt-5.6-sol", vendor: "OpenAI", supported_endpoints: ["/responses"], capabilities: { limits: { max_context_window_tokens: 1050000 } } },
  { id: "gpt-5.4", vendor: "OpenAI", supported_endpoints: ["/chat/completions", "/responses"], capabilities: { limits: { max_context_window_tokens: 128000 } } },
  { id: "gpt-4o", vendor: "OpenAI", supported_endpoints: [], capabilities: { limits: { max_context_window_tokens: 128000 } } },
  { id: "gemini-3.1-pro-preview", vendor: "Google", supported_endpoints: ["/chat/completions"], capabilities: { limits: { max_context_window_tokens: 1000000 } } },
  { id: "grok-code-fast-1", vendor: "xAI", supported_endpoints: ["/chat/completions"], capabilities: { limits: { max_context_window_tokens: 256000 } } },
];

describe("portal Client Setup — claude target model list", () => {
  beforeEach(() => {
    initState({ ...DEFAULT_CONFIG });
    getState().models = { data: CATALOG as any };
  });

  test("offers both Claude and GPT models Claude Code can run on", () => {
    const ids = setupPreview("claude", {}).models.map((m) => m.id);
    expect(ids).toContain("claude-opus-4.8");
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).toContain("gpt-5.4");
  });

  test("excludes Gemini, grok, and dead legacy GPT (empty endpoints)", () => {
    const ids = setupPreview("claude", {}).models.map((m) => m.id);
    expect(ids).not.toContain("gemini-3.1-pro-preview");
    expect(ids).not.toContain("grok-code-fast-1");
    expect(ids).not.toContain("gpt-4o");
  });

  test("defaults (choices[0]) to the strongest Opus", () => {
    const preview = setupPreview("claude", {});
    expect(preview.models[0]!.id).toBe("claude-opus-4.8");
    expect(preview.selectedModel).toBe("claude-opus-4.8");
  });

  test("tags a 1M-context GPT model with [1m] in its display name", () => {
    const sol = setupPreview("claude", {}).models.find((m) => m.id === "gpt-5.6-sol");
    expect(sol!.display).toBe("gpt-5.6-sol[1m]");
  });
});
