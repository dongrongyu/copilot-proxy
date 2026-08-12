# Login Default Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each login command select its own OAuth endpoint and persist matching public or MSFT GHE upstream endpoints only after authentication succeeds.

**Architecture:** Keep endpoint derivation in `src/cli/login.ts`: resolve an in-memory endpoint set from the current command, pass its REST origin to Device Flow, and persist its REST/Copilot origins after token acquisition. Exercise the real CLI orchestration in child Bun processes with isolated homes while mocking only the external OAuth network boundary.

**Tech Stack:** TypeScript, Bun, `bun:test`, Commander, YAML configuration, npm registry.

## Global Constraints

- `copilot-proxy login` must always authenticate through `https://github.com`.
- `copilot-proxy login --msft-ghe-endpoint` must authenticate through `https://msft.ghe.com`.
- Successful public login must persist `https://api.github.com` and `https://api.githubcopilot.com`.
- Successful MSFT GHE login must persist `https://api.msft.ghe.com` and `https://copilot-api.msft.ghe.com`.
- Device Flow failure must leave endpoint configuration unchanged.
- Preserve the existing token location, CLI flag, standalone endpoint-configuration behavior, comments, and line endings.
- All source code, comments, test names, logs, and commit messages must be English.
- Never read from or write to the live proxy configuration during automated login tests.
- Do not stage or modify the pre-existing untracked `.agents/`, `.claude/skills/`, or `.claude/worktrees/` content.

---

### Task 1: Reproduce and Fix Login Endpoint Selection

**Files:**
- Create: `tests/fixtures/login-flow.ts`
- Create: `tests/unit/cli/login.test.ts`
- Modify: `src/cli/login.ts:1-48`
- Include: `docs/superpowers/plans/2026-08-12-login-default-endpoint.md`

**Interfaces:**
- Consumes: `loginCommand(options?: LoginOptions)`, `resolveGheEndpoints(endpoint)`, `updateUpstreamEndpoints(updates)`, and the existing config/token filesystem contract.
- Produces: current-command endpoint selection, post-authentication persistence of both upstream fields, and isolated orchestration regression coverage.

- [ ] **Step 1: Add the isolated Device Flow fixture**

Create `tests/fixtures/login-flow.ts`:

```typescript
import { loginCommand } from "../../src/cli/login";
import { MSFT_GHE_ENDPOINT } from "../../src/auth/github-endpoints";

type LoginMode = "public" | "ghe" | "ghe-fail";

const mode = process.argv[2] as LoginMode | undefined;
if (mode !== "public" && mode !== "ghe" && mode !== "ghe-fail") {
  throw new Error("Expected login fixture mode: public | ghe | ghe-fail");
}

const requestedUrls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  requestedUrls.push(url);

  if (mode === "ghe-fail") {
    return new Response("", { status: 500 });
  }

  if (url.endsWith("/login/device/code")) {
    return Response.json({
      device_code: "fixture-device-code",
      user_code: "TEST-CODE",
      verification_uri: url.replace(/\/code$/, ""),
      interval: 0,
      expires_in: 60,
    });
  }

  return Response.json({ access_token: "fixture-token" });
}) as typeof fetch;

await loginCommand(
  mode === "public" ? {} : { gheEndpoint: MSFT_GHE_ENDPOINT },
);
console.log(`REQUESTED_URLS=${JSON.stringify(requestedUrls)}`);
```

- [ ] **Step 2: Add orchestration regression tests**

Create `tests/unit/cli/login.test.ts`:

```typescript
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

  async function runLogin(mode: LoginMode) {
    const proc = Bun.spawn(["bun", "run", FIXTURE_PATH, mode], {
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
});
```

- [ ] **Step 3: Run the new tests and verify RED**

Run:

```bash
bun test tests/unit/cli/login.test.ts
```

Expected: both public-login tests fail because saved GHE state still controls OAuth/config, the failed-GHE test fails because config changes before OAuth, and the successful-GHE characterization passes.

- [ ] **Step 4: Implement current-command selection and post-success persistence**

In `src/cli/login.ts`, replace saved-config login selection with:

