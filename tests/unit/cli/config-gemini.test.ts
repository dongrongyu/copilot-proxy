import { describe, expect, test } from "bun:test";
import {
  buildGeminiEnv,
  mergeEnvFile,
  mergeGeminiSettings,
} from "../../../src/cli/config";

describe("buildGeminiEnv", () => {
  test("produces expected keys (base URL without /v1beta suffix)", () => {
    const env = buildGeminiEnv("http://localhost:8989", "gemini-2.5-pro");
    expect(env).toEqual({
      GOOGLE_GEMINI_BASE_URL: "http://localhost:8989",
      GEMINI_API_KEY: "github-copilot",
      GEMINI_MODEL: "gemini-2.5-pro",
      GEMINI_TELEMETRY_ENABLED: "false",
    });
  });
});

describe("mergeEnvFile", () => {
  test("appends keys into empty file", () => {
    const out = mergeEnvFile("", { FOO: "bar", BAZ: "qux" });
    expect(out).toContain("FOO=bar");
    expect(out).toContain("BAZ=qux");
    expect(out.endsWith("\n")).toBe(true);
  });

  test("updates existing keys in place", () => {
    const existing = "FOO=old\nUNRELATED=keep\n";
    const out = mergeEnvFile(existing, { FOO: "new" });
    expect(out).toContain("FOO=new");
    expect(out).toContain("UNRELATED=keep");
    expect(out).not.toContain("FOO=old");
  });

  test("preserves keys listed in preserveKeys", () => {
    const existing = "GEMINI_API_KEY=my-secret\n";
    const out = mergeEnvFile(
      existing,
      { GEMINI_API_KEY: "github-copilot", GEMINI_MODEL: "gemini-2.5-pro" },
      new Set(["GEMINI_API_KEY"]),
    );
    expect(out).toContain("GEMINI_API_KEY=my-secret");
    expect(out).toContain("GEMINI_MODEL=gemini-2.5-pro");
    expect(out).not.toContain("github-copilot");
  });

  test("preserves comments and unrelated lines", () => {
    const existing = "# a comment\nOTHER=1\n\nFOO=old\n";
    const out = mergeEnvFile(existing, { FOO: "new" });
    expect(out).toContain("# a comment");
    expect(out).toContain("OTHER=1");
    expect(out).toContain("FOO=new");
  });
});

describe("mergeGeminiSettings", () => {
  test("sets security.auth.selectedType on empty", () => {
    const out = mergeGeminiSettings(undefined);
    expect(out.security.auth.selectedType).toBe("gemini-api-key");
  });

  test("preserves sibling keys", () => {
    const existing = {
      theme: "dark",
      security: { auth: { other: "x" }, ext: { list: [] } },
    };
    const out = mergeGeminiSettings(existing);
    expect(out.theme).toBe("dark");
    expect(out.security.auth.other).toBe("x");
    expect(out.security.auth.selectedType).toBe("gemini-api-key");
    expect(out.security.ext).toEqual({ list: [] });
  });

  test("does not mutate input", () => {
    const existing = { security: { auth: { selectedType: "oauth" } } };
    const out = mergeGeminiSettings(existing);
    expect(existing.security.auth.selectedType).toBe("oauth");
    expect(out.security.auth.selectedType).toBe("gemini-api-key");
  });
});
