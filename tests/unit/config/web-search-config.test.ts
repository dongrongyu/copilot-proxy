import { describe, expect, test } from "bun:test";
import yaml from "js-yaml";
import {
  setWebSearchFields,
  DEFAULT_CONFIG_TEMPLATE,
} from "../../../src/config/loader";

describe("setWebSearchFields", () => {
  test("updates an existing key in place", () => {
    const out = setWebSearchFields(DEFAULT_CONFIG_TEMPLATE, {
      tavily_api_key: "tvly-abc123",
    });
    const parsed = yaml.load(out) as any;
    expect(parsed.web_search.tavily_api_key).toBe("tvly-abc123");
  });

  test("preserves the inline comment on the provider line", () => {
    const out = setWebSearchFields(DEFAULT_CONFIG_TEMPLATE, {
      provider: "searxng",
    });
    expect(out).toContain('provider: "searxng"');
    expect(out).toContain('# "tavily", "webiq", or "searxng"');
  });

  test("preserves surrounding comments and other sections", () => {
    const out = setWebSearchFields(DEFAULT_CONFIG_TEMPLATE, {
      enabled: true,
    });
    expect(out).toContain("# Web Search Fallback");
    expect(out).toContain("# Server Settings");
    expect(out).toContain("port: 8989");
    const parsed = yaml.load(out) as any;
    expect(parsed.web_search.enabled).toBe(true);
    expect(parsed.port).toBe(8989);
  });

  test("writes booleans unquoted and strings quoted", () => {
    const out = setWebSearchFields(DEFAULT_CONFIG_TEMPLATE, {
      enabled: true,
      tavily_api_key: "k",
    });
    expect(out).toContain("enabled: true");
    expect(out).toContain('tavily_api_key: "k"');
  });

  test("escapes quotes and backslashes in values", () => {
    const out = setWebSearchFields(DEFAULT_CONFIG_TEMPLATE, {
      tavily_api_key: 'a"b\\c',
    });
    const parsed = yaml.load(out) as any;
    expect(parsed.web_search.tavily_api_key).toBe('a"b\\c');
  });

  test("appends a missing key inside the block", () => {
    const minimal = [
      "web_search:",
      "  enabled: false",
      "port: 8989",
      "",
    ].join("\n");
    const out = setWebSearchFields(minimal, { tavily_api_key: "xyz" });
    const parsed = yaml.load(out) as any;
    expect(parsed.web_search.tavily_api_key).toBe("xyz");
    expect(parsed.web_search.enabled).toBe(false);
    expect(parsed.port).toBe(8989);
  });

  test("creates a web_search block when none exists", () => {
    const noBlock = "address: localhost\nport: 8989\n";
    const out = setWebSearchFields(noBlock, {
      tavily_api_key: "new",
      enabled: true,
    });
    const parsed = yaml.load(out) as any;
    expect(parsed.web_search.tavily_api_key).toBe("new");
    expect(parsed.web_search.enabled).toBe(true);
    expect(parsed.address).toBe("localhost");
  });

  test("is a no-op when there are no updates", () => {
    const out = setWebSearchFields(DEFAULT_CONFIG_TEMPLATE, {});
    expect(out).toBe(DEFAULT_CONFIG_TEMPLATE);
  });

  test("preserves CRLF line endings", () => {
    const crlf = DEFAULT_CONFIG_TEMPLATE.replace(/\n/g, "\r\n");
    const out = setWebSearchFields(crlf, { enabled: true });
    expect(out).toContain("\r\n");
    expect(out).not.toMatch(/[^\r]\n/);
  });

  test("default template parses and round-trips through the updater", () => {
    const parsed = yaml.load(DEFAULT_CONFIG_TEMPLATE) as any;
    expect(parsed.web_search.provider).toBe("tavily");
    expect(parsed.web_search.enabled).toBe(false);
    const out = setWebSearchFields(DEFAULT_CONFIG_TEMPLATE, {
      provider: "tavily",
      tavily_api_key: "tvly-key",
      enabled: true,
    });
    const reparsed = yaml.load(out) as any;
    expect(reparsed.web_search.provider).toBe("tavily");
    expect(reparsed.web_search.tavily_api_key).toBe("tvly-key");
    expect(reparsed.web_search.enabled).toBe(true);
    expect(reparsed.web_search.searxng_url).toBe("http://localhost:8888");
  });
});
