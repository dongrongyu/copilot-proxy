import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../..");
const FIXTURE_PATH = resolve(import.meta.dir, "../../fixtures/config-codex-flow.ts");

describe("Codex setup with different WSL and Windows versions", () => {
  let taskDir: string;
  let configPaths: string[];
  let originalFiles: Map<string, string>;

  beforeEach(() => {
    taskDir = mkdtempSync(join(tmpdir(), "cp-codex-setup-"));
    configPaths = ["wsl", "win"].map((platform) => join(taskDir, platform, ".codex", "config.toml"));
    originalFiles = new Map();
    for (const configPath of configPaths) {
      mkdirSync(dirname(configPath), { recursive: true });
      const catalogPath = join(dirname(configPath), "copilot-proxy-models.json");
      const toml = 'model = "gpt-6-astra"\nmodel_catalog_json = "copilot-proxy-models.json"\nfoo = "keep"\n';
      const catalog = JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }) + "\n";
      writeFileSync(configPath, toml, "utf-8");
      writeFileSync(catalogPath, catalog, "utf-8");
      originalFiles.set(configPath, toml);
      originalFiles.set(catalogPath, catalog);
    }
  });

  afterEach(() => {
    rmSync(taskDir, { recursive: true, force: true });
  });

  async function runSetup(flow: string, outcome: string) {
    const proc = Bun.spawn(["bun", "run", FIXTURE_PATH, flow, outcome, taskDir], {
      cwd: REPOSITORY_ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write("\n\n\n\n\n");
    proc.stdin.end();
    const stdout = proc.stdout.text();
    const stderr = proc.stderr.text();
    return { exitCode: await proc.exited, stdout: await stdout, stderr: await stderr };
  }

  for (const flow of ["cli", "portal"]) {
    test(`${flow} writes each target's compatible model metadata`, async () => {
      const result = await runSetup(flow, "success");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`CATALOG_TARGETS=${JSON.stringify(configPaths)}`);
      for (const [index, configPath] of configPaths.entries()) {
        const toml = readFileSync(configPath, "utf-8");
        const catalog = JSON.parse(readFileSync(join(dirname(configPath), "copilot-proxy-models.json"), "utf-8"));
        const model = catalog.models.find((entry: any) => entry.slug === "gpt-6.1-sol");
        expect(toml).toContain('model = "gpt-6.1-sol"');
        expect(toml).toContain('foo = "keep"');
        expect(model.context_window).toBe(1_050_000);
        expect(model.auto_compact_token_limit).toBe(900_000);
        if (index === 0) {
          expect(model.supports_reasoning_effort_updates).toBe(true);
        } else {
          expect(model.supports_parallel_tool_calls).toBe(true);
          expect(model).not.toHaveProperty("supports_reasoning_effort_updates");
        }
      }
    });

    test(`${flow} preserves both configurations if Windows catalog generation fails`, async () => {
      const result = await runSetup(flow, "failure");

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain("Windows catalog unavailable");
      expect(result.stdout).toContain(`CATALOG_TARGETS=${JSON.stringify(configPaths)}`);
      for (const [path, original] of originalFiles) {
        expect(readFileSync(path, "utf-8")).toBe(original);
      }
    });
  }
});
