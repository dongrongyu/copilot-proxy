import { describe, expect, test } from "bun:test";
import yaml from "js-yaml";
import {
  DEFAULT_CONFIG_TEMPLATE,
  setUpstreamEndpointFields,
} from "../../../src/config/loader";

const MSFT_ENDPOINTS = {
  github_api_base_url: "https://api.msft.ghe.com",
  copilot_api_base_url: "https://copilot-api.msft.ghe.com",
};

describe("setUpstreamEndpointFields", () => {
  test("updates both endpoints without dropping comments or other config", () => {
    const out = setUpstreamEndpointFields(DEFAULT_CONFIG_TEMPLATE, MSFT_ENDPOINTS);
    const parsed = yaml.load(out) as any;
    expect(parsed.github_api_base_url).toBe(MSFT_ENDPOINTS.github_api_base_url);
    expect(parsed.copilot_api_base_url).toBe(MSFT_ENDPOINTS.copilot_api_base_url);
    expect(parsed.port).toBe(8989);
    expect(out).toContain("# Server Settings");
    expect(out).toContain("# Model Name Mappings");
  });

  test("appends missing fields and preserves unrelated data", () => {
    const input = "# keep\naddress: localhost\ncustom: value\n";
    const out = setUpstreamEndpointFields(input, MSFT_ENDPOINTS);
    const parsed = yaml.load(out) as any;
    expect(parsed.custom).toBe("value");
    expect(parsed.github_api_base_url).toBe(MSFT_ENDPOINTS.github_api_base_url);
    expect(parsed.copilot_api_base_url).toBe(MSFT_ENDPOINTS.copilot_api_base_url);
    expect(out).toContain("# keep");
  });

  test("preserves inline comments and CRLF", () => {
    const input = [
      'github_api_base_url: "" # github',
      'copilot_api_base_url: "" # copilot',
      "",
    ].join("\r\n");
    const out = setUpstreamEndpointFields(input, MSFT_ENDPOINTS);
    expect(out).toContain("# github");
    expect(out).toContain("# copilot");
    expect(out).toContain("\r\n");
    expect(out).not.toMatch(/[^\r]\n/);
  });

  test("does not mistake nested keys for top-level endpoint settings", () => {
    const input = [
      "custom:",
      '  github_api_base_url: "https://nested.example"',
      "port: 8989",
      "",
    ].join("\n");
    const out = setUpstreamEndpointFields(input, MSFT_ENDPOINTS);
    const parsed = yaml.load(out) as any;
    expect(parsed.custom.github_api_base_url).toBe("https://nested.example");
    expect(parsed.github_api_base_url).toBe(MSFT_ENDPOINTS.github_api_base_url);
    expect(parsed.copilot_api_base_url).toBe(MSFT_ENDPOINTS.copilot_api_base_url);
  });
});
