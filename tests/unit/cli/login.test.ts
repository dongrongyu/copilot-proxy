import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import yaml from "js-yaml";
import {
  DEFAULT_CONFIG_TEMPLATE,
  setUpstreamEndpointFields,
  type UpstreamEndpointUpdate,
} from "../../../src/config/loader";

type LoginMode = "public" | "ghe" | "ghe-fail";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../..");
const FIXTURE_PATH = resolve(import.meta.dir, "../../fixtures/login-flow.ts");
const PUBLIC_ENDPOINTS: UpstreamEndpointUpdate = {
  github_api_base_url: "https://api.github.com",
  copilot_api_base_url: "https://api.githubcopilot.com",
};
const GHE_ENDPOINTS: UpstreamEndpointUpdate = {
  github_api_base_url: "https://api.msft.ghe.com",
  copilot_api_base_url: "https://copilot-api.msft.ghe.com",
};

describe("login command endpoint selection", () => {
  let testHome = "";
  let configDir = "";
  let configPath = "";

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "copilot-proxy-login-"));
    configDir = join(testHome, ".copilot-proxy");
    configPath = join(configDir, "config.yaml");
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  function seedEndpoints(endpoints: UpstreamEndpointUpdate): string {
    mkdirSync(configDir, { recursive: true });
    const content = setUpstreamEndpointFields(DEFAULT_CONFIG_TEMPLATE, endpoints);
    writeFileSync(configPath, content, "utf-8");
    return content;
  }

  function readConfig(): Record<string, unknown> {
    return yaml.load(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  }

  async function runCommand(command: string[]) {
    const proc = Bun.spawn(command, {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = proc.stdout.text();
    const stderrPromise = proc.stderr.text();
    const exitCode = await proc.exited;
    return {
      exitCode,
      stdout: await stdoutPromise,
      stderr: await stderrPromise,
    };
  }

  function runLogin(mode: LoginMode) {
    return runCommand(["bun", "run", FIXTURE_PATH, mode]);
  }

  function runEntryPoint(...args: string[]) {
    return runCommand(["bun", "run", "src/index.ts", ...args]);
  }

  test("plain login ignores persisted GHE endpoints", async () => {
    seedEndpoints(GHE_ENDPOINTS);

    const result = await runLogin("public");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'REQUESTED_URLS=["https://github.com/login/device/code","https://github.com/login/oauth/access_token"]',
    );
  });

  test("successful plain login records public endpoints", async () => {
    seedEndpoints(GHE_ENDPOINTS);

    const result = await runLogin("public");

    expect(result.exitCode).toBe(0);
    const config = readConfig();
    expect(config.github_api_base_url).toBe("https://api.github.com");
    expect(config.copilot_api_base_url).toBe("https://api.githubcopilot.com");
    expect(readFileSync(join(configDir, "github_token.txt"), "utf-8"))
      .toBe("fixture-token");
  });

  test("MSFT GHE login records matching endpoints after success", async () => {
    seedEndpoints(PUBLIC_ENDPOINTS);

    const result = await runLogin("ghe");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'REQUESTED_URLS=["https://msft.ghe.com/login/device/code","https://msft.ghe.com/login/oauth/access_token"]',
    );
    const config = readConfig();
    expect(config.github_api_base_url).toBe("https://api.msft.ghe.com");
    expect(config.copilot_api_base_url).toBe("https://copilot-api.msft.ghe.com");
  });

  test("failed MSFT GHE login preserves the existing endpoint configuration", async () => {
    const originalConfig = seedEndpoints(PUBLIC_ENDPOINTS);

    const result = await runLogin("ghe-fail");

    expect(result.exitCode).toBe(1);
    expect(readFileSync(configPath, "utf-8")).toBe(originalConfig);
    expect(existsSync(join(configDir, "github_token.txt"))).toBe(false);
  });

  test("login reports success only after endpoint persistence", async () => {
    seedEndpoints(GHE_ENDPOINTS);

    const result = await runLogin("public");

    const endpointsSavedIndex = result.stdout.indexOf("GitHub endpoints saved to:");
    const successIndex = result.stdout.indexOf("[Auth] GitHub login successful!");
    expect(endpointsSavedIndex).toBeGreaterThan(-1);
    expect(successIndex).toBeGreaterThan(endpointsSavedIndex);
  });

  test("standalone MSFT GHE setup points to the flagged login command", async () => {
    const result = await runEntryPoint("--msft-ghe-endpoint");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Run 'copilot-proxy login --msft-ghe-endpoint' to sign in through this tenant.",
    );
  });
});
