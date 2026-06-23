import { getState } from "../auth/state";
import { loadConfig, updateWebSearchConfig, updateEffortConfig, getConfigPath } from "../config/loader";
import type { WebSearchUpdate } from "../config/loader";
import { runWebSearchProbeFor } from "../proxy/web-search";
import {
  readMonthlyUsage,
  readRequestLogs,
  listLogDates,
} from "../usage/logger";
import { estimateCost } from "../usage/pricing";
import {
  buildClaudeEnv,
  buildGeminiEnv,
  buildCodexProxyToml,
  buildCodexAoaiToml,
  claudeDisplayName,
  filterAndSortModels,
  resolveConfigTargets,
  writeClaudeConfig,
  writeCodexConfig,
  writeGeminiConfig,
  type CodexAoaiOptions,
} from "../cli/config";
import { VERSION } from "../version";

const KEY_PREVIEW_VISIBLE = 4;

function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= KEY_PREVIEW_VISIBLE) return "*".repeat(key.length);
  return `${key.slice(0, KEY_PREVIEW_VISIBLE)}${"*".repeat(Math.min(key.length - KEY_PREVIEW_VISIBLE, 28))}`;
}

type WebSearchKeyField = "tavily_api_key" | "webiq_api_key";

const PROVIDER_META: Record<
  string,
  { keyField: WebSearchKeyField; label: string; note: string }
> = {
  tavily: {
    keyField: "tavily_api_key",
    label: "Tavily",
    note: "Concise AI-curated summaries · returns score & direct answer · good general coverage",
  },
  webiq: {
    keyField: "webiq_api_key",
    label: "WebIQ",
    note: "Full-page text extraction · official-source-first · richer context, more verbose",
  },
};

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function monthStr(): string {
  return new Date().toISOString().slice(0, 7);
}

function baseUrl(): string {
  const { config } = getState();
  return `http://${config.address}:${config.port}`;
}

/** Distinct YYYY-MM values present in the request-log directory, newest first. */
function availableMonths(): string[] {
  const months = new Set<string>();
  for (const d of listLogDates()) months.add(d.slice(0, 7));
  const list = [...months].sort().reverse();
  if (!list.includes(monthStr())) list.unshift(monthStr());
  return list;
}

export function dashboardData() {
  const { config, models, copilot_token, token_expires_at } = getState();
  const data = models?.data ?? [];
  const anthropicCount = data.filter((m) =>
    (m.supported_endpoints ?? []).includes("/v1/messages"),
  ).length;

  const today = readRequestLogs(todayStr());
  const errorsToday = today.filter((e) => e.status_code >= 400 || e.error).length;

  const nowSec = Date.now() / 1000;
  const tokenValid = !!copilot_token && nowSec < token_expires_at;
  const expiresInMin = tokenValid ? Math.max(0, Math.round((token_expires_at - nowSec) / 60)) : 0;

  const month = readMonthlyUsage(monthStr());
  const ws = config.web_search;

  return {
    server: { address: config.address, port: config.port, online: true },
    version: VERSION,
    token: { valid: tokenValid, expiresInMin },
    models: { total: data.length, anthropic: anthropicCount },
    requestsToday: { total: today.length, errors: errorsToday },
    environment: {
      account_type: config.account_type,
      web_search: { enabled: ws.enabled, provider: ws.provider },
      config_path: getConfigPath(),
    },
    month: month
      ? {
          month: month.month,
          total_requests: month.total_requests,
          input_tokens: month.totals.input_tokens,
          cache_read_input_tokens: month.totals.cache_read_input_tokens,
          output_tokens: month.totals.output_tokens,
          cost: Object.values(month.by_day).reduce((sum, d) => sum + d.cost, 0),
        }
      : {
          month: monthStr(),
          total_requests: 0,
          input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          cost: 0,
        },
  };
}

