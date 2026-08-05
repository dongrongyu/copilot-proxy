import { execFileSync } from "child_process";
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

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
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
 * Patch a complete Codex catalog with the context and prompt limits advertised
 * by the live Copilot catalog. Only GPT models present in both catalogs are
 * touched; all other model metadata remains semantically unchanged.
 */
export function patchCodexCatalogForCopilot(
  source: unknown,
  copilotModels: CopilotModel[],
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

/** Load the official catalog bundled with the installed Codex CLI. */
export function loadBundledCodexCatalog(): CodexModelCatalog {
  let output: string;
  try {
    output = execFileSync("codex", ["debug", "models", "--bundled"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Unable to read the bundled Codex model catalog: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Codex returned an invalid model catalog: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).models)) {
    throw new Error("Codex returned a model catalog without a models array");
  }
  return parsed as CodexModelCatalog;
}

export function buildCodexCatalogForCopilot(
  copilotModels: CopilotModel[],
): PatchedCodexCatalog {
  return patchCodexCatalogForCopilot(loadBundledCodexCatalog(), copilotModels);
}
