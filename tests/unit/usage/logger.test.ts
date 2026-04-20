import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Usage Logger", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `copilot-proxy-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
  });

  test("JSONL format is correct", () => {
    const logDir = join(tempDir, "requests");
    mkdirSync(logDir, { recursive: true });
    const entry = {
      timestamp: "2026-04-17T10:30:00Z",
      request_id: "test-123",
      model: "claude-opus-4-6[1m]",
      translated_model: "claude-opus-4.6-1m",
      endpoint: "/v1/messages",
      input_tokens: 1500,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 200,
      duration_ms: 3200,
      status_code: 200,
      error: null,
    };
    const logPath = join(logDir, "2026-04-17.jsonl");
    appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");

    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.request_id).toBe("test-123");
    expect(parsed.input_tokens).toBe(1500);
    expect(parsed.translated_model).toBe("claude-opus-4.6-1m");
  });

  test("multiple entries append to same file", () => {
    const logDir = join(tempDir, "requests");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "2026-04-17.jsonl");

    appendFileSync(logPath, JSON.stringify({ request_id: "r1", input_tokens: 100 }) + "\n");
    appendFileSync(logPath, JSON.stringify({ request_id: "r2", input_tokens: 200 }) + "\n");

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).request_id).toBe("r1");
    expect(JSON.parse(lines[1]).request_id).toBe("r2");
  });

  test("monthly usage accumulation", () => {
    const usageDir = join(tempDir, "usage");
    mkdirSync(usageDir, { recursive: true });
    const usagePath = join(usageDir, "2026-04.json");

    function updateMonthly(entry: any) {
      let usage: any;
      if (existsSync(usagePath)) {
        usage = JSON.parse(readFileSync(usagePath, "utf-8"));
      } else {
        usage = {
          month: "2026-04", total_requests: 0, total_input_tokens: 0,
          total_output_tokens: 0, total_cache_creation_tokens: 0,
          total_cache_read_tokens: 0, by_model: {}, by_day: {},
        };
      }
      usage.total_requests++;
      usage.total_input_tokens += entry.input_tokens;
      usage.total_output_tokens += entry.output_tokens;

      const model = entry.translated_model ?? entry.model;
      if (!usage.by_model[model]) {
        usage.by_model[model] = { requests: 0, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 };
      }
      usage.by_model[model].requests++;
      usage.by_model[model].input_tokens += entry.input_tokens;
      usage.by_model[model].output_tokens += entry.output_tokens;

      const day = entry.timestamp.slice(0, 10);
      if (!usage.by_day[day]) {
        usage.by_day[day] = { requests: 0, input_tokens: 0, output_tokens: 0 };
      }
      usage.by_day[day].requests++;
      usage.by_day[day].input_tokens += entry.input_tokens;
      usage.by_day[day].output_tokens += entry.output_tokens;

      writeFileSync(usagePath, JSON.stringify(usage, null, 2), "utf-8");
    }

    updateMonthly({ timestamp: "2026-04-17T10:00:00Z", model: "test", translated_model: "model-a", input_tokens: 100, output_tokens: 50 });
    updateMonthly({ timestamp: "2026-04-17T11:00:00Z", model: "test", translated_model: "model-a", input_tokens: 200, output_tokens: 100 });
    updateMonthly({ timestamp: "2026-04-18T09:00:00Z", model: "test", translated_model: "model-b", input_tokens: 300, output_tokens: 150 });

    const usage = JSON.parse(readFileSync(usagePath, "utf-8"));
    expect(usage.total_requests).toBe(3);
    expect(usage.total_input_tokens).toBe(600);
    expect(usage.total_output_tokens).toBe(300);
    expect(usage.by_model["model-a"].requests).toBe(2);
    expect(usage.by_model["model-a"].input_tokens).toBe(300);
    expect(usage.by_model["model-b"].requests).toBe(1);
    expect(usage.by_day["2026-04-17"].requests).toBe(2);
    expect(usage.by_day["2026-04-18"].requests).toBe(1);
  });

  test("readRequestLogs returns empty for missing date", async () => {
    const { readRequestLogs } = await import("../../../src/usage/logger");
    const logs = readRequestLogs("2099-01-01");
    expect(logs).toEqual([]);
  });

  test("readMonthlyUsage returns null for missing month", async () => {
    const { readMonthlyUsage } = await import("../../../src/usage/logger");
    expect(readMonthlyUsage("2099-01")).toBeNull();
  });
});
