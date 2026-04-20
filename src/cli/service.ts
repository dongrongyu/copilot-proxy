import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { loadConfig, getConfigDir } from "../config/loader";

const SERVICE_NAME = "copilot-proxy";

function getServiceDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function getServicePath(): string {
  return join(getServiceDir(), `${SERVICE_NAME}.service`);
}

export async function serviceCommand(action: "install" | "uninstall") {
  if (action === "install") {
    installService();
  } else {
    uninstallService();
  }
}

function resolveExecStart(port: number, host: string): string {
  // Prefer the installed bin on PATH — stable across package updates/relocation.
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

  // Read GitHub token for env
  const tokenPath = join(getConfigDir(), "github_token.txt");
  let tokenEnv = "";
  if (existsSync(tokenPath)) {
    const { readFileSync } = require("fs");
    const token = readFileSync(tokenPath, "utf-8").trim();
    if (token) tokenEnv = `Environment=GITHUB_TOKEN=${token}`;
  } else if (process.env.GITHUB_TOKEN) {
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
Environment=PATH=${process.env.PATH}

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
