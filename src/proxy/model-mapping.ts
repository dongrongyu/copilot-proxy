import { getState } from "../auth/state";

/**
 * Translate a model name to a Copilot model ID. The mapping tables live in
 * config (config.model_mappings), seeded from DEFAULT_MODEL_MAPPINGS and
 * overridable by the user — this function holds only the resolution *logic*.
 *
 * `[1m]` is a Claude-Code-only marker (it tells Claude Code a model is
 * 1M-context; it means nothing to Copilot and no real model id carries it), so
 * it is stripped up front before any matching.
 *
 * Resolution order:
 * 1. exact match (full name)
 * 2. prefix match (longest prefix first)
 * 3. passthrough
 */
export function translateModelName(model: string): string {
  const { exact, prefix } = getState().config.model_mappings;

  // Strip the Claude-Code-only [1m] marker before matching.
  const name = model.includes("[1m]") ? model.replace("[1m]", "") : model;

  // Layer 1: exact match
  if (exact[name]) return exact[name];

  // Layer 2: prefix match (longest prefix first)
  const prefixMatch = findPrefixMatch(name, prefix);
  if (prefixMatch) return prefixMatch;

  // Layer 3: no match, return the (stripped) name
  return name;
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
