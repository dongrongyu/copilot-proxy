import { describe, expect, test } from "bun:test";
import yaml from "js-yaml";
import {
  renderMappingsBlock,
  setModelMappings,
  DEFAULT_CONFIG_TEMPLATE,
} from "../../../src/config/loader";
import { DEFAULT_MODEL_MAPPINGS } from "../../../src/config/schema";

describe("renderMappingsBlock", () => {
  test("renders nested exact/prefix with quoted keys and values", () => {
    const out = renderMappingsBlock(DEFAULT_MODEL_MAPPINGS);
    // Wrap under a parent key so it parses as a valid model_mappings document.
    const parsed = yaml.load(`model_mappings:\n${out}`) as any;
    expect(parsed.model_mappings.exact["opus"]).toBe("claude-opus-4.8");
    expect(parsed.model_mappings.exact["claude-opus-4-8"]).toBe("claude-opus-4.8");
    expect(parsed.model_mappings.prefix["claude-opus-4-8-"]).toBe("claude-opus-4.8");
  });

  test("quotes keys containing dots/dashes/brackets", () => {
    const out = renderMappingsBlock({
      exact: { "claude-opus-4-6[1m]": "claude-opus-4.6-1m" },
      prefix: {},
    });
    expect(out).toContain('"claude-opus-4-6[1m]": "claude-opus-4.6-1m"');
  });

  test("empty sub-map renders as inline {}", () => {
    const out = renderMappingsBlock({ exact: {}, prefix: {} });
    expect(out).toContain("exact: {}");
    expect(out).toContain("prefix: {}");
  });

  test("honors a custom EOL", () => {
    const out = renderMappingsBlock(DEFAULT_MODEL_MAPPINGS, "\r\n");
    expect(out.includes("\r\n")).toBe(true);
    expect(/(?<!\r)\n/.test(out)).toBe(false);
  });
});

describe("setModelMappings", () => {
  const emptyBlockConfig = `port: 8989

# Model Name Mappings
# my custom note
model_mappings:
  exact: {}
  prefix: {}

# Web Search
web_search:
  enabled: false
`;

  test("injects defaults into an empty block", () => {
    const out = setModelMappings(emptyBlockConfig, DEFAULT_MODEL_MAPPINGS);
    const parsed = yaml.load(out) as any;
    expect(parsed.model_mappings.exact["opus"]).toBe("claude-opus-4.8");
    expect(parsed.model_mappings.prefix["claude-opus-4-6-"]).toBe("claude-opus-4.6");
    // Unrelated content untouched.
    expect(parsed.port).toBe(8989);
    expect(parsed.web_search.enabled).toBe(false);
  });

  test("preserves surrounding comments and sibling blocks", () => {
    const out = setModelMappings(emptyBlockConfig, DEFAULT_MODEL_MAPPINGS);
    expect(out).toContain("# Model Name Mappings");
    expect(out).toContain("# my custom note");
    expect(out).toContain("# Web Search");
    // Blank separator before the next sibling block is kept.
    expect(/\n\n# Web Search/.test(out)).toBe(true);
  });

  test("is idempotent once populated", () => {
    const once = setModelMappings(emptyBlockConfig, DEFAULT_MODEL_MAPPINGS);
    const twice = setModelMappings(once, DEFAULT_MODEL_MAPPINGS);
    expect(twice).toBe(once);
  });

  test("replaces an existing populated block wholesale (portal save flow)", () => {
    const populated = setModelMappings(emptyBlockConfig, DEFAULT_MODEL_MAPPINGS);
    const edited = setModelMappings(populated, {
      exact: { opus: "claude-opus-4.8" },
      prefix: {},
    });
    const parsed = yaml.load(edited) as any;
    expect(parsed.model_mappings.exact["opus"]).toBe("claude-opus-4.8");
    // Old entries are gone (full replace, not merge).
    expect(parsed.model_mappings.exact["sonnet"]).toBeUndefined();
  });

  test("preserves CRLF line endings", () => {
    const crlf = emptyBlockConfig.replace(/\n/g, "\r\n");
    const out = setModelMappings(crlf, DEFAULT_MODEL_MAPPINGS);
    expect(out.includes("\r\n")).toBe(true);
    expect(/(?<!\r)\n/.test(out)).toBe(false);
  });

  test("appends a fresh block when none exists", () => {
    const out = setModelMappings("port: 8989\n", DEFAULT_MODEL_MAPPINGS);
    const parsed = yaml.load(out) as any;
    expect(parsed.model_mappings.exact["opus"]).toBe("claude-opus-4.8");
    expect(parsed.port).toBe(8989);
  });

  test("the generated DEFAULT_CONFIG_TEMPLATE has a populated mappings block", () => {
    const parsed = yaml.load(DEFAULT_CONFIG_TEMPLATE) as any;
    expect(parsed.model_mappings.exact["opus"]).toBe("claude-opus-4.8");
    expect(Object.keys(parsed.model_mappings.prefix).length).toBeGreaterThan(0);
  });
});
