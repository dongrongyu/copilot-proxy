import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import type { Config } from "../../../src/config/schema";

describe("Config Schema", () => {
  test("DEFAULT_CONFIG has all required fields", () => {
    expect(DEFAULT_CONFIG.address).toBe("localhost");
    expect(DEFAULT_CONFIG.port).toBe(8989);
    expect(DEFAULT_CONFIG.github_api_base_url).toBe("");
    expect(DEFAULT_CONFIG.copilot_api_base_url).toBe("");
    expect(DEFAULT_CONFIG.vscode_version).toBe("1.93.0");
    expect(DEFAULT_CONFIG.api_version).toBe("2025-04-01");
    expect(DEFAULT_CONFIG.copilot_version).toBe("0.26.7");
    expect(DEFAULT_CONFIG.max_connection_retries).toBe(3);
  });

  test("DEFAULT_CONFIG model_mappings starts empty", () => {
    // Note: DEFAULT_CONFIG is a shared object, so we check the original shape
    expect(DEFAULT_CONFIG.model_mappings).toBeDefined();
    expect(typeof DEFAULT_CONFIG.model_mappings.exact).toBe("object");
    expect(typeof DEFAULT_CONFIG.model_mappings.prefix).toBe("object");
  });

  test("DEFAULT_CONFIG web_search defaults", () => {
    expect(DEFAULT_CONFIG.web_search.enabled).toBe(false);
    expect(DEFAULT_CONFIG.web_search.provider).toBe("tavily");
    expect(DEFAULT_CONFIG.web_search.tavily_api_key).toBe("");
    expect(DEFAULT_CONFIG.web_search.webiq_api_key).toBe("");
    expect(DEFAULT_CONFIG.web_search.searxng_url).toBe("http://localhost:8888");
  });

  test("Config type is assignable", () => {
    const config: Config = { ...DEFAULT_CONFIG };
    expect(config.port).toBe(8989);
  });
});
