import { getState } from "../auth/state";
import {
  loadConfig,
  updateWebSearchConfig,
  updateEffortConfig,
  updateModelMappings,
  renderMappingsBlock,
  readConfigFileText,
  writeConfigFileText,
  getConfigPath,
} from "../config/loader";
import type { WebSearchUpdate } from "../config/loader";
import type { ModelMappingsConfig } from "../config/schema";
import { DEFAULT_MODEL_MAPPINGS } from "../config/schema";
import yaml from "js-yaml";
import { runWebSearchProbeFor } from "../proxy/web-search";
import {
  readMonthlyUsage,
  readRequestLogs,
  listLogDates,
} from "../usage/logger";
import { lookupPrice } from "../usage/pricing";
import {
  buildClaudeEnv,
  buildGeminiEnv,
  buildCodexProxyToml,
  buildCodexAoaiToml,
  claudeDisplayName,
  claudeCodeModelList,
  filterAndSortModels,
  pickBestModel,
  resolveConfigTargets,
  writeClaudeConfig,
  writeCodexConfig,
  writeGeminiConfig,
  type CodexAoaiOptions,
} from "../cli/config";
import {
  CODEX_CATALOG_FILENAME,
  buildCodexCatalogForCopilot,
  type CodexModelCatalog,
} from "../cli/codex-catalog";
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
  const { config, models, github_token, copilot_token, token_expires_at } = getState();
  const data = models?.data ?? [];
  const anthropicCount = data.filter((m) =>
    (m.supported_endpoints ?? []).includes("/v1/messages"),
  ).length;

  const today = readRequestLogs(todayStr());
  const errorsToday = today.filter((e) => e.status_code >= 400 || e.error).length;

  const nowSec = Date.now() / 1000;
  // Auth is healthy as long as we have a GitHub token: the short-lived Copilot
  // token is auto-refreshed from it on demand, so an expired Copilot token is
  // NOT a problem and must not nag the user to log in. Only a missing GitHub
  // token actually requires `copilot-proxy login`.
  const authReady = !!github_token;
  const copilotValid = !!copilot_token && nowSec < token_expires_at;
  const expiresInMin = copilotValid ? Math.max(0, Math.round((token_expires_at - nowSec) / 60)) : 0;

  const month = readMonthlyUsage(monthStr());
  const ws = config.web_search;

  return {
    server: { address: config.address, port: config.port, online: true },
    version: VERSION,
    token: { ready: authReady, copilotValid, expiresInMin },
    models: { total: data.length, anthropic: anthropicCount },
    requestsToday: { total: today.length, errors: errorsToday },
    environment: {
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
      // m.cost is already the sum of per-request estimates; re-pricing the
      // aggregated tokens here would mis-tier long-context models.
      return { name, ...m, priced: lookupPrice(name) !== null };
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
// Model Name Mappings
// ---------------------------------------------------------------------------

/**
 * Expose the current model mappings as an editable YAML document (the
 * `exact:`/`prefix:` block) so the portal can show one text area the user edits
 * directly. Saving writes it straight back into config.yaml.
 */
export function modelMappingsData() {
  const { model_mappings } = loadConfig();
  return {
    content: renderMappingsBlock(model_mappings),
    defaults: renderMappingsBlock(DEFAULT_MODEL_MAPPINGS),
    config_path: getConfigPath(),
  };
}

/**
 * Validate a submitted mappings document against the
 * `{ exact: {str:str}, prefix: {str:str} }` shape. Returns the parsed tables on
 * success or a human-readable error string on failure.
 */
function parseMappings(content: string): { ok: true; mappings: ModelMappingsConfig } | { ok: false; error: string } {
  let doc: unknown;
  try {
    doc = yaml.load(content);
  } catch (err) {
    return { ok: false, error: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  // An empty document is a valid "clear everything" intent.
  if (doc == null) return { ok: true, mappings: { exact: {}, prefix: {} } };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "Expected a mapping with optional `exact:` and `prefix:` sections." };
  }

  const validateSection = (name: "exact" | "prefix", raw: unknown): Record<string, string> | string => {
    if (raw == null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) return `\`${name}\` must be a map of name: value pairs.`;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== "string") return `\`${name}.${k}\` must be a string (got ${typeof v}).`;
      out[k] = v;
    }
    return out;
  };

  const d = doc as Record<string, unknown>;
  const extraKeys = Object.keys(d).filter((k) => k !== "exact" && k !== "prefix");
  if (extraKeys.length > 0) {
    return { ok: false, error: `Unknown section(s): ${extraKeys.join(", ")}. Only \`exact:\` and \`prefix:\` are allowed.` };
  }
  const exact = validateSection("exact", d.exact);
  if (typeof exact === "string") return { ok: false, error: exact };
  const prefix = validateSection("prefix", d.prefix);
  if (typeof prefix === "string") return { ok: false, error: prefix };

  return { ok: true, mappings: { exact, prefix } };
}

/**
 * Persist edited model mappings from the portal. Validates the submitted YAML,
 * writes it back into config.yaml (comments preserved via updateModelMappings)
 * AND hot-updates the in-memory config so translation picks it up without a
 * restart. Mirrors applyEffort/applyWebSearch: mutate only model_mappings, never
 * replace the whole config object (that would clobber -p/-H overrides).
 */
