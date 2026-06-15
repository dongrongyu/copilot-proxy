import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import yaml from "js-yaml";
import type { Config } from "./schema";
import { DEFAULT_CONFIG } from "./schema";

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

export const DEFAULT_CONFIG_TEMPLATE = `# Copilot Proxy Configuration
# ============================

# Server Settings
address: localhost
port: 8989

# GitHub Copilot Account Type
# Options: "individual", "business", "enterprise"
account_type: individual

# Version strings (used in request headers to emulate VS Code)
vscode_version: "1.93.0"
api_version: "2025-04-01"
copilot_version: "0.26.7"

# Connection retry settings
max_connection_retries: 3

# Model Name Mappings
# Translate incoming model names to Copilot API model names.
# User mappings override built-in defaults.
# Two types: exact (full match) and prefix (startsWith match).
#
# Example:
#   exact:
#     "claude-opus-4-6[1m]": "claude-opus-4.6-1m"
#   prefix:
#     "claude-opus-4-6-": "claude-opus-4.6-1m"
model_mappings:
  exact: {}
  prefix: {}

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
