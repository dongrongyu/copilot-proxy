/**
 * E2E: config claude command with --output to temp file.
 * Verifies the config command writes correct settings without touching real config.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Config Claude E2E", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "copilot-proxy-config-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("writes correct settings to output path", async () => {
    const outputPath = join(tempDir, "settings.json");

    // Run config command with piped input (select option 1) and --output
    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", "config", "claude", "--output", outputPath],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    );

    // Send selection "1" + enter
    proc.stdin.write("1\n");
    proc.stdin.end();

    await proc.exited;

    // Read and verify the written file
    const content = readFileSync(outputPath, "utf-8");
    const settings = JSON.parse(content);

    expect(settings.env).toBeDefined();
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://localhost:8989");
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("copilot-proxy");
    expect(settings.env.ANTHROPIC_MODEL).toBeDefined();
    expect(settings.env.ANTHROPIC_MODEL).not.toBe("");
    expect(settings.env.ANTHROPIC_SMALL_FAST_MODEL).toBe(settings.env.ANTHROPIC_MODEL);
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(settings.env.ANTHROPIC_MODEL);
    expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(settings.env.ANTHROPIC_MODEL);
    expect(settings.env.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe("1");
    expect(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
    // Should NOT have API_KEY
    expect(settings.env.ANTHROPIC_API_KEY).toBeUndefined();
  }, 30_000);

  test("preserves existing settings when merging", async () => {
    const outputPath = join(tempDir, "settings-merge.json");
    // Write existing settings
    const existing = {
      env: { CUSTOM_VAR: "keep_this" },
      permissions: { allow: ["Bash(git:*)"] },
    };
    Bun.write(outputPath, JSON.stringify(existing, null, 2));

    const proc = Bun.spawn(
      ["bun", "run", "src/index.ts", "config", "claude", "--output", outputPath],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    );

    proc.stdin.write("\n1\n");   // Update? [Y/n] -> default Y; model -> 1
    proc.stdin.end();

    await proc.exited;

    const settings = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(settings.env.CUSTOM_VAR).toBe("keep_this");
    expect(settings.permissions.allow).toEqual(["Bash(git:*)"]);
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://localhost:8989");
  }, 30_000);
});
