import { getState } from "../auth/state";

// Built-in exact mappings (Claude Code model name -> Copilot model ID)
const BUILTIN_EXACT: Record<string, string> = {
  opus: "claude-opus-4.6",
  sonnet: "claude-sonnet-4.5",
  haiku: "claude-haiku-4.5",
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4-7": "claude-opus-4.7",
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-haiku-4-5": "claude-haiku-4.5",
};

// Built-in prefix mappings.
// Only dash-form (Claude Code naming, e.g. "claude-opus-4-6-20250514") needs
// normalization. Dot-form names (e.g. "claude-opus-4.6-1m") are already valid
// Copilot model IDs and must pass through verbatim — adding a dot-form prefix
// here would incorrectly strip real suffixes like "-1m" or "-1m-internal".
const BUILTIN_PREFIX: Record<string, string> = {
  "claude-sonnet-4-": "claude-sonnet-4",
  "claude-haiku-4-5-": "claude-haiku-4.5",
  "claude-opus-4-5-": "claude-opus-4.5",
  "claude-opus-4-6-": "claude-opus-4.6",
  "claude-opus-4-7-": "claude-opus-4.7",
};

/**
 * Translate model name with three-layer resolution:
 * 1. User config (exact > prefix)
 * 2. Built-in defaults (exact > prefix)
 * 3. [1m] is a Claude-Code-only marker — strip it and use the remainder
 *    as the literal Copilot model id. The full Copilot id is always written
 *    to the config, so the remainder is already a valid model name.
 */
export function translateModelName(model: string): string {
  const { config } = getState();
  const userExact = config.model_mappings.exact;
  const userPrefix = config.model_mappings.prefix;

  // Layer 1: User exact match
  if (userExact[model]) return userExact[model];

  // Layer 1: User prefix match (longest prefix first)
  const userPrefixMatch = findPrefixMatch(model, userPrefix);
  if (userPrefixMatch) return userPrefixMatch;

  // Layer 3 (handled before Layer 2 prefix to avoid prefix matches eating
  // the "-1m" / "-1m-internal" suffix): [1m] is a Claude Code marker only.
  if (model.includes("[1m]")) {
    return model.replace("[1m]", "");
  }

  // Layer 2: Built-in exact match
  if (BUILTIN_EXACT[model]) return BUILTIN_EXACT[model];

  // Layer 2: Built-in prefix match
  const builtinPrefixMatch = findPrefixMatch(model, BUILTIN_PREFIX);
  if (builtinPrefixMatch) return builtinPrefixMatch;

  // No match, return original
  return model;
}

/**
 * Reverse-map a Copilot model ID for use in Claude Code settings.
 * Appends [1m] so Claude Code recognizes the model as 1M-context, while
 * preserving the full Copilot id (so the proxy receives an unambiguous name).
 * e.g. "claude-opus-4.6-1m"           -> "claude-opus-4.6-1m[1m]"
 *      "claude-opus-4.7-1m-internal"  -> "claude-opus-4.7-1m-internal[1m]"
 */
export function reverseModelName(copilotId: string): string {
  if (copilotId.endsWith("-1m") || copilotId.endsWith("-1m-internal")) {
    return `${copilotId}[1m]`;
  }
  return copilotId;
}

function findPrefixMatch(
  model: string,
  prefixes: Record<string, string>
): string | null {
  // Sort by length descending for longest prefix match
  const sorted = Object.keys(prefixes).sort((a, b) => b.length - a.length);
  for (const prefix of sorted) {
    if (model.startsWith(prefix)) {
      return prefixes[prefix] ?? null;
    }
  }
  return null;
}
