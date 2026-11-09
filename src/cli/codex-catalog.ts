import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import type { CopilotModel } from "../auth/state";

export const CODEX_CATALOG_FILENAME = "copilot-proxy-models.json";

const AUTO_COMPACT_HEADROOM_RATIO = 0.98;
const AUTO_COMPACT_ROUNDING_TOKENS = 10_000;

export interface CodexModelCatalog {
  models: Array<Record<string, any>>;
}

export interface CodexModelLimitOverride {
  id: string;
  previousContextWindow?: number;
  previousMaxContextWindow?: number;
  contextWindow: number;
  autoCompactTokenLimit?: number;
}

export interface PatchedCodexCatalog {
  catalog: CodexModelCatalog;
  overrides: CodexModelLimitOverride[];
}

export interface CodexCatalogCommand {
  label: string;
  command: string;
  args: string[];
  cwd?: string;
}

type CodexCatalogCommandRunner = (spec: CodexCatalogCommand) => string;

const BUNDLED_CATALOG_ARGS = ["debug", "models", "--bundled"];

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

const REASONING_DESCRIPTIONS: Record<string, string> = {
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
};

function rewriteCodexModelIdentity(value: unknown, displayName: string): unknown {
  if (typeof value !== "string") return value;
  return value.replace(
    /^You are Codex, an agent based on .*?\.(?=\r?\n|$)/,
    `You are Codex, an agent based on ${displayName}.`,
  );
}

/**
 * Codex may lag behind the live Copilot catalog for a newly released model.
 * Clone the newest compatible GPT entry so Codex retains its version-specific
 * tool/instruction metadata, then replace every capability Copilot advertises.
 * Once Codex ships an official entry this path is skipped automatically.
 */
function synthesizeCodexModel(
  catalog: CodexModelCatalog,
  copilot: CopilotModel,
): Record<string, any> {
  const template = catalog.models.find((model) => model.slug === "gpt-5.6-sol")
    ?? catalog.models.find((model) => /^gpt-\d/.test(model.slug));
  if (!template) {
    throw new Error(`Unable to synthesize Codex metadata for ${copilot.id}: no GPT template found`);
  }

  const model = JSON.parse(JSON.stringify(template)) as Record<string, any>;
  const displayName = copilot.name || copilot.id;
  const supportedEfforts = copilot.capabilities?.supports?.reasoning_effort ?? [];
  const templateEfforts = new Map<string, string>(
    (Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
      : [])
      .filter((item: any) => typeof item?.effort === "string")
      .map((item: any) => [item.effort, item.description ?? ""]),
  );

  model.slug = copilot.id;
  model.display_name = displayName;
  model.description = `${displayName} through GitHub Copilot.`;
  model.visibility = "list";
  model.supported_in_api = true;
  model.additional_speed_tiers = [];
  model.service_tiers = [];
  model.supported_reasoning_levels = supportedEfforts.map((effort) => ({
    effort,
    description: templateEfforts.get(effort)
      || REASONING_DESCRIPTIONS[effort]
      || `${effort} reasoning effort`,
  }));
  if (supportedEfforts.length > 0) {
    model.default_reasoning_level = supportedEfforts.includes(model.default_reasoning_level)
      ? model.default_reasoning_level
      : (supportedEfforts.includes("medium") ? "medium" : supportedEfforts[0]);
  }
  model.base_instructions = rewriteCodexModelIdentity(model.base_instructions, displayName);
  if (model.model_messages && typeof model.model_messages === "object") {
    model.model_messages.instructions_template = rewriteCodexModelIdentity(
      model.model_messages.instructions_template,
      displayName,
    );
  }
  return model;
}

/**
 * Keep compaction below Copilot's advertised prompt ceiling. Rounding down to
 * 10K tokens provides a small buffer for tokenizer/accounting differences:
 * 922K -> 900K and 272K -> 260K.
 */
