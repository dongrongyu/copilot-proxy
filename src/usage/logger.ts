import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../config/loader";

export interface RequestLogEntry {
  timestamp: string;
  request_id: string;
  model: string;
  translated_model: string | null;
  endpoint: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  duration_ms: number;
  status_code: number;
  error: string | null;
}

interface MonthlyUsage {
  month: string;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  by_model: Record<string, {
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
  }>;
  by_day: Record<string, {
    requests: number;
    input_tokens: number;
    output_tokens: number;
  }>;
}

function getRequestLogDir(): string {
  return join(getConfigDir(), "logs", "requests");
}

function getUsageDir(): string {
  return join(getConfigDir(), "logs", "usage");
}

/**
 * Log a completed request to JSONL file and update monthly usage (async, non-blocking).
 */
export function logRequest(entry: RequestLogEntry): void {
  try {
    // Append to daily JSONL
    const logDir = getRequestLogDir();
    mkdirSync(logDir, { recursive: true });
    const date = entry.timestamp.slice(0, 10); // YYYY-MM-DD
    const logPath = join(logDir, `${date}.jsonl`);
    appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");

    // Update monthly usage asynchronously to avoid blocking the response
    queueMicrotask(() => {
      try {
        updateMonthlyUsage(entry);
      } catch (err) {
        console.error(`[Usage] Failed to update monthly usage: ${err}`);
      }
    });
  } catch (err) {
    console.error(`[Usage] Failed to log request: ${err}`);
  }
}

function updateMonthlyUsage(entry: RequestLogEntry): void {
  const usageDir = getUsageDir();
  mkdirSync(usageDir, { recursive: true });

  const month = entry.timestamp.slice(0, 7); // YYYY-MM
  const day = entry.timestamp.slice(0, 10);   // YYYY-MM-DD
  const usagePath = join(usageDir, `${month}.json`);
  const model = entry.translated_model ?? entry.model;

  let usage: MonthlyUsage;
  if (existsSync(usagePath)) {
    try {
      usage = JSON.parse(readFileSync(usagePath, "utf-8"));
    } catch {
      usage = createEmptyMonthlyUsage(month);
    }
  } else {
    usage = createEmptyMonthlyUsage(month);
  }

  // Update totals
  usage.total_requests++;
  usage.total_input_tokens += entry.input_tokens;
  usage.total_output_tokens += entry.output_tokens;
  usage.total_cache_creation_tokens += entry.cache_creation_input_tokens;
  usage.total_cache_read_tokens += entry.cache_read_input_tokens;

  // Update by_model
  if (!usage.by_model[model]) {
    usage.by_model[model] = {
      requests: 0, input_tokens: 0, output_tokens: 0,
      cache_creation_tokens: 0, cache_read_tokens: 0,
    };
  }
  const m = usage.by_model[model];
  m.requests++;
  m.input_tokens += entry.input_tokens;
  m.output_tokens += entry.output_tokens;
  m.cache_creation_tokens += entry.cache_creation_input_tokens;
  m.cache_read_tokens += entry.cache_read_input_tokens;

  // Update by_day
  if (!usage.by_day[day]) {
    usage.by_day[day] = { requests: 0, input_tokens: 0, output_tokens: 0 };
  }
  const d = usage.by_day[day];
  d.requests++;
  d.input_tokens += entry.input_tokens;
  d.output_tokens += entry.output_tokens;

  writeFileSync(usagePath, JSON.stringify(usage, null, 2), "utf-8");
}

function createEmptyMonthlyUsage(month: string): MonthlyUsage {
  return {
    month,
    total_requests: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_creation_tokens: 0,
    total_cache_read_tokens: 0,
    by_model: {},
    by_day: {},
  };
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
 * Read monthly usage for a specific month.
 */
export function readMonthlyUsage(month: string): MonthlyUsage | null {
  const usagePath = join(getUsageDir(), `${month}.json`);
  if (!existsSync(usagePath)) return null;
  try {
    return JSON.parse(readFileSync(usagePath, "utf-8"));
  } catch {
    return null;
  }
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
 * Monthly usage JSON files are kept permanently (small).
 * Returns number of files deleted.
 */
export function cleanupOldLogs(retentionDays = 30): number {
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
