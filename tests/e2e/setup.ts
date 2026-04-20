/**
 * E2E test setup: start a real copilot-proxy server with real GitHub token.
 */
import { loadConfig } from "../../src/config/loader";
import { initState, getState } from "../../src/auth/state";
import { getGitHubToken } from "../../src/auth/github-token";
import { ensureCopilotToken, fetchModels } from "../../src/auth/copilot-token";
import { createApp } from "../../src/server";

let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = "";

export async function startTestServer(): Promise<string> {
  if (server) return baseUrl;

  const config = loadConfig();
  // Use random high port to avoid conflicts
  config.port = 19000 + Math.floor(Math.random() * 1000);
  config.address = "localhost";

  const state = initState(config);
  state.github_token = getGitHubToken();
  await ensureCopilotToken();
  await fetchModels();

  const app = createApp();
  server = Bun.serve({
    hostname: config.address,
    port: config.port,
    fetch: app.fetch,
  });

  baseUrl = `http://localhost:${server.port}`;
  return baseUrl;
}

export function stopTestServer() {
  if (server) {
    server.stop();
    server = null;
  }
}

export function getBaseUrl(): string {
  return baseUrl;
}

export async function postMessages(model: string, content: string, stream = false, maxTokens = 50) {
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream,
      messages: [{ role: "user", content }],
    }),
  });
}

export async function parseSSEEvents(resp: Response): Promise<any[]> {
  const text = await resp.text();
  const events: any[] = [];
  let currentEventType = "";

  for (const line of text.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEventType = line.slice(7);
    } else if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (data === "[DONE]") break;
      try {
        events.push({ type: currentEventType, data: JSON.parse(data) });
      } catch {}
      currentEventType = "";
    }
  }
  return events;
}
