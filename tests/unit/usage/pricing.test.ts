import { describe, expect, test } from "bun:test";
import { estimateCost, formatUsd, lookupPrice } from "../../../src/usage/pricing";

describe("pricing", () => {
  describe("lookupPrice", () => {
    test("returns price for exact match (claude-opus-4.8)", () => {
      const p = lookupPrice("claude-opus-4.8");
      expect(p?.input).toBe(15);
      expect(p?.output).toBe(75);
    });

    test("strips [1m] suffix before lookup", () => {
      expect(lookupPrice("claude-opus-4.8[1m]")?.input).toBe(15);
    });

    test("falls back to base via prefix (claude-opus-4.7-xhigh -> 4.7)", () => {
      expect(lookupPrice("claude-opus-4.7-xhigh")?.input).toBe(15);
      expect(lookupPrice("claude-opus-4.7-1m-internal")?.input).toBe(15);
    });

    test("gpt-5 family prefix fallback", () => {
      expect(lookupPrice("gpt-5-some-variant")?.output).toBe(10);
    });

    test("returns null for unknown model", () => {
      expect(lookupPrice("totally-made-up-model")).toBeNull();
    });

    test("normalizes dashed Claude-Code form (claude-opus-4-8 -> 4.8)", () => {
      expect(lookupPrice("claude-opus-4-8")?.input).toBe(15);
      expect(lookupPrice("claude-opus-4-8-1m")?.input).toBe(15);
      expect(lookupPrice("claude-haiku-4-5")?.input).toBe(1);
    });
  });

  describe("estimateCost", () => {
    const zero = {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
    };

    test("priced=false for unknown model", () => {
      const r = estimateCost("nope", { ...zero, input_tokens: 1_000_000 });
      expect(r.priced).toBe(false);
      expect(r.cost).toBe(0);
    });

    test("1M input + 1M output at opus-4.8 list price = $90", () => {
      const r = estimateCost("claude-opus-4.8", {
        ...zero,
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      });
      expect(r.priced).toBe(true);
      expect(r.cost).toBeCloseTo(15 + 75, 5);
    });

    test("cache read priced lower than fresh input (opus 4.8: $1.50 vs $15)", () => {
      const fresh = estimateCost("claude-opus-4.8", { ...zero, input_tokens: 1_000_000 });
      const cached = estimateCost("claude-opus-4.8", { ...zero, cache_read_input_tokens: 1_000_000 });
      expect(cached.cost).toBeLessThan(fresh.cost);
      expect(cached.cost).toBeCloseTo(1.5, 5);
    });

    test("reasoning_tokens billed at output rate", () => {
      const r = estimateCost("gpt-5", {
        ...zero,
        reasoning_tokens: 1_000_000,
      });
      expect(r.cost).toBeCloseTo(10, 5);
    });

    test("cache_creation billed at write rate (opus 4.8: $18.75/MTok)", () => {
      const r = estimateCost("claude-opus-4.8", {
        ...zero,
        cache_creation_input_tokens: 1_000_000,
      });
      expect(r.cost).toBeCloseTo(18.75, 5);
    });

    test("small token counts produce small costs", () => {
      const r = estimateCost("claude-opus-4.8", {
        ...zero,
        input_tokens: 1000,
        output_tokens: 500,
      });
      // 1000 * 15/1M + 500 * 75/1M = 0.015 + 0.0375 = 0.0525
      expect(r.cost).toBeCloseTo(0.0525, 5);
    });
  });

  describe("formatUsd", () => {
    test("zero", () => {
      expect(formatUsd(0)).toBe("$0.00");
    });
    test("sub-cent shows 4 decimals", () => {
      expect(formatUsd(0.0042)).toBe("$0.0042");
    });
    test("sub-dollar shows 3 decimals", () => {
      expect(formatUsd(0.523)).toBe("$0.523");
    });
    test("dollar amounts show 2 decimals", () => {
      expect(formatUsd(12.345)).toBe("$12.35");
      expect(formatUsd(1234.5)).toBe("$1234.50");
    });
  });
});