export function modelsData() {
  const { models } = getState();
  const data = models?.data ?? [];
  const rows = data.map((m) => {
    const caps = m.capabilities ?? {};
    const ctx = caps.limits?.max_context_window_tokens ?? 0;
    const capabilities = [
      caps.supports?.vision ? "Vision" : "",
      caps.supports?.tool_calls ? "Tool" : "",
      (m.supported_endpoints ?? []).includes("/v1/messages") ? "Anthropic" : "",
      m.preview ? "Preview" : "",
    ].filter(Boolean);
    return {
      id: m.id,
      vendor: m.vendor ?? "?",
      contextK: ctx >= 1000 ? Math.floor(ctx / 1000) : 0,
      contextRaw: ctx,
      capabilities,
      reasoning_effort: (caps.supports as any)?.reasoning_effort ?? [],
    };
  });
  return { total: rows.length, models: rows };
}

export function usageData(month: string) {
  const usage = readMonthlyUsage(month);
  if (!usage) {
    return { month, available: availableMonths(), empty: true, totals: null, by_model: [], by_day: [] };
  }
  const by_model = Object.entries(usage.by_model)
    .map(([name, m]) => {
      const est = estimateCost(name, m);
      return { name, ...m, cost: est.cost, priced: est.priced };
    })
    .sort((a, b) => b.requests - a.requests);
  const by_day = Object.entries(usage.by_day)
    .map(([day, d]) => ({ day, ...d }))
    .sort((a, b) => a.day.localeCompare(b.day));
  // Total spend for the month = sum of per-day costs (each already the sum of
  // priced per-model estimates). Equals the by_model cost sum; computed here so
  // the portal can show one headline figure without re-summing client-side.
  const total_cost = by_day.reduce((sum, d) => sum + d.cost, 0);
  return {
    month: usage.month,
    available: availableMonths(),
    empty: false,
    total_requests: usage.total_requests,
    total_cost,
    totals: usage.totals,
    by_model,
    by_day,
  };
}

export function logsData(date: string) {
  const entries = readRequestLogs(date);
  const rows = entries.map((e) => ({
    time: e.timestamp.slice(11, 19),
    status: e.status_code,
    model: e.translated_model ?? e.model,
    endpoint: e.endpoint,
    input: e.input_tokens ?? 0,
    cache_read: e.cache_read_input_tokens ?? 0,
    output: e.output_tokens ?? 0,
    effort: e.effort ?? "",
    duration_ms: e.duration_ms,
    error: e.error ?? null,
  }));
  // JSONL is appended chronologically; reverse so newest requests come first
  // (the portal paginates from the top).
  rows.reverse();
  return { date, available: listLogDates().sort().reverse(), entries: rows };
}

export function webSearchData() {
  const ws = loadConfig().web_search;
  const providers = Object.entries(PROVIDER_META).map(([name, meta]) => {
    const key = ws[meta.keyField] as string;
    return {
      name,
      label: meta.label,
      note: meta.note,
      hasKey: !!key,
      maskedKey: maskKey(key),
    };
  });
  return { enabled: ws.enabled, provider: ws.provider, providers };
}

/**
 * Apply a web-search update from the portal. Persists to config.yaml (comments
 * preserved via updateWebSearchConfig) AND hot-updates the in-memory config so
 * the change takes effect without a restart.
 */
export function applyWebSearch(body: {
  enabled?: boolean;
  provider?: string;
  key?: string;
}): { ok: boolean; error?: string; state?: ReturnType<typeof webSearchData> } {
  const updates: WebSearchUpdate = {};

  if (typeof body.enabled === "boolean") updates.enabled = body.enabled;

  if (body.provider) {
    const meta = PROVIDER_META[body.provider];
    if (!meta) return { ok: false, error: `Unknown provider: ${body.provider}` };
    updates.provider = body.provider as WebSearchUpdate["provider"];
    if (body.key) updates[meta.keyField] = body.key;
  } else if (body.key) {
    const current = loadConfig().web_search.provider;
    const meta = PROVIDER_META[current];
    if (meta) updates[meta.keyField] = body.key;
  }

  // Guard: enabling requires the (target) provider to have a key.
  const targetProvider = (updates.provider ?? loadConfig().web_search.provider) as string;
  const meta = PROVIDER_META[targetProvider];
  const willEnable =
    updates.enabled === true ||
    (updates.enabled === undefined && loadConfig().web_search.enabled);
  if (willEnable && meta) {
    const existingKey = loadConfig().web_search[meta.keyField] as string;
    const keyAfter = (updates[meta.keyField] as string) ?? existingKey;
    if (!keyAfter) {
      return { ok: false, error: `Cannot enable: no API key for "${targetProvider}". Provide one.` };
    }
  }

  updateWebSearchConfig(updates);
  // Hot-reload ONLY the web_search block into the in-memory config so the
  // running proxy picks up the new settings without a restart. We must NOT
  // replace the whole config object — that would clobber runtime overrides
  // like `-p`/`-H` (start.ts mutates config.port/address from CLI flags,
  // which are not persisted to config.yaml).
  getState().config.web_search = loadConfig().web_search;

  return { ok: true, state: webSearchData() };
}

