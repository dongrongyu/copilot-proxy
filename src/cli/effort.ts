import { loadConfig, updateEffortConfig, getConfigPath } from "../config/loader";

/**
 * Allowed effort values, weakest → strongest. Validation lives here in the
 * application layer (not the config schema), matching the project convention.
 */
export const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"];

/** Base URL of the locally running proxy, derived from the saved config. */
function proxyBaseUrl(): string {
  const cfg = loadConfig();
  return `http://${cfg.address}:${cfg.port}`;
}

/**
 * Ask the running proxy for its in-memory effort via the portal API. Returns the
 * live value, or null when the proxy isn't reachable (not running / different
 * port). A short timeout keeps the CLI snappy when nothing is listening.
 * Exported for tests.
 */
export async function fetchLiveEffort(): Promise<string | null> {
  try {
    const resp = await fetch(`${proxyBaseUrl()}/api/portal/effort`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { effort?: string };
    return typeof data.effort === "string" ? data.effort : null;
  } catch {
    return null;
  }
}

/**
 * Push a new effort to the running proxy via the portal API. The server persists
 * it to config.yaml AND hot-reloads its own in-memory config, so the change
 * takes effect instantly with no restart. Returns true on success, false when
 * the proxy isn't reachable (caller then falls back to a direct disk write).
 * Exported for tests.
 */
export async function pushLiveEffort(value: string): Promise<boolean> {
  try {
    const resp = await fetch(`${proxyBaseUrl()}/api/portal/effort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort: value }),
      signal: AbortSignal.timeout(1500),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function printStatus(): Promise<void> {
  const cfg = loadConfig();
  const live = await fetchLiveEffort();
  console.log("\nReasoning effort configuration:");
  console.log(`  effort (config file): ${cfg.effort}`);
  if (live !== null) {
    const same = live === cfg.effort;
    console.log(`  effort (running):     ${live}${same ? "" : "   ⚠ differs — restart or re-set to sync"}`);
  } else {
    console.log(`  effort (running):     (proxy not reachable on ${proxyBaseUrl()})`);
  }
  console.log(`\n  Applied to thinking requests on the Anthropic /v1/messages path`);
  console.log(`  (Claude Code) for models that support reasoning_effort — currently`);
  console.log(`  claude-opus-4.6/4.7/4.8 and claude-sonnet-4.6. The value is clamped`);
  console.log(`  to the nearest effort each model supports. Other models (and the`);
  console.log(`  OpenAI/Gemini paths) are unaffected.`);
  console.log(`\n  config: ${getConfigPath()}`);
}

function printUsage(): void {
  console.log("\nUsage:");
  console.log(`  copilot-proxy effort <${EFFORT_VALUES.join(" | ")}>   set the target reasoning effort`);
  console.log(`  copilot-proxy effort status                          show current setting`);
}

export async function effortCommand(action?: string): Promise<void> {
  // No args → show status + usage hint.
  if (!action) {
    await printStatus();
    printUsage();
    return;
  }

  const name = action.toLowerCase();

  if (name === "status" || name === "show") {
    await printStatus();
    return;
  }

  if (!EFFORT_VALUES.includes(name)) {
    console.error(`Unknown effort: "${action}". Allowed: ${EFFORT_VALUES.join(", ")}`);
    printUsage();
    process.exit(1);
  }

  // Prefer the running proxy: it persists to config.yaml AND hot-reloads its
  // in-memory value, so the change is instant. Fall back to a direct disk write
  // when the proxy isn't running.
  const applied = await pushLiveEffort(name);
  if (applied) {
    console.log(`Set reasoning effort to "${name}" — applied instantly to the running proxy.`);
  } else {
    const path = updateEffortConfig(name);
    console.log(`Set reasoning effort to "${name}": ${path}`);
    console.log(`(proxy not running on ${proxyBaseUrl()} — change takes effect on next start)`);
  }
  await printStatus();
}