export function applyModelMappings(body: { content?: string }): {
  ok: boolean;
  error?: string;
  state?: ReturnType<typeof modelMappingsData>;
} {
  const parsed = parseMappings(body.content ?? "");
  if (!parsed.ok) return { ok: false, error: parsed.error };

  updateModelMappings(parsed.mappings);
  getState().config.model_mappings = loadConfig().model_mappings;
  return { ok: true, state: modelMappingsData() };
}

// ---------------------------------------------------------------------------
// Whole-file config editor
// ---------------------------------------------------------------------------

/** Raw config.yaml text + its path, for the portal's full-file editor. */
export function configFileData() {
  return {
    content: readConfigFileText(),
    config_path: getConfigPath(),
  };
}

/**
 * Save raw config.yaml text from the portal. Validation is intentionally light:
 * the content must parse as a YAML mapping (so we never persist a syntactically
 * broken file). Field-level semantics are NOT validated here — loadConfig
 * tolerates missing/odd fields by filling from DEFAULT_CONFIG, and invalid
 * values surface at use time.
 *
 * After writing, the hot-reloadable fields are pushed into the in-memory config
 * so changes take effect without a restart. port/address are deliberately NOT
 * hot-applied: the server is already bound to a socket and may carry -p/-H
 * runtime overrides, so those need a restart (the portal warns about this).
 */
export function applyConfigFile(body: { content?: string }): {
  ok: boolean;
  error?: string;
  state?: ReturnType<typeof configFileData>;
  note?: string;
} {
  const content = body.content ?? "";
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (err) {
    return { ok: false, error: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed != null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    return { ok: false, error: "Config must be a YAML mapping (key: value pairs)." };
  }

  writeConfigFileText(content);

  // Hot-reload the fields the running proxy can pick up live, mirroring the
  // single-field apply* helpers. Never replace the whole config object (that
  // would clobber -p/-H runtime overrides on port/address).
  const fresh = loadConfig();
  const live = getState().config;
  live.effort = fresh.effort;
  live.web_search = fresh.web_search;
  live.model_mappings = fresh.model_mappings;
  live.max_connection_retries = fresh.max_connection_retries;

  // Detect whether port/address on disk now differ from what's running, to warn
  // the user a restart is needed for those.
  const portChanged = fresh.port !== live.port;
  const addressChanged = fresh.address !== live.address;
  const note =
    portChanged || addressChanged
      ? "Saved. Note: port/address changes take effect after a restart."
      : undefined;

  return { ok: true, state: configFileData(), note };
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

/** Models offered for a given target, filtered like the CLI does. The strongest
 * model for the family is moved to the front so it becomes the default
 * selection (choices[0]). */
function modelsForTarget(target: SetupTarget): { id: string; display: string }[] {
  const { models } = getState();
  const catalog = models?.data ?? [];
  const ids = filterAndSortModels(catalog.map((m) => m.id));

  // Claude Code offers Claude + GPT models it can run on; the shared
  // claudeCodeModelList helper filters and hoists the strongest Opus to index 0.
  if (target === "claude") {
    return claudeCodeModelList(ids, catalog).map((id) => ({
      id,
      display: claudeDisplayName(id, catalog),
    }));
  }

  const family = target === "gemini" ? "gemini" : "gpt";
  const prefix = target === "gemini" ? "gemini-" : "gpt-";
  let familyIds = ids.filter((id) => id.toLowerCase().startsWith(prefix));

  // Surface the strongest model first (defaults to choices[0] in the UI).
  const best = pickBestModel(family, familyIds);
  if (best) familyIds = [best, ...familyIds.filter((id) => id !== best)];

  return familyIds.map((id) => ({ id, display: id }));
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

interface CodexSetupArtifacts {
  toml: string;
  modelCatalog?: CodexModelCatalog;
  clearGeneratedModelCatalog?: boolean;
}

function buildCodexSetupArtifacts(url: string, opts: SetupOpts): CodexSetupArtifacts {
  if (opts.codexMode === "aoai") {
    const aoaiOpts: CodexAoaiOptions = {
      baseUrl: (opts.aoaiBaseUrl ?? "").trim(),
      model: (opts.aoaiModel ?? "gpt-5.3-codex").trim() || "gpt-5.3-codex",
      envKey: (opts.aoaiEnvKey ?? "AZURE_OPENAI_API_KEY").trim() || "AZURE_OPENAI_API_KEY",
    };
    return {
      toml: buildCodexAoaiToml(aoaiOpts),
      clearGeneratedModelCatalog: true,
    };
  }
  const model = opts.model ?? modelsForTarget("codex")[0]?.id ?? "";
  try {
    const patched = buildCodexCatalogForCopilot(
      getState().models?.data ?? [],
      model,
    );
    return {
      toml: buildCodexProxyToml(
        url,
        model,
        reasoningEffortsFor(model),
        CODEX_CATALOG_FILENAME,
      ),
      modelCatalog: patched.catalog,
    };
  } catch {
    return { toml: buildCodexProxyToml(url, model, reasoningEffortsFor(model)) };
  }
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
    content = buildCodexSetupArtifacts(url, opts).toml;
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
    const artifacts = buildCodexSetupArtifacts(url, opts);
    return {
      ok: true,
      written: writeCodexConfig(
        artifacts.toml,
        paths,
        artifacts.modelCatalog,
        artifacts.clearGeneratedModelCatalog,
      ),
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
