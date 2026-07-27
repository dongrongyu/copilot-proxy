import { describe, expect, test, afterAll, spyOn, mock } from "bun:test";

// usageData() aggregates whatever readMonthlyUsage() returns. We stub the logger
// with an in-memory fixture so the assertions are deterministic and never touch
// the real ~/.copilot-proxy logs. availableMonths() also calls listLogDates(),
// so we stub that too. We use spyOn (NOT mock.module) so the stubs can be cleanly
// reverted in afterAll — mock.module is process-global and cannot be restored,
// which previously leaked these stubs into logger-integration.test.ts.
import * as realLogger from "../../../src/usage/logger";

const TODAY = "2026-06-15";
const YESTERDAY = "2026-06-14";

function fixtureMonth() {
  return {
    month: "2026-06",
    total_requests: 4,
    totals: {
      input_tokens: 30,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 8,
      output_tokens: 6,
      reasoning_tokens: 0,
    },
    by_model: {
      "claude-opus-4.8": {
        requests: 4,
        // Accumulated per request by readMonthlyUsage, not derived from the
        // token totals below — so it matches the by_day sum.
        cost: 9.75,
        input_tokens: 30,
        cache_creation_input_tokens: 12,
        cache_read_input_tokens: 8,
        output_tokens: 6,
        reasoning_tokens: 0,
      },
    },
    by_day: {
      // Intentionally out of order to also exercise the chronological sort.
      [TODAY]: {
        requests: 3,
        cost: 7.5,
        input_tokens: 20,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
        output_tokens: 4,
        reasoning_tokens: 0,
      },
      [YESTERDAY]: {
        requests: 1,
        cost: 2.25,
        input_tokens: 10,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 2,
        reasoning_tokens: 0,
      },
    },
  };
}

spyOn(realLogger, "listLogDates").mockReturnValue([`${TODAY}.jsonl`.replace(".jsonl", "")]);
spyOn(realLogger, "readMonthlyUsage").mockImplementation((month: string) =>
  month === "2026-06" ? (fixtureMonth() as ReturnType<typeof realLogger.readMonthlyUsage>) : null,
);
afterAll(() => mock.restore());

const { usageData } = await import("../../../src/portal/api");

describe("portal usage api", () => {
  test("total_cost is the sum of every day's cost", () => {
    const d = usageData("2026-06");
    expect(d.empty).toBe(false);
    // 7.5 + 2.25 = 9.75
    expect(d.total_cost).toBeCloseTo(9.75, 6);
  });

  test("by_day exposes cache_creation_input_tokens for the stacked chart", () => {
    const d = usageData("2026-06");
    const today = d.by_day.find((x: any) => x.day === TODAY);
    expect(today).toBeDefined();
    // The Cache Creation segment was previously dropped from the chart; assert
    // the field flows through so the portal can stack it.
    expect(today!.cache_creation_input_tokens).toBe(10);
    expect(today!.cost).toBe(7.5);
  });

  test("by_day is sorted chronologically (oldest first)", () => {
    const d = usageData("2026-06");
    expect(d.by_day.map((x: any) => x.day)).toEqual([YESTERDAY, TODAY]);
  });

  test("by_model carries a priced cost for the model table", () => {
    const d = usageData("2026-06");
    const opus = d.by_model.find((m: any) => m.name === "claude-opus-4.8");
    expect(opus).toBeDefined();
    // Passed through from the aggregate, NOT re-priced from the summed tokens —
    // re-pricing would mis-tier long-context models.
    expect(opus!.cost).toBeCloseTo(9.75, 6);
    expect(opus!.priced).toBe(true);
  });

  test("an unknown month returns the empty shape with no total_cost", () => {
    const d = usageData("1999-01");
    expect(d.empty).toBe(true);
    expect(d.by_day).toEqual([]);
    expect((d as any).total_cost).toBeUndefined();
  });
});
