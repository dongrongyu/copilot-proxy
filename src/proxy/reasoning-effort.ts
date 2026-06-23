import { getState } from "../auth/state";

// Reasoning efforts ordered weakest → strongest. Used to find the nearest
// supported effort when the configured target isn't in a model's ladder.
const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"];

/**
 * Snap a target reasoning effort to the nearest value a model actually supports.
 *
 * Pure function (no I/O) so it can be unit-tested directly. Given the target and
 * the model's supported-efforts ladder, returns:
 *   - the target itself if supported; else
 *   - the NEAREST stronger supported effort (searching "up"); else
 *   - the nearest weaker one (searching "down"); else
 *   - "" when `supported` is empty.
 * For an unknown target (not on the canonical ladder) it returns the strongest
 * supported effort, so a typo in config still yields a sensible value.
 *
 * Example: clampEffortToSupported("xhigh", ["low","medium","high","max"]) → "max".
 */
export function clampEffortToSupported(target: string, supported: string[]): string {
  if (!supported || supported.length === 0) return "";
  if (supported.includes(target)) return target;

  const targetIdx = EFFORT_LADDER.indexOf(target);
  if (targetIdx === -1) {
    for (let i = EFFORT_LADDER.length - 1; i >= 0; i--) {
      if (supported.includes(EFFORT_LADDER[i]!)) return EFFORT_LADDER[i]!;
    }
    return "";
  }

  // Prefer the nearest STRONGER effort (up), then fall back to weaker (down).
  for (let i = targetIdx + 1; i < EFFORT_LADDER.length; i++) {
    if (supported.includes(EFFORT_LADDER[i]!)) return EFFORT_LADDER[i]!;
  }
  for (let i = targetIdx - 1; i >= 0; i--) {
    if (supported.includes(EFFORT_LADDER[i]!)) return EFFORT_LADDER[i]!;
  }
  return "";
}

/**
 * The model's supported reasoning efforts, as advertised by the Copilot
 * `/models` catalog. Empty array when the model has no such capability.
 */
export function supportedEffortsFor(model: string): string[] {
  const state = getState();
  const entry = state.models?.data?.find((m) => m.id === model);
  const supported = entry?.capabilities?.supports?.reasoning_effort;
  return supported ?? [];
}

/**
 * Resolve the globally configured effort for a specific model, clamped to that
 * model's advertised reasoning-effort ladder. Returns "" when the model does
 * not advertise any reasoning_effort capability.
 */
export function configuredEffortForModel(model: string): string {
  return resolveEffortForModel(model);
}

function normalizeEffortValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resolveEffortForModel(model: string, requested = ""): string {
  const supported = supportedEffortsFor(model);
  if (supported.length === 0) return "";

  const target = requested || normalizeEffortValue(getState().config.effort) || "high";
  return clampEffortToSupported(target, supported);
}

/**
 * Apply the proxy's configured effort to an OpenAI Responses payload when the
 * caller has opted into reasoning (`payload.reasoning` present as an object)
 * and the selected model advertises reasoning_effort support.
 *
 * If the caller already provided `reasoning.effort`, that value is preserved as
 * the preference source but clamped to the model's supported ladder. Otherwise
 * the proxy's global `config.effort` is injected as the default.
 */
export function adjustResponsesReasoningForModel(
  payload: any,
  model: string,
): { payload: any; effort: string } {
  const reasoning = payload?.reasoning;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    return { payload, effort: "" };
  }

  const effort = resolveEffortForModel(model, normalizeEffortValue(reasoning.effort));
  if (!effort) return { payload, effort: "" };

  return {
    payload: {
      ...payload,
      reasoning: {
        ...reasoning,
        effort,
      },
    },
    effort,
  };
}
