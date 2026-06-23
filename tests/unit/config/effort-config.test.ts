import { describe, expect, test } from "bun:test";
import yaml from "js-yaml";
import { getState, initState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import {
  setEffortField,
  DEFAULT_CONFIG_TEMPLATE,
  loadConfig,
} from "../../../src/config/loader";
import {
  adjustResponsesReasoningForModel,
  clampEffortToSupported,
} from "../../../src/proxy/reasoning-effort";

// Effort ladders advertised by the live Copilot catalog (verified empirically):
//   opus-4.6 / sonnet-4.6:  low, medium, high,        max   (no xhigh)
//   opus-4.7 / opus-4.8:    low, medium, high, xhigh, max
const LADDER_46 = ["low", "medium", "high", "max"];
const LADDER_48 = ["low", "medium", "high", "xhigh", "max"];
const GPT_55_LADDER = ["low", "medium", "high", "xhigh"];
const GPT_55 = {
  id: "gpt-5.5",
  capabilities: { supports: { reasoning_effort: GPT_55_LADDER } },
};

function initEffortState(effort: string): void {
  initState({ ...DEFAULT_CONFIG, effort });
  getState().models = { data: [GPT_55] };
}

describe("clampEffortToSupported", () => {
  test("returns the target unchanged when the model supports it", () => {
    expect(clampEffortToSupported("high", LADDER_46)).toBe("high");
    expect(clampEffortToSupported("xhigh", LADDER_48)).toBe("xhigh");
    expect(clampEffortToSupported("max", LADDER_46)).toBe("max");
    expect(clampEffortToSupported("low", LADDER_48)).toBe("low");
  });

  test("snaps UP to the nearest stronger effort when the target is absent", () => {
    // xhigh is absent on the 4.6 ladder → nearest stronger is max.
    expect(clampEffortToSupported("xhigh", LADDER_46)).toBe("max");
  });

  test("default 'high' needs no clamping on any effort-capable model", () => {
    expect(clampEffortToSupported("high", LADDER_46)).toBe("high");
    expect(clampEffortToSupported("high", LADDER_48)).toBe("high");
  });

  test("falls back DOWN only when nothing stronger is supported", () => {
    // Target xhigh, model supports only weaker levels → nearest weaker is high.
    expect(clampEffortToSupported("xhigh", ["low", "medium", "high"])).toBe("high");
    // Target max, model tops out at high → high.
    expect(clampEffortToSupported("max", ["low", "medium", "high"])).toBe("high");
  });

  test("returns '' when the model advertises no efforts", () => {
    expect(clampEffortToSupported("high", [])).toBe("");
    expect(clampEffortToSupported("max", [])).toBe("");
  });

  test("an unknown target falls back to the strongest supported effort", () => {
    expect(clampEffortToSupported("bogus", LADDER_48)).toBe("max");
    expect(clampEffortToSupported("ultra", LADDER_46)).toBe("max");
  });

  test("single-value ladder resolves to that value", () => {
    expect(clampEffortToSupported("xhigh", ["medium"])).toBe("medium");
  });
});

describe("setEffortField", () => {
  test("updates the effort key in the default template", () => {
    const out = setEffortField(DEFAULT_CONFIG_TEMPLATE, "max");
    const parsed = yaml.load(out) as any;
    expect(parsed.effort).toBe("max");
  });

  test("preserves surrounding comments and other sections", () => {
    const out = setEffortField(DEFAULT_CONFIG_TEMPLATE, "low");
    expect(out).toContain("# Reasoning Effort");
    expect(out).toContain("# Server Settings");
    expect(out).toContain("port: 8989");
    const parsed = yaml.load(out) as any;
    expect(parsed.effort).toBe("low");
    expect(parsed.port).toBe(8989);
  });

  test("appends an effort key when one is absent", () => {
    const noEffort = "address: localhost\nport: 8989\n";
    const out = setEffortField(noEffort, "high");
    expect(out).toContain('effort: "high"');
    const parsed = yaml.load(out) as any;
    expect(parsed.effort).toBe("high");
    expect(parsed.port).toBe(8989);
  });

  test("preserves CRLF line endings", () => {
    const crlf = "address: localhost\r\neffort: high\r\nport: 8989\r\n";
    const out = setEffortField(crlf, "max");
    expect(out).toContain("\r\n");
    expect(out).not.toMatch(/[^\r]\n/);
  });
});

describe("loadConfig effort defaults", () => {
  test("the default template parses with effort = high", () => {
    const parsed = yaml.load(DEFAULT_CONFIG_TEMPLATE) as any;
    expect(parsed.effort).toBe("high");
  });

  test("loadConfig always returns a non-empty effort string", () => {
    // Whatever the on-disk config, effort must never be null/undefined (No-NULL).
    const cfg = loadConfig();
    expect(typeof cfg.effort).toBe("string");
    expect(cfg.effort.length).toBeGreaterThan(0);
  });
});

describe("adjustResponsesReasoningForModel", () => {
  test("injects configured effort for reasoning-capable OpenAI responses models", () => {
    initEffortState("max");

    const payload = { model: "gpt-5.5", reasoning: { summary: "none" } };
    const adjusted = adjustResponsesReasoningForModel(payload, "gpt-5.5");

    expect(adjusted.effort).toBe("xhigh");
    expect(adjusted.payload.reasoning).toEqual({ summary: "none", effort: "xhigh" });
  });

  test("preserves a caller-provided reasoning.effort when present", () => {
    initEffortState("medium");

    const payload = { model: "gpt-5.5", reasoning: { effort: "xhigh", summary: "none" } };
    const adjusted = adjustResponsesReasoningForModel(payload, "gpt-5.5");

    expect(adjusted.effort).toBe("xhigh");
    expect(adjusted.payload.reasoning).toEqual({ effort: "xhigh", summary: "none" });
  });

  test("clamps a caller-provided reasoning.effort to the supported ladder", () => {
    initEffortState("low");

    const payload = { model: "gpt-5.5", reasoning: { effort: "max", summary: "none" } };
    const adjusted = adjustResponsesReasoningForModel(payload, "gpt-5.5");

    expect(adjusted.effort).toBe("xhigh");
    expect(adjusted.payload.reasoning).toEqual({ effort: "xhigh", summary: "none" });
  });

  test("leaves responses payload untouched when no reasoning object is present", () => {
    initEffortState("max");

    const payload = { model: "gpt-5.5", input: "hello" };
    const adjusted = adjustResponsesReasoningForModel(payload, "gpt-5.5");

    expect(adjusted.effort).toBe("");
    expect(adjusted.payload).toBe(payload);
  });
});
