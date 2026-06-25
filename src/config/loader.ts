import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import yaml from "js-yaml";
import type { Config, ModelMappingsConfig } from "./schema";
import { DEFAULT_CONFIG, DEFAULT_MODEL_MAPPINGS } from "./schema";

export function getConfigDir(): string {
  return join(homedir(), ".copilot-proxy");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.yaml");
}

export function loadConfig(): Config {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const userConfig = yaml.load(content) as Partial<Config> | null;
    if (!userConfig) return { ...DEFAULT_CONFIG };

    return {
      ...DEFAULT_CONFIG,
      ...userConfig,
      effort: userConfig.effort ?? DEFAULT_CONFIG.effort,
      model_mappings: {
        exact: {
          ...DEFAULT_CONFIG.model_mappings.exact,
          ...(userConfig.model_mappings?.exact ?? {}),
        },
        prefix: {
          ...DEFAULT_CONFIG.model_mappings.prefix,
          ...(userConfig.model_mappings?.prefix ?? {}),
        },
      },
      web_search: {
        ...DEFAULT_CONFIG.web_search,
        ...(userConfig.web_search ?? {}),
      },
    };
  } catch (err) {
    console.error(`[Config] Failed to load config: ${err}`);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Quote-escape a YAML scalar string value (double-quoted form).
 */
function quoteYaml(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Serialize a ModelMappingsConfig into the indented YAML body for a
 * `model_mappings:` block — the two `exact:` / `prefix:` sub-blocks with their
 * quoted key/value pairs. Map keys contain dots, dashes and brackets
 * (e.g. "claude-opus-4-6[1m]") so both keys and values are always quoted. An
 * empty sub-map renders as the inline flow form `{}`. Lines are joined with the
 * given end-of-line marker; no trailing EOL is appended.
 *
 * This is the single serializer used by both DEFAULT_CONFIG_TEMPLATE (fresh
 * files) and setModelMappings (patching existing files), so the on-disk shape
 * never diverges between the two paths.
 */
export function renderMappingsBlock(mappings: ModelMappingsConfig, eol = "\n"): string {
  const renderMap = (name: "exact" | "prefix", map: Record<string, string>): string[] => {
    const keys = Object.keys(map);
    if (keys.length === 0) return [`  ${name}: {}`];
    return [`  ${name}:`, ...keys.map((k) => `    ${quoteYaml(k)}: ${quoteYaml(map[k]!)}`)];
  };
  return [
    ...renderMap("exact", mappings.exact),
    ...renderMap("prefix", mappings.prefix),
  ].join(eol);
}

export const DEFAULT_CONFIG_TEMPLATE = `# Copilot Proxy Configuration
# ============================

# Server Settings
port: 8989

# Connection retry settings
max_connection_retries: 3

# Reasoning Effort
# Target reasoning effort applied to supported requests whose model advertises a
# reasoning_effort capability (e.g. claude-opus-4.6/4.7/4.8, claude-sonnet-4.6,
# gpt-5.x). The proxy clamps this value to the nearest effort the model
# actually supports (e.g. "xhigh" becomes "max" on a model that lacks xhigh).
# Options: "low", "medium", "high", "xhigh", "max"
#   copilot-proxy effort high
effort: xhigh

# Model Name Mappings
# Translate incoming model names to Copilot API model names.
# Two types: exact (full match) and prefix (startsWith match).
# Edit these freely — they are the defaults you start with, not hidden in code.
#
# Example:
#   exact:
#     "claude-opus-4-6[1m]": "claude-opus-4.6-1m"
#   prefix:
#     "claude-opus-4-6-": "claude-opus-4.6-1m"
model_mappings:
${renderMappingsBlock(DEFAULT_MODEL_MAPPINGS)}

# Web Search Fallback
# When Copilot rejects web_search tools, use built-in search instead.
# Set a provider key without editing this file (this also enables it):
#   copilot-proxy web-search use tavily <key>
#   copilot-proxy web-search use webiq <key>
web_search:
  enabled: false
  provider: "tavily"        # "tavily", "webiq", or "searxng"
  tavily_api_key: ""
  webiq_api_key: ""
  searxng_url: "http://localhost:8888"
`;

/**
 * Create the config file with the default commented template if it doesn't
 * already exist. Silent and idempotent — safe to call on every startup.
 * Returns true when a new file was written, false when one already existed.
 */
export function ensureConfigFile(): boolean {
  const configPath = getConfigPath();
  if (existsSync(configPath)) return false;
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(configPath, DEFAULT_CONFIG_TEMPLATE, "utf-8");
  return true;
}

export function generateDefaultConfig(): string {
  const configPath = getConfigPath();

  if (existsSync(configPath)) {
    console.log(`Config already exists at: ${configPath}`);
  } else {
    ensureConfigFile();
    console.log(`Config generated at: ${configPath}`);
  }

  return configPath;
}

export interface WebSearchUpdate {
  enabled?: boolean;
  provider?: "tavily" | "searxng" | "webiq";
  tavily_api_key?: string;
  webiq_api_key?: string;
  searxng_url?: string;
}

function formatYamlValue(v: string | boolean): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Update fields inside the top-level `web_search:` block of a YAML document,
 * preserving comments, key order, and existing inline comments. This is a pure
 * string transform (no js-yaml round-trip) precisely so the hand-written
 * comments in the default template survive edits.
 *
 * - Existing keys are updated in place; their trailing `# ...` inline comment
 *   is kept.
 * - Keys not present in the block are appended to the end of the block.
 * - If no `web_search:` block exists, a fresh one is appended to the document.
 * - The document's existing line-ending style (LF / CRLF) is preserved.
 */
export function setWebSearchFields(text: string, updates: WebSearchUpdate): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const entries = (Object.entries(updates) as [string, string | boolean][])
    .filter(([, v]) => v !== undefined);
  if (entries.length === 0) return text;

  const lines = text.split(/\r?\n/);
  const blockIdx = lines.findIndex((l) => /^web_search\s*:/.test(l));

  if (blockIdx === -1) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    const block = [
      "",
      "# Web Search Fallback",
      "web_search:",
      ...entries.map(([k, v]) => `  ${k}: ${formatYamlValue(v)}`),
    ];
    return [...lines, ...block].join(eol) + eol;
  }

  const baseIndent = (lines[blockIdx]!.match(/^(\s*)/)?.[1] ?? "").length;
  const childIndent = " ".repeat(baseIndent + 2);

  // Block spans until the next non-blank line indented at or below the parent.
  let endIdx = lines.length;
  for (let i = blockIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const indent = (line.match(/^(\s*)/)?.[1] ?? "").length;
    if (indent <= baseIndent) { endIdx = i; break; }
  }

  const remaining = new Map(entries);
  for (let i = blockIdx + 1; i < endIdx; i++) {
    const m = lines[i]!.match(/^(\s*)([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[2]!;
    if (!remaining.has(key)) continue;
    const value = remaining.get(key)!;
    remaining.delete(key);
    const commentMatch = m[3]!.match(/\s+(#.*)$/);
    const comment = commentMatch ? `        ${commentMatch[1]}` : "";
    lines[i] = `${m[1]}${key}: ${formatYamlValue(value)}${comment}`;
  }

  if (remaining.size > 0) {
    const toInsert = [...remaining.entries()].map(
      ([k, v]) => `${childIndent}${k}: ${formatYamlValue(v)}`,
    );
    lines.splice(endIdx, 0, ...toInsert);
  }

  return lines.join(eol);
}

/**
 * Read the config file (creating it from template if missing), apply web_search
 * field updates while preserving comments, and write it back. Returns the path.
 */
export function updateWebSearchConfig(updates: WebSearchUpdate): string {
  ensureConfigFile();
  const configPath = getConfigPath();
  const text = readFileSync(configPath, "utf-8");
  const next = setWebSearchFields(text, updates);
  if (next !== text) writeFileSync(configPath, next, "utf-8");
  return configPath;
}

/**
 * Update the top-level `effort:` scalar in a YAML document, preserving comments,
 * key order, and any trailing inline comment on the line. Pure string transform
 * (no js-yaml round-trip) so the hand-written template comments survive. If no
 * `effort:` key exists, one is appended. Line-ending style (LF/CRLF) preserved.
 */
export function setEffortField(text: string, value: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^effort\s*:/.test(l));
  const formatted = `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

  if (idx === -1) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return [...lines, "", "# Reasoning Effort", `effort: ${formatted}`].join(eol) + eol;
  }

  const m = lines[idx]!.match(/^(\s*effort\s*:\s*)(.*)$/);
  if (m) {
    const commentMatch = m[2]!.match(/\s+(#.*)$/);
    const comment = commentMatch ? `        ${commentMatch[1]}` : "";
    lines[idx] = `${m[1]}${formatted}${comment}`;
  }
  return lines.join(eol);
}

/**
 * Read the config file (creating it from template if missing), set the `effort`
 * field while preserving comments, and write it back. Returns the path.
 */
export function updateEffortConfig(value: string): string {
  ensureConfigFile();
  const configPath = getConfigPath();
  const text = readFileSync(configPath, "utf-8");
  const next = setEffortField(text, value);
  if (next !== text) writeFileSync(configPath, next, "utf-8");
  return configPath;
}

/**
 * Replace the entire body of the `model_mappings:` block with a freshly rendered
 * exact/prefix table, preserving everything outside the block — including the
 * hand-written comments that precede `model_mappings:` and any blocks after it.
 * Pure string transform (no js-yaml round-trip) so comments survive. If no
 * `model_mappings:` key exists, a fresh block is appended. Line-ending style
 * (LF/CRLF) is preserved.
 *
 * Unlike setWebSearchFields (a flat key patcher), this replaces the whole nested
 * body wholesale — the right semantics both for the empty->default upgrade and
 * for the portal's "edit the full table and save" flow.
 */
export function setModelMappings(text: string, mappings: ModelMappingsConfig): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const blockIdx = lines.findIndex((l) => /^model_mappings\s*:/.test(l));
  const body = renderMappingsBlock(mappings, eol).split(eol);

  if (blockIdx === -1) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    return [...lines, "", "# Model Name Mappings", "model_mappings:", ...body].join(eol) + eol;
  }

  const baseIndent = (lines[blockIdx]!.match(/^(\s*)/)?.[1] ?? "").length;

  // The block body spans until the next non-blank line indented at or below the
  // parent (i.e. a sibling top-level key) — same boundary rule as setWebSearchFields.
  let endIdx = lines.length;
  for (let i = blockIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const indent = (line.match(/^(\s*)/)?.[1] ?? "").length;
    if (indent <= baseIndent) { endIdx = i; break; }
  }

  // Keep any blank separator line(s) that sat between the old body and the next
  // sibling block, so replacing the body doesn't collapse the spacing.
  let tailBlanks = 0;
  while (endIdx - 1 - tailBlanks > blockIdx && lines[endIdx - 1 - tailBlanks]!.trim() === "") {
    tailBlanks++;
  }

  lines.splice(
    blockIdx + 1,
    endIdx - (blockIdx + 1) - tailBlanks,
    ...body,
  );
  return lines.join(eol);
}

/**
 * True when a parsed config's model_mappings carries no entries at all — the
 * delete-everything floor a fresh-but-old config.yaml sits at before the
 * defaults are injected.
 */
function mappingsAreEmpty(mappings: ModelMappingsConfig | undefined): boolean {
  if (!mappings) return true;
  return (
    Object.keys(mappings.exact ?? {}).length === 0 &&
    Object.keys(mappings.prefix ?? {}).length === 0
  );
}

/**
 * Smooth upgrade for existing installs: if the on-disk config.yaml has an
 * empty/absent model_mappings, inject DEFAULT_MODEL_MAPPINGS into it while
 * preserving the user's other content and comments. Idempotent — a no-op once
 * mappings are present. Returns true when the file was modified.
 *
 * Rationale: the default tables used to live in code; moving them to config
 * would leave old users (empty mappings + no code fallback) with a broken
 * proxy, so we backfill their file on startup.
 */
export function ensureModelMappings(): boolean {
  ensureConfigFile();
  const configPath = getConfigPath();
  const text = readFileSync(configPath, "utf-8");

  let parsed: Partial<Config> | null = null;
  try {
    parsed = yaml.load(text) as Partial<Config> | null;
  } catch {
    // Malformed YAML — don't touch it; loadConfig will fall back to defaults.
    return false;
  }

  if (!mappingsAreEmpty(parsed?.model_mappings)) return false;

  const next = setModelMappings(text, DEFAULT_MODEL_MAPPINGS);
  if (next !== text) {
    writeFileSync(configPath, next, "utf-8");
    return true;
  }
  return false;
}

/**
 * Read the config file (creating it from template if missing), replace the
 * model_mappings block with the given tables while preserving comments, and
 * write it back. Returns the path. Used by the portal's mapping editor.
 */
export function updateModelMappings(mappings: ModelMappingsConfig): string {
  ensureConfigFile();
  const configPath = getConfigPath();
  const text = readFileSync(configPath, "utf-8");
  const next = setModelMappings(text, mappings);
  if (next !== text) writeFileSync(configPath, next, "utf-8");
  return configPath;
}

/**
 * Read the raw config.yaml text (creating it from template if missing). Used by
 * the portal's whole-file editor so the user edits exactly what is on disk —
 * comments and all.
 */
export function readConfigFileText(): string {
  ensureConfigFile();
  return readFileSync(getConfigPath(), "utf-8");
}

/**
 * Overwrite config.yaml with raw text. The caller is responsible for any
 * validation (the portal validates YAML parses before calling this). Returns
 * the path written.
 */
export function writeConfigFileText(text: string): string {
  const configPath = getConfigPath();
  writeFileSync(configPath, text, "utf-8");
  return configPath;
}
