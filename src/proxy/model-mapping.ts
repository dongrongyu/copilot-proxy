import { getState } from "../auth/state";

/**
 * Translate a model name to a Copilot model ID. The mapping tables live in
 * config (config.model_mappings), seeded from DEFAULT_MODEL_MAPPINGS and
 * overridable by the user — this function holds only the resolution *logic*.
 *
 * Resolution order:
 * 1. exact match on the raw name (lets a user map a literal "...[1m]" id)
 * 2. prefix match on the raw name (longest prefix first)
 * 3. [1m] is a Claude-Code-only marker (it tells Claude Code a model is
 *    1M-context; it has no meaning to Copilot). Strip it, then RE-RUN exact +
 *    prefix so a dash-form name still normalizes — e.g.
 *    "claude-opus-4-8[1m]" -> strip -> "claude-opus-4-8" -> "claude-opus-4.8".
 *    Strip even on no match so a raw "[1m]" never reaches the upstream API.
 * 4. passthrough.
 */
export function translateModelName(model: string): string {
  const { exact, prefix } = getState().config.model_mappings;

  // Layer 1: exact on the raw name
  if (exact[model]) return exact[model];

  // Layer 2: prefix on the raw name (longest prefix first)
  const prefixMatch = findPrefixMatch(model, prefix);
  if (prefixMatch) return prefixMatch;

  // Layer 3: strip the [1m] marker, then retry exact + prefix on the remainder.
  if (model.includes("[1m]")) {
    const stripped = model.replace("[1m]", "");
    if (exact[stripped]) return exact[stripped];
    const strippedPrefix = findPrefixMatch(stripped, prefix);
    if (strippedPrefix) return strippedPrefix;
    return stripped;
  }

  // Layer 4: no match, return original
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
