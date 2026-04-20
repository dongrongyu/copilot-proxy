import { getState } from "../auth/state";

// Built-in exact mappings (Claude Code model name -> Copilot model ID)
const BUILTIN_EXACT: Record<string, string> = {
  opus: "claude-opus-4.6",
  sonnet: "claude-sonnet-4.5",
  haiku: "claude-haiku-4.5",
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-haiku-4-5": "claude-haiku-4.5",
};

// Built-in prefix mappings
const BUILTIN_PREFIX: Record<string, string> = {
  "claude-sonnet-4-": "claude-sonnet-4",
  "claude-haiku-4.5-": "claude-haiku-4.5",
  "claude-haiku-4-5-": "claude-haiku-4.5",
  "claude-opus-4.5-": "claude-opus-4.5",
  "claude-opus-4-5-": "claude-opus-4.5",
  "claude-opus-4-6-": "claude-opus-4.6",
  "claude-opus-4.6-": "claude-opus-4.6",
};

/**
 * Translate model name with three-layer resolution:
 * 1. User config (exact > prefix)
 * 2. Built-in defaults (exact > prefix)
 * 3. Smart [1m] parsing: strip [1m], map, append -1m
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

  // Layer 2: Built-in exact match
  if (BUILTIN_EXACT[model]) return BUILTIN_EXACT[model];

  // Layer 2: Built-in prefix match
  const builtinPrefixMatch = findPrefixMatch(model, BUILTIN_PREFIX);
  if (builtinPrefixMatch) return builtinPrefixMatch;

  // Layer 3: Smart [1m] parsing
  if (model.includes("[1m]")) {
    const base = model.replace("[1m]", "");
    const mapped = translateModelName(base); // recursive, but without [1m] won't loop
    return `${mapped}-1m`;
  }

  // No match, return original
  return model;
}

/**
 * Reverse-map a Copilot model ID for use in Claude Code settings.
 * Only converts -1m suffix to [1m] notation.
 * e.g. "claude-opus-4.6-1m" -> "claude-opus-4.6[1m]"
 */
export function reverseModelName(copilotId: string): string {
  if (copilotId.endsWith("-1m")) {
    return `${copilotId.slice(0, -3)}[1m]`;
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
