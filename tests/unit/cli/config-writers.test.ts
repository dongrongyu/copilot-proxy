import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import {
  writeClaudeConfig,
  writeCodexConfig,
  writeGeminiConfig,
  buildCodexProxyToml,
} from "../../../src/cli/config";

describe("Config writers (non-interactive, portal-shared)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cp-writers-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("writeClaudeConfig", () => {
    test("creates settings.json with proxy env", () => {
      const p = join(dir, ".claude", "settings.json");
      const written = writeClaudeConfig("http://localhost:8989", "claude-opus-4.8[1m]", [p]);
      expect(written).toEqual([p]);
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://localhost:8989");
      expect(parsed.env.ANTHROPIC_MODEL).toBe("claude-opus-4.8[1m]");
    });

    test("preserves unrelated existing keys", () => {
      const p = join(dir, "settings.json");
      writeFileSync(p, JSON.stringify({ theme: "dark", env: { FOO: "bar" } }), "utf-8");
      writeClaudeConfig("http://localhost:8989", "claude-sonnet-4.6", [p]);
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      expect(parsed.theme).toBe("dark");
      expect(parsed.env.FOO).toBe("bar");
      expect(parsed.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4.6");
    });

    test("writes to multiple paths", () => {
      const a = join(dir, "a", "settings.json");
      const b = join(dir, "b", "settings.json");
      const written = writeClaudeConfig("http://x:1", "m", [a, b]);
      expect(written).toEqual([a, b]);
      expect(existsSync(a)).toBe(true);
      expect(existsSync(b)).toBe(true);
    });
  });

  describe("writeCodexConfig", () => {
    test("writes new config.toml verbatim", () => {
      const p = join(dir, ".codex", "config.toml");
      const toml = buildCodexProxyToml("http://localhost:8989", "gpt-5", null);
      writeCodexConfig(toml, [p]);
      const content = readFileSync(p, "utf-8");
      expect(content).toContain('base_url = "http://localhost:8989/v1"');
      expect(content).toContain('model = "gpt-5"');
    });

    test("merges into existing toml preserving unrelated sections", () => {
      const p = join(dir, "config.toml");
      writeFileSync(p, '[mcp_servers.foo]\ncommand = "bar"\n', "utf-8");
      const toml = buildCodexProxyToml("http://localhost:8989", "gpt-5", null);
      writeCodexConfig(toml, [p]);
      const content = readFileSync(p, "utf-8");
      expect(content).toContain("mcp_servers.foo");
      expect(content).toContain('model = "gpt-5"');
    });

    test("writes a generated model catalog next to config.toml", () => {
      const p = join(dir, ".codex", "config.toml");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(
        p,
        'model_context_window = 272000\nmodel_auto_compact_token_limit = 240000\nfoo = "keep"\n',
        "utf-8",
      );
      const toml = buildCodexProxyToml(
        "http://localhost:8989",
        "gpt-5.6-sol",
        ["max"],
        "copilot-proxy-models.json",
      );
      const catalog = {
        models: [{
          slug: "gpt-5.6-sol",
          context_window: 1_050_000,
          max_context_window: 1_050_000,
        }],
      };

      const written = writeCodexConfig(toml, [p], catalog);
      const catalogPath = join(dir, ".codex", "copilot-proxy-models.json");
      expect(written).toEqual([p, catalogPath]);
      expect(JSON.parse(readFileSync(catalogPath, "utf-8"))).toEqual(catalog);
      expect(readFileSync(p, "utf-8")).toContain(
        'model_catalog_json = "copilot-proxy-models.json"',
      );
      expect(readFileSync(p, "utf-8")).toContain('foo = "keep"');
      expect(readFileSync(p, "utf-8")).not.toContain("model_context_window");
      expect(readFileSync(p, "utf-8")).not.toContain("model_auto_compact_token_limit");
    });

    test("AOAI setup removes only the generated proxy catalog reference", () => {
      const generated = join(dir, "generated", "config.toml");
      mkdirSync(dirname(generated), { recursive: true });
      writeFileSync(
        generated,
        'model_catalog_json = "copilot-proxy-models.json"\nfoo = "keep"\n',
        "utf-8",
      );
      writeCodexConfig('model = "aoai-model"\n', [generated], null, true);
      const generatedContent = readFileSync(generated, "utf-8");
      expect(generatedContent).not.toContain("model_catalog_json");
      expect(generatedContent).toContain('foo = "keep"');

      const custom = join(dir, "custom", "config.toml");
      mkdirSync(dirname(custom), { recursive: true });
      writeFileSync(custom, 'model_catalog_json = "my-models.json"\n', "utf-8");
      writeCodexConfig('model = "aoai-model"\n', [custom], null, true);
      expect(readFileSync(custom, "utf-8")).toContain(
        'model_catalog_json = "my-models.json"',
      );
    });
  });

  describe("writeGeminiConfig", () => {
    test("writes .env and companion settings.json", () => {
      const envPath = join(dir, ".gemini", ".env");
      const written = writeGeminiConfig("http://localhost:8989", "gemini-2.5-pro", [envPath]);
      // returns both the .env and the settings.json next to it
      expect(written).toContain(envPath);
      expect(written.some((p) => p.endsWith("settings.json"))).toBe(true);
      const env = readFileSync(envPath, "utf-8");
      expect(env).toContain("GOOGLE_GEMINI_BASE_URL=http://localhost:8989");
      expect(env).toContain("GEMINI_MODEL=gemini-2.5-pro");
      const settings = JSON.parse(readFileSync(join(dir, ".gemini", "settings.json"), "utf-8"));
      expect(settings.security.auth.selectedType).toBe("gemini-api-key");
    });

    test("preserves an existing GEMINI_API_KEY", () => {
      const d = join(dir, ".gemini");
      mkdirSync(d, { recursive: true });
      const envPath = join(d, ".env");
      writeFileSync(envPath, "GEMINI_API_KEY=my-real-key\nOTHER=keep\n", "utf-8");
      writeGeminiConfig("http://localhost:8989", "gemini-2.5-flash", [envPath]);
      const env = readFileSync(envPath, "utf-8");
      expect(env).toContain("GEMINI_API_KEY=my-real-key");
      expect(env).toContain("OTHER=keep");
      expect(env).toContain("GEMINI_MODEL=gemini-2.5-flash");
    });
  });
});
