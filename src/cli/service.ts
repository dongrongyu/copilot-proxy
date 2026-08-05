import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { loadConfig } from "../config/loader";

const SERVICE_NAME = "copilot-proxy";
const PACKAGE_NAME = "@ascdong/copilot-proxy";

function getServiceDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function getServicePath(): string {
  return join(getServiceDir(), `${SERVICE_NAME}.service`);
}

export async function serviceCommand(action: "install" | "uninstall" | "reinstall") {
  if (action === "install") {
    installService();
  } else if (action === "uninstall") {
    uninstallService();
  } else {
    uninstallService();
    console.log("");
    installService();
  }
}

/**
 * Build the unit's ExecStart line.
 *
 * Preference order:
 *   1. npx — resolves `@latest` from the registry on every start, so the
 *      service picks up new releases without a manual reinstall, and installs
 *      the package on a machine that has never had it.
 *   2. An already-installed `copilot-proxy` on PATH.
 *   3. The currently-running script under the current runtime (dev checkout).
 *
 * Two consequences of preferring npx, both deliberate:
 *   - Start-up costs a registry round trip (~1.5s warm, longer when a new
 *     version actually downloads).
 *   - `@latest` does NOT fall back to the npm cache when the registry is
 *     unreachable; it exits non-zero and systemd's start limiter eventually
 *     gives up. Dropping the `@latest` suffix trades "always newest" for
 *     "starts from cache when offline" if that is the better tradeoff later.
 */
function resolveExecStart(port: number, host: string): string {
  // systemd requires an absolute path for the first ExecStart token, so
  // resolve npx rather than relying on the inherited PATH.
  try {
    const npxPath = execSync("which npx", { encoding: "utf-8" }).trim();
    if (npxPath) {
      return `${npxPath} -y ${PACKAGE_NAME}@latest start --port ${port} --host ${host}`;
    }
  } catch {}

  try {
    const binPath = execSync("which copilot-proxy", { encoding: "utf-8" }).trim();
    if (binPath) {
      return `${binPath} start --port ${port} --host ${host}`;
    }
  } catch {}

  // Fallback (dev / not-yet-installed): invoke the current script with the
  // current runtime. process.argv[1] is the entry that is running right now,
  // process.execPath is the bun/node binary.
  const runtime = process.execPath;
  const script = process.argv[1];
  if (!script) {
    throw new Error(
      "Could not resolve the proxy entry point. Install the package globally " +
      "(e.g. `bun install -g .` or `npm i -g copilot-proxy`) and retry."
    );
  }
  return `${runtime} run ${script} start --port ${port} --host ${host}`;
}

function installService() {
  const config = loadConfig();

  const execStart = resolveExecStart(config.port, config.address);

  // File-based logins are read by the proxy at startup. Only carry through an
  // explicitly supplied environment token; embedding the token file here
  // would make a later `login` keep using the stale value from the unit.
  let tokenEnv = "";
  if (process.env.GITHUB_TOKEN) {
    tokenEnv = `Environment=GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`;
  }

  const serviceContent = `[Unit]
Description=Copilot Proxy - GitHub Copilot Model API Proxy
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
${tokenEnv}
Environment="PATH=${process.env.PATH}"

[Install]
WantedBy=default.target
`;

  const serviceDir = getServiceDir();
  const { mkdirSync } = require("fs");
  mkdirSync(serviceDir, { recursive: true });

  const servicePath = getServicePath();
  writeFileSync(servicePath, serviceContent, "utf-8");
  console.log(`[Service] Written: ${servicePath}`);

  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
    execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: "inherit" });
    execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: "inherit" });
    console.log(`[Service] ${SERVICE_NAME} installed and started.`);
    console.log(`\n  Check status: systemctl --user status ${SERVICE_NAME}`);
    console.log(`  View logs:    journalctl --user -u ${SERVICE_NAME} -f`);
  } catch (err) {
    console.error(`[Service] Failed to enable/start service: ${err}`);
    console.log(`\n  Manual steps:`);
    console.log(`    systemctl --user daemon-reload`);
    console.log(`    systemctl --user enable --now ${SERVICE_NAME}`);
  }
}

function uninstallService() {
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: "inherit" });
  } catch {}
  try {
    execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: "inherit" });
  } catch {}

  const servicePath = getServicePath();
  if (existsSync(servicePath)) {
    unlinkSync(servicePath);
    console.log(`[Service] Removed: ${servicePath}`);
  }

  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
  } catch {}

  console.log(`[Service] ${SERVICE_NAME} uninstalled.`);
}
