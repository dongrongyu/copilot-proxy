import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../config/loader";
import { estimateCost } from "./pricing";

export type Provider = "anthropic" | "openai" | "gemini";

/**
 * Per-request usage record. The 5 token categories are mutually exclusive:
 *   total_processed_input  = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *   total_produced_output  = output_tokens + reasoning_tokens
 *
 * Provider-specific extraction rules:
 *   - Anthropic: input_tokens / cache_* fields come straight from usage.* (already disjoint).
 *                reasoning_tokens stays 0 because Anthropic does not report thinking
 *                separately; thinking remains rolled into output_tokens.
 *   - OpenAI:    input_tokens = prompt_tokens - cached_tokens (cached split out).
 *                cache_creation_input_tokens = 0 (no equivalent concept).
 *                cache_read_input_tokens = prompt_tokens_details.cached_tokens.
 *                reasoning_tokens = completion_tokens_details.reasoning_tokens.
 *                output_tokens = completion_tokens - reasoning_tokens.
 *   - Gemini:    routed through OpenAI translation; same rules as OpenAI.
 */
export interface RequestLogEntry {
  timestamp: string;
  request_id: string;
  model: string;
  translated_model: string | null;
  endpoint: string;
  provider: Provider;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  /**
   * Reasoning effort actually sent upstream (e.g. "max", "xhigh", "high").
   * Empty string when the request did not carry a forwarded effort parameter.
   */
  effort: string;
  duration_ms: number;
  status_code: number;
  error: string | null;
}

interface CategoryTotals {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
}

interface MonthlyUsage {
  month: string;
  total_requests: number;
  totals: CategoryTotals;
  by_model: Record<string, CategoryTotals & { requests: number }>;
  // by_day carries a `cost` accumulated per-entry (sum of priced per-model
  // estimates) so the portal's daily cost line reflects real spend rather than
  // pricing a date string (which never matches a model).
  by_day: Record<string, CategoryTotals & { requests: number; cost: number }>;
}

function getRequestLogDir(): string {
  return join(getConfigDir(), "logs", "requests");
}

/**
 * Append a completed request to the daily JSONL file. Aggregation is computed
 * on demand from JSONL by readMonthlyUsage(); the hot path here only does one
 * synchronous append.
 */
export function logRequest(entry: RequestLogEntry): void {
  try {
    const logDir = getRequestLogDir();
    mkdirSync(logDir, { recursive: true });
    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    const logPath = join(logDir, `${date}.jsonl`);
    appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error(`[Usage] Failed to log request: ${err}`);
  }
}

function emptyCategoryTotals(): CategoryTotals {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
  };
}

function addEntryTo(target: CategoryTotals, entry: RequestLogEntry): void {
  // Coerce missing fields to 0 — legacy JSONL entries written before the
  // 5-category schema may not have cache_*/reasoning_tokens fields.
  target.input_tokens += entry.input_tokens ?? 0;
  target.cache_creation_input_tokens += entry.cache_creation_input_tokens ?? 0;
  target.cache_read_input_tokens += entry.cache_read_input_tokens ?? 0;
  target.output_tokens += entry.output_tokens ?? 0;
  target.reasoning_tokens += entry.reasoning_tokens ?? 0;
}

/**
 * Read request logs for a specific date.
 */
export function readRequestLogs(date: string): RequestLogEntry[] {
  const logPath = join(getRequestLogDir(), `${date}.jsonl`);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Aggregate monthly usage on demand by scanning JSONL files for the given
 * month. Returns null when no JSONL file matches (e.g. month is older than
 * retention or has no traffic).
 */
export function readMonthlyUsage(month: string): MonthlyUsage | null {
  const logDir = getRequestLogDir();
  if (!existsSync(logDir)) return null;

  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(".jsonl") && f.startsWith(`${month}-`))
    .sort();

  if (files.length === 0) return null;

  const usage: MonthlyUsage = {
    month,
    total_requests: 0,
    totals: emptyCategoryTotals(),
    by_model: {},
    by_day: {},
  };

  for (const file of files) {
    const day = file.replace(".jsonl", "");
    const lines = readFileSync(join(logDir, file), "utf-8").split("\n");
    for (const line of lines) {
      if (!line) continue;
      let entry: RequestLogEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const model = entry.translated_model ?? entry.model;

      usage.total_requests++;
      addEntryTo(usage.totals, entry);

      if (!usage.by_model[model]) {
        usage.by_model[model] = { requests: 0, ...emptyCategoryTotals() };
      }
      const m = usage.by_model[model];
      m.requests++;
      addEntryTo(m, entry);

      if (!usage.by_day[day]) {
        usage.by_day[day] = { requests: 0, cost: 0, ...emptyCategoryTotals() };
      }
      const d = usage.by_day[day];
      d.requests++;
      addEntryTo(d, entry);
      // Price a coerced bundle (legacy JSONL entries may lack cache_*/reasoning
      // fields; estimateCost on undefined would yield NaN).
      d.cost += estimateCost(model, {
        input_tokens: entry.input_tokens ?? 0,
        cache_creation_input_tokens: entry.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: entry.cache_read_input_tokens ?? 0,
        output_tokens: entry.output_tokens ?? 0,
        reasoning_tokens: entry.reasoning_tokens ?? 0,
      }).cost;
    }
  }

  return usage;
}

/**
 * List available log dates.
 */
export function listLogDates(): string[] {
  const logDir = getRequestLogDir();
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(".jsonl", ""))
    .sort();
}

/**
 * Clean up JSONL request logs older than retentionDays.
 * Aggregates are recomputed on demand from JSONL, so anything older than the
 * retention window will simply not appear in `usage` reports anymore.
 * Returns number of files deleted.
 */
export function cleanupOldLogs(retentionDays = 180): number {
  const logDir = getRequestLogDir();
  if (!existsSync(logDir)) return 0;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let deleted = 0;
  for (const file of readdirSync(logDir)) {
    if (!file.endsWith(".jsonl")) continue;
    const date = file.replace(".jsonl", "");
    if (date < cutoffStr) {
      try {
        unlinkSync(join(logDir, file));
        deleted++;
      } catch {}
    }
  }

  if (deleted > 0) {
    console.log(`[Usage] Cleaned up ${deleted} log file(s) older than ${retentionDays} days`);
  }
  return deleted;
}