/**
 * Run a live search for the portal's "Test search" panel. Probes whichever
 * provider the user has selected in the UI (defaulting to the saved provider),
 * with an optional unsaved key, without disturbing the running proxy's active
 * provider.
 */
export async function testWebSearch(
  query: string,
  provider?: string,
  key?: string,
): Promise<{
  ok: boolean;
  provider: string;
  query: string;
  count: number;
  results: unknown[];
  error?: string;
}> {
  const prov = (provider && PROVIDER_META[provider] ? provider : loadConfig().web_search.provider) as string;
  const q = (query ?? "").trim();
  if (!q) return { ok: false, provider: prov, query: q, count: 0, results: [], error: "Query is required." };
  try {
    const results = await runWebSearchProbeFor(prov, q, key);
    return { ok: true, provider: prov, query: q, count: results.length, results };
  } catch (err) {
    return { ok: false, provider: prov, query: q, count: 0, results: [], error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Reasoning Effort
// ---------------------------------------------------------------------------

/** Allowed effort values, weakest → strongest. Validation lives here (app layer). */
const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];

export function effortData() {
  return { effort: loadConfig().effort, options: EFFORT_OPTIONS };
}

/**
 * Apply an effort change from the portal. Persists to config.yaml (comments
 * preserved) AND hot-updates the in-memory config so the running proxy picks it
 * up without a restart. Mirrors applyWebSearch: mutate only the single field,
 * never replace the whole config object (that would clobber -p/-H overrides).
 */
export function applyEffort(body: { effort?: string }): {
  ok: boolean;
  error?: string;
  state?: ReturnType<typeof effortData>;
} {
  const value = (body.effort ?? "").toLowerCase();
  if (!EFFORT_OPTIONS.includes(value)) {
    return { ok: false, error: `Invalid effort: "${body.effort}". Allowed: ${EFFORT_OPTIONS.join(", ")}` };
  }
  updateEffortConfig(value);
  getState().config.effort = value;
  return { ok: true, state: effortData() };
}

// ---------------------------------------------------------------------------
// Client Setup
// ---------------------------------------------------------------------------

export type SetupTarget = "claude" | "codex" | "gemini";

interface SetupOpts {
  model?: string;
  /** "proxy" | "aoai" — Codex only */
  codexMode?: string;
  /** AOAI inputs (Codex aoai mode) */
  aoaiBaseUrl?: string;
  aoaiModel?: string;
  aoaiEnvKey?: string;
}

/** Models offered for a given target, filtered like the CLI does. */
function modelsForTarget(target: SetupTarget): { id: string; display: string }[] {
  const { models } = getState();
  const catalog = models?.data ?? [];
  const ids = filterAndSortModels(catalog.map((m) => m.id));
  if (target === "claude") {
    return ids
      .filter((id) => id.startsWith("claude-"))
      .map((id) => ({ id, display: claudeDisplayName(id, catalog) }));
  }
  if (target === "gemini") {
    return ids.filter((id) => id.toLowerCase().startsWith("gemini-")).map((id) => ({ id, display: id }));
  }
  // codex → OpenAI GPT family only
  return ids.filter((id) => id.toLowerCase().startsWith("gpt-")).map((id) => ({ id, display: id }));
}

/** Reasoning-effort support for a model id (Codex), if the catalog reports it. */
function reasoningEffortsFor(modelId: string): string[] | undefined {
  const { models } = getState();
  const m = models?.data?.find((x) => x.id === modelId) as any;
  return m?.capabilities?.supports?.reasoning_effort;
}

/** Standard write locations for a target (WSL + optional Windows). */
function targetsFor(target: SetupTarget) {
  if (target === "claude") return resolveConfigTargets(".claude", "settings.json");
  if (target === "codex") return resolveConfigTargets(".codex", "config.toml");
  return resolveConfigTargets(".gemini", ".env");
}

function buildTomlFor(target: SetupTarget, url: string, opts: SetupOpts): string {
  if (opts.codexMode === "aoai") {
    const aoaiOpts: CodexAoaiOptions = {
      baseUrl: (opts.aoaiBaseUrl ?? "").trim(),
      model: (opts.aoaiModel ?? "gpt-5.3-codex").trim() || "gpt-5.3-codex",
      envKey: (opts.aoaiEnvKey ?? "AZURE_OPENAI_API_KEY").trim() || "AZURE_OPENAI_API_KEY",
    };
    return buildCodexAoaiToml(aoaiOpts);
  }
  const model = opts.model ?? modelsForTarget("codex")[0]?.id ?? "";
  return buildCodexProxyToml(url, model, reasoningEffortsFor(model));
}

/** Metadata + live config preview for the Client Setup page. */
export function setupPreview(target: SetupTarget, opts: SetupOpts) {
  const url = baseUrl();
  const choices = modelsForTarget(target);
  const t = targetsFor(target);

  let content = "";
  let filename = "";
  let language = "";

  if (target === "claude") {
    const model = opts.model ?? choices[0]?.id ?? "";
    const display = claudeDisplayName(model, getState().models?.data ?? []);
    content = JSON.stringify({ env: buildClaudeEnv(url, display) }, null, 2);
    filename = "~/.claude/settings.json";
    language = "json";
  } else if (target === "gemini") {
    const model = opts.model ?? choices[0]?.id ?? "";
    content = Object.entries(buildGeminiEnv(url, model))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    filename = "~/.gemini/.env";
    language = "bash";
  } else {
    content = buildTomlFor("codex", url, opts);
    filename = "~/.codex/config.toml";
    language = "toml";
  }

  return {
    target,
    filename,
    language,
    content,
    models: choices,
    selectedModel: opts.model ?? choices[0]?.id ?? "",
    codexMode: opts.codexMode ?? "proxy",
    locations: { wsl: t.wsl, win: t.win },
  };
}

/**
 * Write the client config to the chosen location(s). `where` is one of
 * "wsl" | "win" | "both". Returns the paths written.
 */
export function applySetup(
  target: SetupTarget,
  opts: SetupOpts & { where?: string },
): { ok: boolean; error?: string; written?: string[] } {
  const url = baseUrl();
  const t = targetsFor(target);
  const where = opts.where ?? "both";

  const paths: string[] = [];
  if ((where === "wsl" || where === "both") && t.wsl) paths.push(t.wsl);
  if ((where === "win" || where === "both") && t.win) paths.push(t.win);
  if (paths.length === 0) return { ok: false, error: "No target location available." };

  try {
    if (target === "claude") {
      const model = opts.model ?? modelsForTarget("claude")[0]?.id ?? "";
      const display = claudeDisplayName(model, getState().models?.data ?? []);
      return { ok: true, written: writeClaudeConfig(url, display, paths) };
    }
    if (target === "gemini") {
      const model = opts.model ?? modelsForTarget("gemini")[0]?.id ?? "";
      return { ok: true, written: writeGeminiConfig(url, model, paths) };
    }
    // codex
    if (opts.codexMode === "aoai" && !(opts.aoaiBaseUrl ?? "").trim()) {
      return { ok: false, error: "Azure OpenAI base URL is required." };
    }
    const toml = buildTomlFor("codex", url, opts);
    return { ok: true, written: writeCodexConfig(toml, paths) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
