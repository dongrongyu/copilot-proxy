import { serve } from "@hono/node-server";
import { loadConfig, ensureConfigFile, getConfigPath } from "../config/loader";
import { initState } from "../auth/state";
import { getGitHubToken } from "../auth/github-token";
import { ensureCopilotToken, fetchModels } from "../auth/copilot-token";
import { createApp } from "../server";
import { cleanupOldLogs } from "../usage/logger";

export async function startServer(opts: { port?: string; host?: string }) {
  // Write the default config on first run so users have a file to edit.
  if (ensureConfigFile()) {
    console.log(`[Config] Created default config at: ${getConfigPath()}`);
  }

  const config = loadConfig();
  if (opts.port) config.port = parseInt(opts.port, 10);
  if (opts.host) config.address = opts.host;

  const state = initState(config);

  // Get GitHub token
  try {
    state.github_token = getGitHubToken();
  } catch (err) {
    console.error(`${err}`);
    process.exit(1);
  }

  // Get Copilot token
  try {
    await ensureCopilotToken();
  } catch (err) {
    console.error(`[Start] Failed to get Copilot token: ${err}`);
    process.exit(1);
  }

  // Fetch models
  try {
    await fetchModels();
    printModels();
  } catch (err) {
    console.error(`[Start] Failed to fetch models: ${err}`);
  }

  // Create and start server
  const app = createApp();

  // Clean up old request logs on startup (default retention: 180 days)
  cleanupOldLogs();

  console.log(`\n[Server] Starting on http://${config.address}:${config.port}`);

  const server = serve({
    fetch: app.fetch,
    hostname: config.address,
    port: config.port,
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[Server] Shutting down...");
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`[Server] Listening on http://${config.address}:${config.port}`);
}

function printModels() {
  const { getState } = require("../auth/state");
  const state = getState();
  if (!state.models?.data) return;

  console.log("\n" + "=".repeat(80));
  console.log("Available Models:");
  console.log("=".repeat(80));
  for (const m of state.models.data) {
    const caps = m.capabilities ?? {};
    const limits = caps.limits ?? {};
    const ctx = limits.max_context_window_tokens ?? 0;
    const ctxStr = ctx >= 1000 ? `${Math.floor(ctx / 1000)}K` : String(ctx);
    const endpoints = (m.supported_endpoints ?? []).join(", ");
    const flags = [
      caps.supports?.vision ? "Vision" : "",
      caps.supports?.tool_calls ? "Tool" : "",
      (m.supported_endpoints ?? []).includes("/v1/messages") ? "Anthropic" : "",
      m.preview ? "Preview" : "",
    ].filter(Boolean).join(",");
    console.log(`  ${m.id.padEnd(30)} ctx:${ctxStr.padEnd(6)} [${m.vendor ?? "?"}] (${flags})`);
  }
  console.log("=".repeat(80) + "\n");
}
