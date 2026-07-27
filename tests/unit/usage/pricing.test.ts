import { describe, expect, test } from "bun:test";
import { estimateCost, formatUsd, lookupPrice } from "../../../src/usage/pricing";

describe("pricing", () => {
  describe("lookupPrice", () => {
    test("returns price for exact match (claude-opus-4.8)", () => {
      const p = lookupPrice("claude-opus-4.8");
      expect(p?.input).toBe(5);
      expect(p?.output).toBe(25);
    });

    test("strips [1m] suffix before lookup", () => {
      expect(lookupPrice("claude-opus-4.8[1m]")?.input).toBe(5);
    });

    test("falls back to base via prefix (claude-opus-4.7-xhigh -> 4.7)", () => {
      expect(lookupPrice("claude-opus-4.7-xhigh")?.input).toBe(5);
      expect(lookupPrice("claude-opus-4.7-1m-internal")?.input).toBe(5);
    });

    test("gpt-5.4 family prefix fallback", () => {
      expect(lookupPrice("gpt-5.4-some-variant")?.output).toBe(15);
      expect(lookupPrice("gpt-5.4-mini-2026-05")?.output).toBe(4.5);
    });

    test("returns null for unknown model", () => {
      expect(lookupPrice("totally-made-up-model")).toBeNull();
    });

    test("normalizes dashed Claude-Code form (claude-opus-4-8 -> 4.8)", () => {
      expect(lookupPrice("claude-opus-4-8")?.input).toBe(5);
      expect(lookupPrice("claude-opus-4-8-1m")?.input).toBe(5);
      expect(lookupPrice("claude-haiku-4-5")?.input).toBe(1);
    });

    test("single-component names survive normalization (claude-opus-5-1m)", () => {
      // Without the lookahead in normalizeName this became "claude-opus-5.1m"
      // and priced as null.
      expect(lookupPrice("claude-opus-5")?.input).toBe(5);
      expect(lookupPrice("claude-opus-5-1m")?.input).toBe(5);
      expect(lookupPrice("claude-sonnet-5-xhigh")?.input).toBe(2);
    });

    test("new models from the 2026-07 pricing page", () => {
      expect(lookupPrice("claude-opus-5")).toEqual({
        input: 5, cached_read: 0.5, cache_write: 6.25, output: 25,
      });
      // Promotional rates through 2026-08-31.
      expect(lookupPrice("claude-sonnet-5")).toEqual({
        input: 2, cached_read: 0.2, cache_write: 2.5, output: 10,
      });
      expect(lookupPrice("gemini-3.6-flash")?.output).toBe(7.5);
      expect(lookupPrice("gpt-5.6-luna")?.input).toBe(1);
      expect(lookupPrice("gpt-5.6-sol")?.input).toBe(5);
      expect(lookupPrice("gpt-5.6-terra")?.input).toBe(2.5);
    });

    test("catalog ids that previously priced as null now resolve", () => {
      // Both are live ids in the Copilot /models catalog.
      expect(lookupPrice("gemini-3-flash-preview")?.input).toBe(0.5);
      expect(lookupPrice("mai-code-1-flash-picker")?.input).toBe(0.75);
    });

    test("fast-mode prefix wins over the plain opus-4.8 prefix", () => {
      // Ordering guard: a "claude-opus-4.8-" match would bill fast mode at half.
      expect(lookupPrice("claude-opus-4.8-fast")?.input).toBe(10);
      expect(lookupPrice("claude-opus-4.8-fast-preview")?.input).toBe(10);
      expect(lookupPrice("claude-opus-4.8-xhigh")?.input).toBe(5);
    });

    test("Anthropic models carry no long-context tier", () => {
      for (const id of ["claude-opus-4.8", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4.5"]) {
        expect(lookupPrice(id)?.long_context).toBeUndefined();
      }
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

    test("1M input + 1M output at opus-4.8 list price = $30", () => {
      const r = estimateCost("claude-opus-4.8", {
        ...zero,
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      });
      expect(r.priced).toBe(true);
      expect(r.cost).toBeCloseTo(5 + 25, 5);
    });

    test("cache read priced lower than fresh input (opus 4.8: $0.50 vs $5)", () => {
      const fresh = estimateCost("claude-opus-4.8", { ...zero, input_tokens: 1_000_000 });
      const cached = estimateCost("claude-opus-4.8", { ...zero, cache_read_input_tokens: 1_000_000 });
      expect(cached.cost).toBeLessThan(fresh.cost);
      expect(cached.cost).toBeCloseTo(0.5, 5);
    });

    test("reasoning_tokens billed at output rate", () => {
      const r = estimateCost("gpt-5.4", {
        ...zero,
        reasoning_tokens: 1_000_000,
      });
      expect(r.cost).toBeCloseTo(15, 5);
    });

    test("cache_creation billed at write rate (opus 4.8: $6.25/MTok)", () => {
      const r = estimateCost("claude-opus-4.8", {
        ...zero,
        cache_creation_input_tokens: 1_000_000,
      });
      expect(r.cost).toBeCloseTo(6.25, 5);
    });

    test("small token counts produce small costs", () => {
      const r = estimateCost("claude-opus-4.8", {
        ...zero,
        input_tokens: 1000,
        output_tokens: 500,
      });
      // 1000 * 5/1M + 500 * 25/1M = 0.005 + 0.0125 = 0.0175
      expect(r.cost).toBeCloseTo(0.0175, 5);
    });
  });

  describe("long-context tier", () => {
    const zero = {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
    };

    test("at the threshold still bills default rates (docs say <= 272K)", () => {
      const r = estimateCost("gpt-5.4", { ...zero, input_tokens: 272_000 });
      expect(r.cost).toBeCloseTo((272_000 / 1e6) * 2.5, 6);
    });

    test("one token over the threshold flips the whole request", () => {
      const r = estimateCost("gpt-5.4", { ...zero, input_tokens: 272_001 });
      expect(r.cost).toBeCloseTo((272_001 / 1e6) * 5, 6);
    });

    test("output is billed at the long-context output rate too", () => {
      const r = estimateCost("gpt-5.5", {
        ...zero,
        input_tokens: 300_000,
        output_tokens: 1_000_000,
      });
      // input 300K @ $10 + output 1M @ $45
      expect(r.cost).toBeCloseTo((300_000 / 1e6) * 10 + 45, 6);
    });

    test("threshold counts cached input, not just fresh input", () => {
      // 150K fresh + 100K cached = 250K total > 200K threshold for luna.
      const r = estimateCost("gpt-5.6-luna", {
        ...zero,
        input_tokens: 150_000,
        cache_read_input_tokens: 100_000,
      });
      expect(r.cost).toBeCloseTo((150_000 / 1e6) * 2 + (100_000 / 1e6) * 0.2, 6);
    });

    test("gemini-3.1-pro tiers at 200K, and its -preview id inherits the tier", () => {
      const under = estimateCost("gemini-3.1-pro-preview", { ...zero, input_tokens: 199_000 });
      const over = estimateCost("gemini-3.1-pro-preview", { ...zero, input_tokens: 201_000 });
      expect(under.cost).toBeCloseTo((199_000 / 1e6) * 2, 6);
      expect(over.cost).toBeCloseTo((201_000 / 1e6) * 4, 6);
    });

    test("reasoning tokens use the tier's output rate", () => {
      const r = estimateCost("gpt-5.6-terra", {
        ...zero,
        input_tokens: 400_000,
        reasoning_tokens: 1_000_000,
      });
      expect(r.cost).toBeCloseTo((400_000 / 1e6) * 5 + 22.5, 6);
    });

    test("untiered models ignore input size entirely", () => {
      const huge = estimateCost("claude-opus-4.8", { ...zero, input_tokens: 900_000 });
      expect(huge.cost).toBeCloseTo((900_000 / 1e6) * 5, 6);
      const flash = estimateCost("gemini-3.6-flash", { ...zero, input_tokens: 900_000 });
      expect(flash.cost).toBeCloseTo((900_000 / 1e6) * 1.5, 6);
    });

    test("many small requests priced individually stay in the default tier", () => {
      // The regression this guards: summing tokens first, then pricing once,
      // would cross 272K and bill everything at long-context rates.
      const perRequest = { ...zero, input_tokens: 10_000, output_tokens: 1_000 };
      let summed = 0;
      for (let i = 0; i < 40; i++) summed += estimateCost("gpt-5.4", perRequest).cost;

      const pricedAsOneBundle = estimateCost("gpt-5.4", {
        ...zero,
        input_tokens: 400_000,
        output_tokens: 40_000,
      }).cost;

      expect(summed).toBeCloseTo((400_000 / 1e6) * 2.5 + (40_000 / 1e6) * 15, 6);
      expect(pricedAsOneBundle).toBeGreaterThan(summed);
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