```typescript
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getConfigDir, updateUpstreamEndpoints } from "../config/loader";
import { loginWithDeviceFlow } from "../auth/github-token";
import {
  DEFAULT_COPILOT_API_BASE_URL,
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_WEB_BASE_URL,
  resolveGheEndpoints,
  type GitHubEnterpriseEndpoints,
} from "../auth/github-endpoints";

function resolveLoginEndpoints(gheEndpoint?: string): GitHubEnterpriseEndpoints {
  if (gheEndpoint) return resolveGheEndpoints(gheEndpoint);
  return {
    github_web_base_url: DEFAULT_GITHUB_WEB_BASE_URL,
    github_api_base_url: DEFAULT_GITHUB_API_BASE_URL,
    copilot_api_base_url: DEFAULT_COPILOT_API_BASE_URL,
  };
}

function persistUpstreamEndpoints(endpoints: GitHubEnterpriseEndpoints): string {
  return updateUpstreamEndpoints({
    github_api_base_url: endpoints.github_api_base_url,
    copilot_api_base_url: endpoints.copilot_api_base_url,
  });
}

export function configureGheEndpoint(endpoint: string): GitHubEnterpriseEndpoints {
  const resolved = resolveGheEndpoints(endpoint);
  const configPath = persistUpstreamEndpoints(resolved);

  console.log(`Configured GHE endpoints in ${configPath}:`);
  console.log(`  GitHub OAuth: ${resolved.github_web_base_url}`);
  console.log(`  GitHub API:   ${resolved.github_api_base_url}`);
  console.log(`  Copilot API:  ${resolved.copilot_api_base_url}`);
  return resolved;
}

export interface LoginOptions {
  gheEndpoint?: string;
}

export async function loginCommand(options: LoginOptions = {}) {
  try {
    const endpoints = resolveLoginEndpoints(options.gheEndpoint);
    const token = await loginWithDeviceFlow(endpoints.github_api_base_url);
    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true });
    const tokenPath = join(configDir, "github_token.txt");
    writeFileSync(tokenPath, token, "utf-8");
    const configPath = persistUpstreamEndpoints(endpoints);
    console.log(`\nGitHub token saved to: ${tokenPath}`);
    console.log(`GitHub endpoints saved to: ${configPath}`);
    console.log("If using systemd, run: copilot-proxy service reinstall");
  } catch (err) {
    console.error(`Login failed: ${err}`);
    process.exit(1);
  }
}
```

- [ ] **Step 5: Run targeted tests and verify GREEN**

```bash
bun test tests/unit/cli/login.test.ts tests/unit/auth/github-token-flow.test.ts tests/unit/auth/github-endpoints.test.ts tests/unit/config/upstream-endpoints-config.test.ts
```

Expected: all targeted tests pass with no warnings or leaked temporary files.

- [ ] **Step 6: Run the full unit suite**

```bash
bun run test:unit
```

Expected: all unit tests pass.

- [ ] **Step 7: Commit the implementation**

```bash
git add docs/superpowers/plans/2026-08-12-login-default-endpoint.md tests/fixtures/login-flow.ts tests/unit/cli/login.test.ts src/cli/login.ts
git commit -m "fix: restore public GitHub login default"
```

### Task 2: Verify and Prepare Release 0.1.33

**Files:**
- Modify: `package.json:3`
- Verify unchanged: `bun.lock`

**Interfaces:**
- Consumes: repository scripts `typecheck`, `test:unit`, `test:e2e`, `build`, and `prepublishOnly`.
- Produces: a verified `@ascdong/copilot-proxy@0.1.33` package candidate.

- [ ] **Step 1: Run static and build checks**

Run separately:

```bash
bun run typecheck
bun run test:unit
bun run build
```

Expected: every command exits zero.

- [ ] **Step 2: Run the real e2e suite in an isolated home**

Run each command separately:

```bash
CP_E2E_HOME="$(mktemp -d -p /tmp copilot-proxy-release-e2e.XXXXXX)"
mkdir -p "$CP_E2E_HOME/.copilot-proxy"
cp /home/rongyu/.copilot-proxy/github_token.txt "$CP_E2E_HOME/.copilot-proxy/github_token.txt"
cp /home/rongyu/.copilot-proxy/config.yaml "$CP_E2E_HOME/.copilot-proxy/config.yaml"
env HOME="$CP_E2E_HOME" bun run test:e2e
find "$CP_E2E_HOME" -depth -delete
```

Expected: all real OpenAI/Anthropic/config e2e tests pass, the temporary home is deleted, and live configuration/service state remains untouched.

- [ ] **Step 3: Bump `package.json`**

Change:

```json
"version": "0.1.33"
```

The current `bun.lock` stores no workspace version, so leave it unchanged unless Bun legitimately rewrites dependency state.

- [ ] **Step 4: Re-run the publish gate and inspect package contents**

Run separately:

```bash
bun run prepublishOnly
npm pack --dry-run
```

Expected: the publish gate passes and the dry run contains only files allowed by the package `files` field plus npm metadata.

- [ ] **Step 5: Commit the release version**

```bash
git add package.json
git commit -m "0.1.33: restore public GitHub login default"
```

### Task 3: Publish and Push

**Files:**
- No additional source changes expected.

**Interfaces:**
- Consumes: npm authentication for `ascdong`, package version `0.1.33`, and remote `origin`.
- Produces: published `@ascdong/copilot-proxy@0.1.33` and matching commits on `origin/main`.

- [ ] **Step 1: Reconfirm release state**

Run separately:

```bash
npm whoami
npm view @ascdong/copilot-proxy version
git status --short --branch
git log --oneline --decorate -4
```

Expected: npm user is `ascdong`, registry latest is `0.1.32`, tracked files are clean, and local `main` contains the design, implementation, and release commits.

- [ ] **Step 2: Publish**

```bash
npm publish --access public
```

Expected: npm reports `+ @ascdong/copilot-proxy@0.1.33`.

- [ ] **Step 3: Verify registry visibility**

```bash
npm view @ascdong/copilot-proxy@0.1.33 version
```

Expected: `0.1.33`.

- [ ] **Step 4: Push matching commits**

```bash
git push origin main
```

Expected: `origin/main` advances to the local release commit.

- [ ] **Step 5: Verify final state**

Run separately:

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
npm view @ascdong/copilot-proxy version
```

Expected: local `HEAD` equals `origin/main`, registry latest is `0.1.33`, and only the pre-existing untracked support directories plus `.planning/` remain.
