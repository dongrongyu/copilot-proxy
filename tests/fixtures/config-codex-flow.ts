import { mock } from "bun:test";
import * as childProcess from "child_process";
import * as os from "os";
import { join } from "path";
import { initState, getState } from "../../src/auth/state";
import { DEFAULT_CONFIG } from "../../src/config/schema";
import * as catalog from "../../src/cli/codex-catalog";
import * as loader from "../../src/config/loader";
import * as copilot from "../../src/auth/copilot-token";

const [flow, outcome, taskDir] = process.argv.slice(2);
if ((flow !== "cli" && flow !== "portal")
  || (outcome !== "success" && outcome !== "failure")
  || !taskDir) {
  throw new Error("Expected fixture arguments: <cli|portal> <success|failure> <directory>");
}

const wslHome = join(taskDir, "wsl");
const winHome = join(taskDir, "win");
const windowsConfigPath = join(winHome, ".codex", "config.toml");
const targets: Array<string | undefined> = [];
const models = [{
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  supported_endpoints: ["/responses"],
  capabilities: {
    limits: { max_context_window_tokens: 1_050_000, max_prompt_tokens: 922_000 },
    supports: { reasoning_effort: ["high", "max"] },
  },
}];

const patchCatalog = catalog.patchCodexCatalogForCopilot;
mock.module("os", () => ({ ...os, homedir: () => wslHome }));
mock.module("child_process", () => ({ ...childProcess, execSync: () => winHome }));
mock.module("../../src/config/loader", () => ({
  ...loader,
  loadConfig: () => structuredClone(DEFAULT_CONFIG),
}));
mock.module("../../src/auth/github-token", () => ({
  getGitHubToken: () => "fixture-token",
}));
mock.module("../../src/auth/copilot-token", () => ({
  ...copilot,
  ensureCopilotToken: async () => {},
  fetchModels: async () => { getState().models = { data: models }; },
}));
mock.module("../../src/cli/codex-catalog", () => ({
  ...catalog,
  buildCodexCatalogForCopilot: (
    liveModels: typeof models,
    selectedModel?: string,
    configPath?: string,
  ) => {
    targets.push(configPath);
    if (configPath === windowsConfigPath && outcome === "failure") {
      throw new Error("Windows catalog unavailable");
    }
    const source = configPath === windowsConfigPath
      ? { models: [{ slug: "gpt-5.6-sol", supports_parallel_tool_calls: true }] }
      : { models: [{ slug: "gpt-6.1-sol", supports_reasoning_effort_updates: true }] };
    return patchCatalog(source, liveModels, selectedModel);
  },
}));

if (flow === "cli") {
  const { configCommand } = await import("../../src/cli/config");
  await configCommand("codex");
} else {
  initState(structuredClone(DEFAULT_CONFIG));
  getState().models = { data: models };
  const { applySetup } = await import("../../src/portal/api");
  const result = applySetup("codex", { model: "gpt-6.1-sol", where: "both" });
  console.log(`SETUP_RESULT=${JSON.stringify(result)}`);
  process.exitCode = result.ok ? 0 : 1;
}
console.log(`CATALOG_TARGETS=${JSON.stringify(targets)}`);
