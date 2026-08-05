import { describe, expect, test } from "bun:test";
import {
  getConfiguredCopilotApiBaseUrl,
  getGitHubApiBaseUrl,
  getGitHubWebBaseUrl,
  MSFT_GHE_ENDPOINT,
  resolveGheEndpoints,
} from "../../../src/auth/github-endpoints";
import { DEFAULT_CONFIG } from "../../../src/config/schema";

describe("GitHub Enterprise endpoints", () => {
  test.each([
    "msft.ghe.com",
    "https://msft.ghe.com/",
    "https://api.msft.ghe.com",
    "https://copilot-api.msft.ghe.com",
  ])("normalizes %s", (endpoint) => {
    expect(resolveGheEndpoints(endpoint)).toEqual({
      github_web_base_url: "https://msft.ghe.com",
      github_api_base_url: "https://api.msft.ghe.com",
      copilot_api_base_url: "https://copilot-api.msft.ghe.com",
    });
  });

  test("MSFT shorthand points at the Microsoft tenant", () => {
    expect(MSFT_GHE_ENDPOINT).toBe("https://msft.ghe.com");
  });

  test.each([
    "",
    "http://msft.ghe.com",
    "https://ghe.com",
    "https://example.com",
    "https://msft.ghe.com/path",
    "https://user:secret@msft.ghe.com",
    "https://msft.ghe.com?query=1",
    "https://msft.ghe.com:8443",
  ])("rejects invalid endpoint %s", (endpoint) => {
    expect(() => resolveGheEndpoints(endpoint)).toThrow();
  });

  test("derives OAuth origins for github.com and GHE.com", () => {
    expect(getGitHubWebBaseUrl("https://api.github.com")).toBe("https://github.com");
    expect(getGitHubWebBaseUrl("https://api.msft.ghe.com/"))
      .toBe("https://msft.ghe.com");
  });

  test("rejects ambiguous OAuth origins", () => {
    expect(() => getGitHubWebBaseUrl("https://copilot-api.msft.ghe.com")).toThrow();
    expect(() => getGitHubWebBaseUrl("http://api.msft.ghe.com")).toThrow();
  });

  test("configured API getters default to github.com and honor overrides", () => {
    expect(getGitHubApiBaseUrl({ ...DEFAULT_CONFIG })).toBe("https://api.github.com");
    expect(getConfiguredCopilotApiBaseUrl({ ...DEFAULT_CONFIG }))
      .toBe("https://api.githubcopilot.com");

    const config = {
      ...DEFAULT_CONFIG,
      github_api_base_url: "https://api.msft.ghe.com/",
      copilot_api_base_url: "https://copilot-api.msft.ghe.com/",
    };
    expect(getGitHubApiBaseUrl(config)).toBe("https://api.msft.ghe.com");
    expect(getConfiguredCopilotApiBaseUrl(config))
      .toBe("https://copilot-api.msft.ghe.com");
  });
});
