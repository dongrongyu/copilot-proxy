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

// Line-buffered stdin reader. A per-call readline.Interface loses buffered
// data on close(); a shared one throws ERR_USE_AFTER_CLOSE once stdin hits
// EOF (common with piped input). Instead, attach a single `line` listener,
// queue incoming lines, and hand them to pending prompt() calls. After EOF
// remaining prompts resolve with "" (accept defaults) instead of crashing.
let _rl: ReturnType<typeof createInterface> | null = null;
const _lineQueue: string[] = [];
const _waiters: Array<(value: string) => void> = [];
let _stdinEnded = false;

function initReadline() {
  if (_rl) return;
  _rl = createInterface({ input: process.stdin, output: process.stdout });
  _rl.on("line", (line) => {
    const trimmed = line.trim();
    const w = _waiters.shift();
    if (w) w(trimmed);
    else _lineQueue.push(trimmed);
  });
  _rl.on("close", () => {
    _stdinEnded = true;
    while (_waiters.length > 0) _waiters.shift()!("");
  });
}

export function closePrompt() {
  if (_rl) { _rl.close(); _rl = null; }
}

function prompt(question: string): Promise<string> {
  initReadline();
  process.stdout.write(question);
  return new Promise((resolve) => {
    if (_lineQueue.length > 0) resolve(_lineQueue.shift()!);
    else if (_stdinEnded) resolve("");
    else _waiters.push(resolve);
  });
}

/**
 * Detect Windows user home from WSL.
 * Tries wslvar+wslpath first, falls back to cmd.exe+wslpath.
 * Returns null if not in WSL or tools unavailable.
 *
 * All stderr is suppressed (`2>/dev/null` on the whole shell command, not just
 * the outer call) so missing tools like `wslvar` (wslu package) don't leak
 * errors to the user's terminal.
 *
 * Resolved paths are validated as absolute and existing — `wslpath ""` can
 * resolve to `"."` on some setups, which would otherwise be treated as a valid
 * home directory and produce relative `.claude/settings.json` paths.
 */
