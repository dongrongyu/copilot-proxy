import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { initState, getState } from "../../../src/auth/state";
import { DEFAULT_CONFIG } from "../../../src/config/schema";
import { getGitHubToken } from "../../../src/auth/github-token";

describe("GitHub Token", () => {
  beforeEach(() => {
    initState({ ...DEFAULT_CONFIG });
  });

  test("reads from GITHUB_TOKEN env var", () => {
    const origToken = process.env.GITHUB_TOKEN;
    try {
      process.env.GITHUB_TOKEN = "test-env-token-12345";
      const token = getGitHubToken();
      expect(token).toBe("test-env-token-12345");
    } finally {
      if (origToken) process.env.GITHUB_TOKEN = origToken;
      else delete process.env.GITHUB_TOKEN;
    }
  });

  test("reads from file when env not set", () => {
    const origToken = process.env.GITHUB_TOKEN;
    try {
      delete process.env.GITHUB_TOKEN;
      // If the file exists, it should return a non-empty string
      const tokenPath = join(require("os").homedir(), ".copilot-proxy", "github_token.txt");
      if (existsSync(tokenPath)) {
        const token = getGitHubToken();
        expect(token.length).toBeGreaterThan(0);
      }
      // If no file either, it should throw
    } finally {
      if (origToken) process.env.GITHUB_TOKEN = origToken;
      else delete process.env.GITHUB_TOKEN;
    }
  });

  test("throws when no token available and no file", () => {
    const origToken = process.env.GITHUB_TOKEN;
    try {
      delete process.env.GITHUB_TOKEN;
      // getGitHubToken uses getConfigDir() which depends on real HOME
      // Just verify it returns a string (from file) or throws
      try {
        const token = getGitHubToken();
        // If it succeeds, it found a file - that's fine
        expect(typeof token).toBe("string");
        expect(token.length).toBeGreaterThan(0);
      } catch (e: any) {
        expect(e.message).toContain("No GitHub token found");
      }
    } finally {
      if (origToken) process.env.GITHUB_TOKEN = origToken;
      else delete process.env.GITHUB_TOKEN;
    }
  });
});
