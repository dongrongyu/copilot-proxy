import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { initState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import { logRequest, readRequestLogs, readMonthlyUsage, listLogDates } from "../../../src/usage/logger";
import type { RequestLogEntry } from "../../../src/usage/logger";

describe("Usage Logger - Integration", () => {
  // These tests use the real logRequest function which writes to ~/.copilot-proxy/
  // We verify by reading back from the real location

  beforeEach(() => {
    initState({ ...DEFAULT_CONFIG });
  });

  test("logRequest writes entry and updates monthly", () => {
    const entry: RequestLogEntry = {
      timestamp: new Date().toISOString(),
      request_id: `ut-test-${Date.now()}`,
      model: "ut-test-model",
      translated_model: "ut-test-translated",
      endpoint: "/v1/messages",
      provider: "anthropic",
      input_tokens: 42,
      output_tokens: 13,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 10,
      reasoning_tokens: 0,
      effort: "max",
      duration_ms: 100,
      status_code: 200,
      error: null,
    };

    // Should not throw
    logRequest(entry);

    // Verify we can read it back
    const today = new Date().toISOString().slice(0, 10);
    const logs = readRequestLogs(today);
    const found = logs.find((l) => l.request_id === entry.request_id);
    expect(found).toBeDefined();
    expect(found!.model).toBe("ut-test-model");
    expect(found!.input_tokens).toBe(42);
    // effort persists round-trip through the JSONL log
    expect(found!.effort).toBe("max");
  });

  test("logRequest with error field", () => {
    const entry: RequestLogEntry = {
      timestamp: new Date().toISOString(),
      request_id: `ut-err-${Date.now()}`,
      model: "ut-error-model",
      translated_model: null,
      endpoint: "/v1/messages",
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      duration_ms: 50,
      status_code: 500,
      error: "test error message",
    };

    logRequest(entry);

    const today = new Date().toISOString().slice(0, 10);
    const logs = readRequestLogs(today);
    const found = logs.find((l) => l.request_id === entry.request_id);
    expect(found).toBeDefined();
    expect(found!.error).toBe("test error message");
    expect(found!.status_code).toBe(500);
  });

  test("readMonthlyUsage returns data for current month", () => {
    const month = new Date().toISOString().slice(0, 7);
    const usage = readMonthlyUsage(month);
    // Should exist after logRequest calls above
    if (usage) {
      expect(usage.month).toBe(month);
      expect(usage.total_requests).toBeGreaterThan(0);
      expect(usage.by_model).toBeDefined();
      expect(usage.by_day).toBeDefined();
    }
  });

  test("listLogDates returns array", () => {
    const dates = listLogDates();
    expect(Array.isArray(dates)).toBe(true);
  });

  test("by_day carries a real per-model cost (priced models contribute)", () => {
    // claude-opus-4.8 is in the price table → this entry has nonzero cost.
    const entry: RequestLogEntry = {
      timestamp: new Date().toISOString(),
      request_id: `ut-cost-${Date.now()}`,
      model: "claude-opus-4.8",
      translated_model: "claude-opus-4.8",
      endpoint: "/v1/messages",
      input_tokens: 1_000_000, // 1M input @ $5/M = $5
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      duration_ms: 100,
      status_code: 200,
      error: null,
    };
    logRequest(entry);

    const month = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);
    const usage = readMonthlyUsage(month);
    expect(usage).not.toBeNull();
    const day = usage!.by_day[today];
    expect(day).toBeDefined();
    // cost field exists and reflects priced spend (≥ the $5 from this entry).
    expect(typeof day!.cost).toBe("number");
    expect(day!.cost).toBeGreaterThanOrEqual(5);
  });
});