function getWindowsHomePath(): string | null {
  const isValidHome = (p: string): boolean =>
    !!p && p.startsWith("/") && existsSync(p);

  // Try wslvar (wslu package). Suppress stderr for the whole pipeline so
  // "wslvar: not found" doesn't leak to the user.
  try {
    const winProfile = execSync(
      'sh -c \'wslpath "$(wslvar USERPROFILE)"\' 2>/dev/null',
      { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (isValidHome(winProfile)) return winProfile;
  } catch {}

  // Fallback: cmd.exe (bundled with Windows; available in any WSL distro
  // with WSLInterop enabled). If cmd.exe isn't on PATH (e.g. stripped under
  // systemd user services), try the well-known System32 location directly.
  const cmdCandidates = ["cmd.exe", "/mnt/c/Windows/System32/cmd.exe"];
  for (const cmd of cmdCandidates) {
    try {
      const winPath = execSync(`${cmd} /c "echo %USERPROFILE%"`, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().replace(/\r/g, "");
      // Guard against empty / unresolved variables (e.g. literal "%USERPROFILE%").
      if (!winPath || winPath.includes("%") || !/^[A-Za-z]:\\/.test(winPath)) {
        continue;
      }
      const wslPath = execSync(`wslpath "${winPath}"`, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (isValidHome(wslPath)) return wslPath;
    } catch {}
  }

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

  try {
    switch (target) {
      case "claude":
        await configClaude(baseUrl, options?.output);
        break;
      case "codex":
        await configCodex(baseUrl, options?.output);
        break;
      case "gemini":
        await configGemini(baseUrl, options?.output);
        break;
      case "all":
        await configClaude(baseUrl, options?.output);
        await configCodex(baseUrl, options?.output);
        await configGemini(baseUrl, options?.output);
        break;
      default:
        console.error(`Unknown target: ${target}. Use: claude, codex, gemini, or all`);
        process.exit(1);
    }
  } finally {
    closePrompt();
  }
}

// ============================================================
// Codex TOML builders + merge (pure functions, exported for UT)
// ============================================================

const CODEX_PROVIDER_KEY = "copilot-proxy";
const AOAI_DEFAULT_API_VERSION = "2025-04-01-preview";

// Reasoning efforts ordered strongest → weakest. Whatever the Copilot
// `/models` endpoint advertises as supported, we pick the first one that
// appears in this list.
const EFFORT_PRIORITY = ["xhigh", "high", "medium", "low", "minimal", "none"];

/**
 * Pick the strongest reasoning effort from a `supported` array (as advertised
 * by Copilot's `capabilities.supports.reasoning_effort`). Returns null when
 * the model doesn't expose a reasoning_effort capability.
 */
export function pickMaxReasoningEffort(supported?: string[] | null): string | null {
  if (!supported || supported.length === 0) return null;
  for (const e of EFFORT_PRIORITY) {
    if (supported.includes(e)) return e;
  }
  return null;
}

/**
 * Build Codex TOML for Copilot Proxy mode.
 *
 * `supportedEfforts` is the model's `capabilities.supports.reasoning_effort`
 * array from the Copilot `/models` endpoint. The strongest entry is written
 * as `model_reasoning_effort`. If the model doesn't advertise any reasoning
 * efforts, that line is omitted entirely.
 */
export function buildCodexProxyToml(
  baseUrl: string,
  model: string,
  supportedEfforts?: string[] | null,
): string {
  const effort = pickMaxReasoningEffort(supportedEfforts);
  const effortLine = effort ? `model_reasoning_effort = "${effort}"\n` : "";
  return `approval_policy = "never"
sandbox_mode = "danger-full-access"
model_provider = "${CODEX_PROVIDER_KEY}"
model = "${model}"
${effortLine}
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
    const modelObj = modelList.find((m: any) => m.id === selectedModel);
    const supportedEfforts: string[] | undefined = (modelObj as any)
      ?.capabilities?.supports?.reasoning_effort;
    tomlContent = buildCodexProxyToml(baseUrl, selectedModel, supportedEfforts);
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

async function configGemini(baseUrl: string, outputPath?: string): Promise<void> {
  // Determine target .env paths
  const envPaths: string[] = [];
  if (outputPath) {
    envPaths.push(outputPath);
  } else {
    const wslPath = join(homedir(), ".gemini", ".env");
    const winHome = getWindowsHomePath();
    const winPath = winHome ? join(winHome, ".gemini", ".env") : null;

    if (winPath) {
      console.log("\nWhere to configure Gemini CLI?\n");
      console.log("  1) WSL only    (" + wslPath + ")");
      console.log("  2) Windows only (" + winPath + ")");
      console.log("  3) Both");
      const platformChoice = await prompt("\nChoice [3]: ");
      if (platformChoice === "1") envPaths.push(wslPath);
      else if (platformChoice === "2") envPaths.push(winPath);
      else envPaths.push(wslPath, winPath);
    } else {
      envPaths.push(wslPath);
    }
  }

  // Show targets + confirm existing files
  console.log("\nTarget location(s):");
  for (const p of envPaths) {
    console.log(`  ${p} ${existsSync(p) ? "(exists)" : "(new)"}`);
  }

  const pathsToWrite: string[] = [];
  for (const p of envPaths) {
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

  // Fetch models
  const config = loadConfig();
  const state = initState(config);
  state.github_token = getGitHubToken();
  await ensureCopilotToken();
  await fetchModels();

  const modelList = getState().models?.data ?? [];
  const modelNames = filterAndSortModels(modelList.map((m: any) => m.id));
  const geminiModels = modelNames.filter((id: string) => id.toLowerCase().startsWith("gemini-"));

  if (geminiModels.length === 0) {
    console.error("No Gemini models found in Copilot API. Please check your subscription.");
    process.exit(1);
  }

  console.log("\nAvailable Gemini models from Copilot API:\n");
  for (let i = 0; i < geminiModels.length; i++) {
    console.log(`  ${i + 1}) ${geminiModels[i]}`);
  }

  const choice = await prompt(`\nSelect model [1]: `);
  let selectedModel: string;
  const idx = parseInt(choice, 10);
  if (choice === "" || idx === 1) {
    selectedModel = geminiModels[0]!;
  } else if (idx >= 1 && idx <= geminiModels.length) {
    selectedModel = geminiModels[idx - 1]!;
  } else {
    console.log("Invalid choice, using first model.");
    selectedModel = geminiModels[0]!;
  }

  console.log(`\nUsing model: ${selectedModel}`);

  const envVars = buildGeminiEnv(baseUrl, selectedModel);

  for (const envFilePath of pathsToWrite) {
    const dir = dirname(envFilePath);
    mkdirSync(dir, { recursive: true });

    let existingEnv = "";
    if (existsSync(envFilePath)) {
      try { existingEnv = readFileSync(envFilePath, "utf-8"); } catch {}
    }
    // Preserve existing GEMINI_API_KEY if present, otherwise use our placeholder.
    const preserveKeys = new Set(["GEMINI_API_KEY"]);
    const merged = mergeEnvFile(existingEnv, envVars, preserveKeys);
    writeFileSync(envFilePath, merged, "utf-8");
    console.log(`\n[Config] Written: ${envFilePath}`);

    // Also write settings.json to skip auth prompt on first Gemini CLI launch.
    const settingsPath = join(dir, "settings.json");
    let existingSettings: any = {};
    if (existsSync(settingsPath)) {
      try { existingSettings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
    }
    const mergedSettings = mergeGeminiSettings(existingSettings);
    writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2) + "\n", "utf-8");
    console.log(`[Config] Written: ${settingsPath}`);
  }

  console.log(`\n  GOOGLE_GEMINI_BASE_URL=${baseUrl}`);
  console.log(`  Model=${selectedModel}`);
  console.log(`\nNext steps:`);
  console.log(`  gemini`);
}

/**
 * Build the Gemini CLI .env variables.
 * GEMINI_API_KEY uses a placeholder ("github-copilot") — the proxy doesn't
 * validate it, but the Gemini CLI refuses to start without one.
 */
export function buildGeminiEnv(baseUrl: string, model: string): Record<string, string> {
  return {
    // The @google/genai SDK prepends "/v1beta/models/..." to this base URL,
    // so we must NOT include "/v1beta" here (would produce "/v1beta/v1beta/...").
    GOOGLE_GEMINI_BASE_URL: baseUrl,
    GEMINI_API_KEY: "github-copilot",
    GEMINI_MODEL: model,
    GEMINI_TELEMETRY_ENABLED: "false",
  };
}

/**
 * Merge new env vars into existing .env file content while preserving other
 * lines. Keys in `preserveKeys` keep their existing value if present.
 */
export function mergeEnvFile(
  existing: string,
  vars: Record<string, string>,
  preserveKeys: Set<string> = new Set(),
): string {
  const lines = existing ? existing.split(/\r?\n/) : [];
  const keyRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/;
  const existingKeys = new Map<number, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(keyRegex);
    if (m && m[1]) existingKeys.set(i, m[1]);
  }

  const seen = new Set<string>();
  // Update in place where possible
  for (const [idx, key] of existingKeys) {
    if (!(key in vars)) continue;
    seen.add(key);
    if (preserveKeys.has(key)) continue; // keep existing value
    lines[idx] = `${key}=${vars[key]}`;
  }

  // Append new keys
  const toAppend: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    if (seen.has(key)) continue;
    toAppend.push(`${key}=${value}`);
  }

  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (toAppend.length > 0) {
    if (lines.length > 0) lines.push("");
    for (const l of toAppend) lines.push(l);
  }

  return lines.join("\n") + "\n";
}

/**
 * Merge Gemini CLI settings.json to set `security.auth.selectedType` while
 * preserving all other keys.
 */
export function mergeGeminiSettings(existing: any): any {
  const out: any = { ...(existing ?? {}) };
  out.security = {
    ...(existing?.security ?? {}),
    auth: {
      ...(existing?.security?.auth ?? {}),
      selectedType: "gemini-api-key",
    },
  };
  return out;
}
