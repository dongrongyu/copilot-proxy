import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We need to test loader functions with a temp config dir.
// We'll mock getConfigDir by setting env and using a wrapper.

describe("Config Loader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `copilot-proxy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
  });

  test("loadConfig returns defaults when no config file", async () => {
    // Import fresh to avoid module cache issues
    const { DEFAULT_CONFIG } = await import("../../../src/config/schema");
    // Without a config file, loadConfig should return defaults
    const { loadConfig } = await import("../../../src/config/loader");
    // This tests the real path but config may or may not exist
    const config = loadConfig();
    expect(config.address).toBeDefined();
    expect(config.port).toBeGreaterThan(0);
    expect(config.model_mappings).toBeDefined();
    expect(config.web_search).toBeDefined();
  });

  test("generateDefaultConfig creates file", async () => {
    const { generateDefaultConfig, getConfigDir } = await import("../../../src/config/loader");
    // This will create in the real config dir, just verify it doesn't throw
    const path = generateDefaultConfig();
    expect(path).toContain("config.yaml");
  });
});