export function codexAutoCompactLimit(maxPromptTokens: unknown): number | undefined {
  const promptLimit = positiveInteger(maxPromptTokens);
  if (!promptLimit) return undefined;
  const withHeadroom = promptLimit * AUTO_COMPACT_HEADROOM_RATIO;
  const rounded = Math.floor(withHeadroom / AUTO_COMPACT_ROUNDING_TOKENS)
    * AUTO_COMPACT_ROUNDING_TOKENS;
  return rounded > 0 ? rounded : undefined;
}

/**
 * Patch a complete Codex catalog with every GPT model's full context and prompt
 * limits advertised by the live Copilot catalog. Missing GPT entries receive
 * compatible metadata; all other model metadata remains unchanged.
 */
export function patchCodexCatalogForCopilot(
  source: unknown,
  copilotModels: CopilotModel[],
  requiredModel?: string,
): PatchedCodexCatalog {
  if (!source || typeof source !== "object" || !Array.isArray((source as any).models)) {
    throw new Error("Codex model catalog must contain a models array");
  }

  const catalog = JSON.parse(JSON.stringify(source)) as CodexModelCatalog;
  if (catalog.models.length === 0) {
    throw new Error("Codex model catalog must contain at least one model");
  }

  const copilotById = new Map(copilotModels.map((model) => [model.id, model]));
  const overrides: CodexModelLimitOverride[] = [];

  if (requiredModel && !catalog.models.some((model) => model.slug === requiredModel)) {
    const copilot = copilotById.get(requiredModel);
    if (!copilot || !requiredModel.startsWith("gpt-")) {
      throw new Error(`Codex model catalog does not include ${requiredModel}`);
    }
    catalog.models.push(synthesizeCodexModel(catalog, copilot));
  }

  const knownModels = new Set(catalog.models.map((model) => model.slug));
  for (const copilot of copilotModels) {
    if (
      !copilot.id.startsWith("gpt-")
      || knownModels.has(copilot.id)
      || !positiveInteger(copilot.capabilities?.limits?.max_context_window_tokens)
      || copilot.supported_endpoints?.length === 0
    ) continue;
    catalog.models.push(synthesizeCodexModel(catalog, copilot));
    knownModels.add(copilot.id);
  }

  for (const model of catalog.models) {
    const id = typeof model.slug === "string" ? model.slug : "";
    if (!id.startsWith("gpt-")) continue;

    const copilot = copilotById.get(id);
    if (!copilot) continue;

    const limits = copilot.capabilities?.limits;
    const contextWindow = positiveInteger(limits?.max_context_window_tokens);
    if (!contextWindow) continue;

    const previousContextWindow = positiveInteger(model.context_window);
    const previousMaxContextWindow = positiveInteger(model.max_context_window);
    const previousAutoCompactTokenLimit = positiveInteger(model.auto_compact_token_limit);
    const autoCompactTokenLimit = codexAutoCompactLimit(limits?.max_prompt_tokens);
    const contextNeedsUpdate = previousContextWindow !== contextWindow
      || previousMaxContextWindow !== contextWindow;
    const compactNeedsUpdate = autoCompactTokenLimit !== undefined
      && (previousAutoCompactTokenLimit === undefined
        || previousAutoCompactTokenLimit > autoCompactTokenLimit);
    if (!contextNeedsUpdate && !compactNeedsUpdate) continue;

    if (contextNeedsUpdate) {
      model.context_window = contextWindow;
      model.max_context_window = contextWindow;
    }
    if (compactNeedsUpdate) {
      model.auto_compact_token_limit = autoCompactTokenLimit;
    }

    overrides.push({
      id,
      previousContextWindow,
      previousMaxContextWindow,
      contextWindow,
      autoCompactTokenLimit: compactNeedsUpdate
        ? autoCompactTokenLimit
        : previousAutoCompactTokenLimit,
    });
  }

  return { catalog, overrides };
}

function runCatalogCommand(spec: CodexCatalogCommand): string {
  return execFileSync(spec.command, spec.args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    cwd: spec.cwd,
  });
}

/**
 * Candidate commands for reading Codex's bundled catalog. WSL inherits Windows
 * PATH entries, where the extensionless npm shim runs Linux Node against a
 * Windows-only install. If the normal command fails, invoke codex.cmd through
 * Windows cmd.exe so Windows Node selects the win32 optional dependency.
 */
