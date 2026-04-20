import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createInterface } from "readline";
import { execSync } from "child_process";
import { loadConfig } from "../config/loader";
import { initState, getState } from "../auth/state";
import { getGitHubToken } from "../auth/github-token";
import { ensureCopilotToken, fetchModels } from "../auth/copilot-token";
import { reverseModelName } from "../proxy/model-mapping";

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Detect Windows user home from WSL.
 * Tries wslvar+wslpath first, falls back to cmd.exe+wslpath.
 * Returns null if not in WSL or tools unavailable.
 */
function getWindowsHomePath(): string | null {
  // Try wslvar (wslu package)
  try {
    const winProfile = execSync('wslpath "$(wslvar USERPROFILE)" 2>/dev/null', {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (winProfile && existsSync(winProfile)) return winProfile;
  } catch {}

  // Fallback: cmd.exe
  try {
    const winPath = execSync('cmd.exe /c "echo %USERPROFILE%" 2>/dev/null', {
      encoding: "utf-8",
      timeout: 5000,
    }).trim().replace(/\r/g, "");
    if (winPath) {
      const wslPath = execSync(`wslpath "${winPath}" 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      if (wslPath && existsSync(wslPath)) return wslPath;
    }
  } catch {}

  return null;
}

/**
 * Filter and sort model names for display.
 * Removes non-chat models, sorts Claude first.
 */
export function filterAndSortModels(modelIds: string[]): string[] {
  return modelIds
    .filter((id) =>
      !id.startsWith("accounts/") &&
      !id.startsWith("text-embedding")
    )
    .sort((a, b) => {
      const aIsClaude = a.startsWith("claude-");
      const bIsClaude = b.startsWith("claude-");
      if (aIsClaude && !bIsClaude) return -1;
      if (!aIsClaude && bIsClaude) return 1;
      return a.localeCompare(b);
    });
}

/**
 * Build the Claude Code settings env object.
 */
export function buildClaudeEnv(baseUrl: string, model: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: "copilot-proxy",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
  };
}

/**
 * Merge new env into existing settings, preserving other keys.
 */
export function mergeClaudeSettings(existing: any, env: Record<string, string>): any {
  const settings = { ...existing };
  settings.env = { ...(existing.env ?? {}), ...env };
  return settings;
}

export async function configCommand(target: string, options?: { output?: string }) {
  const config = loadConfig();
  const baseUrl = `http://${config.address}:${config.port}`;

  switch (target) {
    case "claude":
      await configClaude(baseUrl, options?.output);
      break;
    case "codex":
      await configCodex(baseUrl, options?.output);
      break;
    case "gemini":
      configGemini(baseUrl);
      break;
    case "all":
      await configClaude(baseUrl, options?.output);
      await configCodex(baseUrl, options?.output);
      configGemini(baseUrl);
      break;
    default:
      console.error(`Unknown target: ${target}. Use: claude, codex, gemini, or all`);
      process.exit(1);
  }
}

// ============================================================
// Codex TOML builders + merge (pure functions, exported for UT)
// ============================================================

const CODEX_PROVIDER_KEY = "copilot-proxy";
const AOAI_DEFAULT_API_VERSION = "2025-04-01-preview";

/**
 * Build Codex TOML for Copilot Proxy mode.
 */
export function buildCodexProxyToml(baseUrl: string, model: string): string {
  return `approval_policy = "never"
sandbox_mode = "danger-full-access"
model_provider = "${CODEX_PROVIDER_KEY}"
model = "${model}"

[model_providers.${CODEX_PROVIDER_KEY}]
name = "Copilot Proxy"
base_url = "${baseUrl}/v1"
wire_api = "responses"
`;
}

export interface CodexAoaiOptions {
  baseUrl: string;
  model: string;
  envKey: string;
  apiVersion?: string;
}

/**
 * Build Codex TOML for Azure OpenAI mode.
 */
export function buildCodexAoaiToml(opts: CodexAoaiOptions): string {
  const apiVersion = opts.apiVersion ?? AOAI_DEFAULT_API_VERSION;
  return `approval_policy = "never"
sandbox_mode = "danger-full-access"
model_provider = "${CODEX_PROVIDER_KEY}"
model = "${opts.model}"
model_reasoning_effort = "xhigh"

[model_providers.${CODEX_PROVIDER_KEY}]
name = "AzureOpenAI"
base_url = "${opts.baseUrl}"
env_key = "${opts.envKey}"
query_params = { api-version = "${apiVersion}" }
wire_api = "responses"
`;
}

interface TomlBlocks {
  root: string[];
  sections: Map<string, string[]>;
  order: string[];
}

function parseTomlBlocks(text: string): TomlBlocks {
  const lines = text.split(/\r?\n/);
  const root: string[] = [];
  const sections = new Map<string, string[]>();
  const order: string[] = [];
  let current: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (current !== null) sections.set(current, currentLines);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      flush();
      current = trimmed;
      currentLines = [line];
      if (!order.includes(current)) order.push(current);
    } else if (current === null) {
      root.push(line);
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return { root, sections, order };
}

function serializeTomlBlocks(blocks: TomlBlocks): string {
  const out: string[] = [];
  for (const line of blocks.root) out.push(line);
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();

  for (const key of blocks.order) {
    const lines = blocks.sections.get(key);
    if (!lines) continue;
    if (out.length > 0) out.push("");
    for (const l of lines) {
      if (l.trim() === "" && out.length > 0 && out[out.length - 1]!.trim() === "") continue;
      out.push(l);
    }
    while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  }

  return out.join("\n") + "\n";
}

/**
 * Merge incoming TOML into existing TOML. Root keys and sections present in
 * `incoming` override same-named entries in `existing`. Other existing
 * sections/keys are preserved.
 */
export function mergeCodexToml(existing: string, incoming: string): string {
  const ex = parseTomlBlocks(existing);
  const inc = parseTomlBlocks(incoming);

  const rootKeyRegex = /^\s*([A-Za-z0-9_-]+)\s*=/;
  const incomingRootKeys = new Set<string>();
  for (const line of inc.root) {
    const m = line.match(rootKeyRegex);
    if (m && m[1]) incomingRootKeys.add(m[1]);
  }

  const mergedRoot: string[] = [];
  for (const line of ex.root) {
    const m = line.match(rootKeyRegex);
    if (m && m[1] && incomingRootKeys.has(m[1])) continue;
    mergedRoot.push(line);
  }
  const incomingRootLines = [...inc.root];
  while (incomingRootLines.length > 0 && incomingRootLines[0]!.trim() === "") {
    incomingRootLines.shift();
  }
  while (mergedRoot.length > 0 && mergedRoot[mergedRoot.length - 1]!.trim() === "") {
    mergedRoot.pop();
  }
  if (mergedRoot.length > 0 && incomingRootLines.length > 0) mergedRoot.push("");
  for (const l of incomingRootLines) mergedRoot.push(l);

  const mergedSections = new Map<string, string[]>();
  const mergedOrder: string[] = [];

  for (const key of ex.order) {
    if (inc.sections.has(key)) continue;
    mergedSections.set(key, ex.sections.get(key)!);
    mergedOrder.push(key);
  }
  for (const key of inc.order) {
    mergedSections.set(key, inc.sections.get(key)!);
    if (!mergedOrder.includes(key)) mergedOrder.push(key);
  }

  return serializeTomlBlocks({
    root: mergedRoot,
    sections: mergedSections,
    order: mergedOrder,
  });
}

async function configClaude(baseUrl: string, outputPath?: string) {
  // Determine target paths
  const settingsPaths: string[] = [];

  if (outputPath) {
    settingsPaths.push(outputPath);
  } else {
    const wslPath = join(homedir(), ".claude", "settings.json");
    const winHome = getWindowsHomePath();
    const winPath = winHome ? join(winHome, ".claude", "settings.json") : null;

    if (winPath) {
      console.log("\nWhere to configure Claude Code?\n");
      console.log("  1) WSL only    (" + wslPath + ")");
      console.log("  2) Windows only (" + winPath + ")");
      console.log("  3) Both");
      const platformChoice = await prompt("\nChoice [3]: ");
      if (platformChoice === "1") {
        settingsPaths.push(wslPath);
      } else if (platformChoice === "2") {
        settingsPaths.push(winPath);
      } else {
        settingsPaths.push(wslPath, winPath);
      }
    } else {
      settingsPaths.push(wslPath);
    }
  }

  // Show targets and confirm existing files up front
  console.log("\nTarget location(s):");
  for (const p of settingsPaths) {
    console.log(`  ${p} ${existsSync(p) ? "(exists)" : "(new)"}`);
  }

  const pathsToWrite: string[] = [];
  for (const p of settingsPaths) {
    if (existsSync(p)) {
      const ans = (await prompt(`\n[Config] ${p} already exists. Update? [Y/n]: `)).toLowerCase();
      if (ans === "n" || ans === "no") {
        console.log(`[Config] Skipped: ${p}`);
        continue;
      }
    }
    pathsToWrite.push(p);
  }

  if (pathsToWrite.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  // Fetch available models from Copilot API
  const config = loadConfig();
  const state = initState(config);
  state.github_token = getGitHubToken();
  await ensureCopilotToken();
  await fetchModels();

  const modelList = getState().models?.data ?? [];
  const modelNames = filterAndSortModels(modelList.map((m: any) => m.id));

  if (modelNames.length === 0) {
    console.error("Failed to fetch models from Copilot API. Please run 'copilot-proxy login' first.");
    process.exit(1);
  }

  console.log("\nAvailable Claude models from Copilot API:\n");
  // For Claude Code config, only show Claude models
  const claudeModels = modelNames.filter((id: string) => id.startsWith("claude-"));

  if (claudeModels.length === 0) {
    console.error("No Claude models found. Please check your Copilot subscription.");
    process.exit(1);
  }

  for (let i = 0; i < claudeModels.length; i++) {
    const display = reverseModelName(claudeModels[i]!);
    console.log(`  ${i + 1}) ${display}`);
  }

  const choice = await prompt(`\nSelect model [1]: `);
  let selectedModel: string;

  const idx = parseInt(choice, 10);
  if (choice === "" || idx === 1) {
    selectedModel = claudeModels[0]!;
  } else if (idx >= 1 && idx <= claudeModels.length) {
    selectedModel = claudeModels[idx - 1]!;
  } else {
    console.log("Invalid choice, using first model.");
    selectedModel = claudeModels[0]!;
  }

  console.log(`\nUsing model: ${reverseModelName(selectedModel)}`);

  const claudeModel = reverseModelName(selectedModel);
  const env = buildClaudeEnv(baseUrl, claudeModel);

  for (const settingsPath of pathsToWrite) {
    const dir = dirname(settingsPath);
    mkdirSync(dir, { recursive: true });

    let settings: any = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      } catch {}
    }

    const merged = mergeClaudeSettings(settings, env);

    writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    console.log(`\n[Config] Written: ${settingsPath}`);
  }

  console.log(`\n  ANTHROPIC_BASE_URL=${baseUrl}`);
  console.log(`  Model=${claudeModel}`);
}

async function configCodex(baseUrl: string, outputPath?: string) {
  console.log("\nConfigure Codex CLI — select mode:\n");
  console.log("  1) Copilot Proxy  (route Codex through this proxy)");
  console.log("  2) Azure OpenAI   (direct AOAI)");
  const modeChoice = await prompt("\nChoice [1]: ");
  const mode = modeChoice === "2" ? "aoai" : "proxy";

  // Determine target paths
  const configPaths: string[] = [];
  if (outputPath) {
    configPaths.push(outputPath);
  } else {
    const wslPath = join(homedir(), ".codex", "config.toml");
    const winHome = getWindowsHomePath();
    const winPath = winHome ? join(winHome, ".codex", "config.toml") : null;

    if (winPath) {
      console.log("\nWhere to configure Codex CLI?\n");
      console.log("  1) WSL only    (" + wslPath + ")");
      console.log("  2) Windows only (" + winPath + ")");
      console.log("  3) Both");
      const platformChoice = await prompt("\nChoice [3]: ");
      if (platformChoice === "1") configPaths.push(wslPath);
      else if (platformChoice === "2") configPaths.push(winPath);
      else configPaths.push(wslPath, winPath);
    } else {
      configPaths.push(wslPath);
    }
  }

  // Show targets and confirm existing files up front
  console.log("\nTarget location(s):");
  for (const p of configPaths) {
    console.log(`  ${p} ${existsSync(p) ? "(exists)" : "(new)"}`);
  }

  const pathsToWrite: string[] = [];
  for (const p of configPaths) {
    if (existsSync(p)) {
      const ans = (await prompt(`\n[Config] ${p} already exists. Update? [Y/n]: `)).toLowerCase();
      if (ans === "n" || ans === "no") {
        console.log(`[Config] Skipped: ${p}`);
        continue;
      }
    }
    pathsToWrite.push(p);
  }

  if (pathsToWrite.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  let tomlContent: string;
  let envHint: { name: string; value?: string } | null = null;

  if (mode === "proxy") {
    // Fetch models from Copilot API
    const config = loadConfig();
    const state = initState(config);
    state.github_token = getGitHubToken();
    await ensureCopilotToken();
    await fetchModels();

    const modelList = getState().models?.data ?? [];
    const modelNames = filterAndSortModels(modelList.map((m: any) => m.id));

    if (modelNames.length === 0) {
      console.error("Failed to fetch models from Copilot API. Please run 'copilot-proxy login' first.");
      process.exit(1);
    }

    console.log("\nAvailable models:\n");
    for (let i = 0; i < modelNames.length; i++) {
      console.log(`  ${i + 1}) ${modelNames[i]}`);
    }

    const choice = await prompt(`\nSelect model [1]: `);
    const idx = parseInt(choice, 10);
    let selectedModel: string;
    if (choice === "" || idx === 1) {
      selectedModel = modelNames[0]!;
    } else if (idx >= 1 && idx <= modelNames.length) {
      selectedModel = modelNames[idx - 1]!;
    } else {
      console.log("Invalid choice, using first model.");
      selectedModel = modelNames[0]!;
    }

    console.log(`\nUsing model: ${selectedModel}`);
    tomlContent = buildCodexProxyToml(baseUrl, selectedModel);
  } else {
    // AOAI
    const baseUrlInput = await prompt("Base URL (e.g. https://xxx.cognitiveservices.azure.com/openai): ");
    const model = await prompt("Model [gpt-5.3-codex]: ");
    const envKey = await prompt("Env var name for API key [AZURE_OPENAI_API_KEY]: ");
    const aoaiOpts: CodexAoaiOptions = {
      baseUrl: baseUrlInput.trim(),
      model: (model.trim() || "gpt-5.3-codex"),
      envKey: (envKey.trim() || "AZURE_OPENAI_API_KEY"),
    };
    if (!aoaiOpts.baseUrl) {
      console.error("Base URL is required.");
      process.exit(1);
    }
    tomlContent = buildCodexAoaiToml(aoaiOpts);
    envHint = { name: aoaiOpts.envKey };
  }

  for (const configPath of pathsToWrite) {
    const dir = dirname(configPath);
    mkdirSync(dir, { recursive: true });

    let existing = "";
    if (existsSync(configPath)) {
      try { existing = readFileSync(configPath, "utf-8"); } catch {}
    }
    const merged = existing ? mergeCodexToml(existing, tomlContent) : tomlContent;
    writeFileSync(configPath, merged, "utf-8");
    console.log(`\n[Config] Written: ${configPath}`);
  }

  if (mode === "proxy") {
    console.log("\nNext steps:");
    console.log("  codex");
  } else if (envHint) {
    console.log("\nNext steps — set the API key as a user-level environment variable:");
    console.log("\n  WSL / Linux / macOS (persisted to ~/.bashrc):");
    console.log(`    echo 'export ${envHint.name}="<your-key>"' >> ~/.bashrc && source ~/.bashrc`);
    console.log("\n  Windows (PowerShell, user-level):");
    console.log(`    [Environment]::SetEnvironmentVariable("${envHint.name}", "<your-key>", "User")`);
    console.log("\n  Then:");
    console.log("    codex");
  }
}

function configGemini(baseUrl: string) {
  console.log(`[Config] Gemini CLI configuration:`);
  console.log(`  Set environment variables:`);
  console.log(`  export GEMINI_API_BASE_URL=${baseUrl}/v1`);
  console.log(`  export GEMINI_API_KEY=copilot-proxy`);
  console.log(`\n  Or add to your shell profile (~/.bashrc or ~/.zshrc).`);
}
