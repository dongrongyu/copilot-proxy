import { describe, expect, test, beforeEach } from "bun:test";
import { initState, getState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import { translateModelName, reverseModelName } from "../../../src/proxy/model-mapping";

describe("Model Mapping", () => {
  beforeEach(() => {
    initState({
      ...DEFAULT_CONFIG,
      model_mappings: {
        exact: { ...DEFAULT_CONFIG.model_mappings.exact },
        prefix: { ...DEFAULT_CONFIG.model_mappings.prefix },
      },
    });
  });

  describe("built-in exact mappings", () => {
    test("opus -> claude-opus-4.6", () => {
      expect(translateModelName("opus")).toBe("claude-opus-4.6");
    });
    test("sonnet -> claude-sonnet-4.5", () => {
      expect(translateModelName("sonnet")).toBe("claude-sonnet-4.5");
    });
    test("haiku -> claude-haiku-4.5", () => {
      expect(translateModelName("haiku")).toBe("claude-haiku-4.5");
    });
    test("claude-opus-4-6 -> claude-opus-4.6", () => {
      expect(translateModelName("claude-opus-4-6")).toBe("claude-opus-4.6");
    });
    test("claude-opus-4-8 -> claude-opus-4.8", () => {
      expect(translateModelName("claude-opus-4-8")).toBe("claude-opus-4.8");
    });
    test("claude-opus-4-5 -> claude-opus-4.5", () => {
      expect(translateModelName("claude-opus-4-5")).toBe("claude-opus-4.5");
    });
    test("claude-haiku-4-5 -> claude-haiku-4.5", () => {
      expect(translateModelName("claude-haiku-4-5")).toBe("claude-haiku-4.5");
    });
  });

  describe("built-in prefix mappings", () => {
    test("claude-opus-4-6-xxx -> claude-opus-4.6", () => {
      expect(translateModelName("claude-opus-4-6-20250514")).toBe("claude-opus-4.6");
    });
    test("claude-opus-4-8-xxx -> claude-opus-4.8", () => {
      expect(translateModelName("claude-opus-4-8-20260601")).toBe("claude-opus-4.8");
    });
    test("claude-sonnet-4-xxx -> claude-sonnet-4", () => {
      expect(translateModelName("claude-sonnet-4-20250514")).toBe("claude-sonnet-4");
    });
    test("dot-form passes through (claude-haiku-4.5-20250101)", () => {
      expect(translateModelName("claude-haiku-4.5-20250101")).toBe("claude-haiku-4.5-20250101");
    });
    test("dot-form passes through (claude-opus-4.6-preview)", () => {
      expect(translateModelName("claude-opus-4.6-preview")).toBe("claude-opus-4.6-preview");
    });
    test("dot-form 1M variant passes through (claude-opus-4.6-1m)", () => {
      expect(translateModelName("claude-opus-4.6-1m")).toBe("claude-opus-4.6-1m");
    });
    test("dot-form 1M variant passes through (claude-opus-4.7-1m-internal)", () => {
      expect(translateModelName("claude-opus-4.7-1m-internal")).toBe("claude-opus-4.7-1m-internal");
    });
    test("dot-form effort variant passes through (claude-opus-4.7-xhigh)", () => {
      expect(translateModelName("claude-opus-4.7-xhigh")).toBe("claude-opus-4.7-xhigh");
    });
  });

  describe("[1m] marker handling", () => {
    test("strips [1m] and passes through full Copilot id", () => {
      expect(translateModelName("claude-opus-4.6-1m[1m]")).toBe("claude-opus-4.6-1m");
    });
    test("strips [1m] from -1m-internal id", () => {
      expect(translateModelName("claude-opus-4.7-1m-internal[1m]")).toBe("claude-opus-4.7-1m-internal");
    });
    test("strips [1m] from arbitrary id", () => {
      expect(translateModelName("any-model-name[1m]")).toBe("any-model-name");
    });
  });

  describe("user config overrides", () => {
    test("user exact overrides built-in", () => {
      getState().config.model_mappings.exact["opus"] = "claude-opus-4.6-1m";
      expect(translateModelName("opus")).toBe("claude-opus-4.6-1m");
    });

    test("user exact overrides [1m] parsing", () => {
      getState().config.model_mappings.exact["claude-opus-4-6[1m]"] = "my-custom-model";
      expect(translateModelName("claude-opus-4-6[1m]")).toBe("my-custom-model");
    });

    test("user prefix overrides built-in prefix", () => {
      getState().config.model_mappings.prefix["claude-opus-4-6-"] = "claude-opus-4.6-1m";
      expect(translateModelName("claude-opus-4-6-xxx")).toBe("claude-opus-4.6-1m");
    });
  });

  describe("passthrough", () => {
    test("unknown model passes through", () => {
      expect(translateModelName("gpt-4o")).toBe("gpt-4o");
    });
    test("empty string passes through", () => {
      expect(translateModelName("")).toBe("");
    });
    test("already correct copilot name passes through", () => {
      expect(translateModelName("claude-opus-4.6")).toBe("claude-opus-4.6");
    });
  });

  describe("prefix longest match", () => {
    test("longer prefix wins over shorter", () => {
      // After initState with DEFAULT_CONFIG, user config is empty
      // claude-opus-4-6- is in built-in prefix -> claude-opus-4.6
      expect(translateModelName("claude-opus-4-6-20250514")).toBe("claude-opus-4.6");
    });
  });

  describe("reverseModelName", () => {
    test("appends [1m] for -1m suffix", () => {
      expect(reverseModelName("claude-opus-4.6-1m")).toBe("claude-opus-4.6-1m[1m]");
    });
    test("appends [1m] for -1m-internal suffix", () => {
      expect(reverseModelName("claude-opus-4.7-1m-internal")).toBe("claude-opus-4.7-1m-internal[1m]");
    });
    test("passes through models without -1m", () => {
      expect(reverseModelName("claude-opus-4.6")).toBe("claude-opus-4.6");
    });
    test("passes through non-claude models", () => {
      expect(reverseModelName("gpt-4o")).toBe("gpt-4o");
    });
  });
});