export function codexCatalogCommands(
  platform = process.platform,
  targetConfigPath?: string,
): CodexCatalogCommand[] {
  const windowsRoot = platform === "win32"
    ? (process.env.SystemRoot || process.env.WINDIR)
    : (existsSync("/mnt/c/Windows") ? "/mnt/c/Windows" : undefined);
  const windowsCmd = platform === "win32"
    ? (process.env.ComSpec || "cmd.exe")
    : (existsSync("/mnt/c/Windows/System32/cmd.exe")
      ? "/mnt/c/Windows/System32/cmd.exe"
      : "cmd.exe");
  const windowsSpec: CodexCatalogCommand = {
    label: "Windows Codex",
    command: windowsCmd,
    args: ["/d", "/c", "codex.cmd", ...BUNDLED_CATALOG_ARGS],
    cwd: windowsRoot,
  };

  // A Windows client must retain its own version's metadata schema, even when
  // a newer WSL Codex already bundles the selected model.
  const windowsTarget = targetConfigPath
    && /^\/mnt\/[a-z](?:\/|$)/i.test(resolve(targetConfigPath));
  if (platform === "win32" || windowsTarget) return [windowsSpec];
  return [
    {
      label: "Codex",
      command: "codex",
      args: [...BUNDLED_CATALOG_ARGS],
    },
    windowsSpec,
  ];
}

function shortError(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const stderrText = Buffer.isBuffer(stderr)
    ? stderr.toString("utf-8")
    : (typeof stderr === "string" ? stderr : "");
  if (stderrText) {
    const lines = stderrText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const useful = lines.find((line) => line.startsWith("Error:"))
      || lines.find((line) => /not recognized|not found|missing optional dependency/i.test(line))
      || lines[0];
    if (useful) return useful;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/, 1)[0] || String(error);
}

export function loadBundledCodexCatalogFromCommands(
  commands: CodexCatalogCommand[],
  run: CodexCatalogCommandRunner = runCatalogCommand,
  requiredModel?: string,
  allowMissingRequiredModel = false,
): CodexModelCatalog {
  const failures: string[] = [];
  let missingRequiredFallback: CodexModelCatalog | null = null;
  for (const spec of commands) {
    let output: string;
    try {
      output = run(spec);
    } catch (error) {
      failures.push(`${spec.label}: ${shortError(error)}`);
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      failures.push(`${spec.label}: invalid JSON (${shortError(error)})`);
      continue;
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).models)) {
      failures.push(`${spec.label}: response has no models array`);
      continue;
    }
    const catalog = parsed as CodexModelCatalog;
    if (
      requiredModel
      && !catalog.models.some((model) => model.slug === requiredModel)
    ) {
      missingRequiredFallback ??= catalog;
      failures.push(`${spec.label}: catalog does not include ${requiredModel}`);
      continue;
    }
    return catalog;
  }

  if (allowMissingRequiredModel && missingRequiredFallback) {
    return missingRequiredFallback;
  }

  const details = failures.length > 0 ? ` (${failures.join("; ")})` : "";
  throw new Error(`Unable to read the bundled Codex model catalog${details}`);
}

/** Load the official catalog bundled with the installed Codex CLI. */
export function loadBundledCodexCatalog(
  requiredModel?: string,
  allowMissingRequiredModel = false,
  targetConfigPath?: string,
): CodexModelCatalog {
  return loadBundledCodexCatalogFromCommands(
    codexCatalogCommands(process.platform, targetConfigPath),
    runCatalogCommand,
    requiredModel,
    allowMissingRequiredModel,
  );
}

export function buildCodexCatalogForCopilot(
  copilotModels: CopilotModel[],
  requiredModel?: string,
  targetConfigPath?: string,
): PatchedCodexCatalog {
  return patchCodexCatalogForCopilot(
    loadBundledCodexCatalog(requiredModel, true, targetConfigPath),
    copilotModels,
    requiredModel,
  );
}
