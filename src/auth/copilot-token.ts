import { getState } from "./state";
import {
  getConfiguredCopilotApiBaseUrl,
  getGitHubApiBaseUrl as configuredGitHubApiBaseUrl,
} from "./github-endpoints";

function getGitHubHeaders(): Record<string, string> {
  const state = getState();
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `token ${state.github_token}`,
    "Editor-Version": `vscode/${state.config.vscode_version}`,
    "Editor-Plugin-Version": `copilot-chat/${state.config.copilot_version}`,
    "User-Agent": `GitHubCopilotChat/${state.config.copilot_version}`,
    "X-GitHub-Api-Version": state.config.api_version,
    "X-VSCode-User-Agent-Library-Version": "electron-fetch",
  };
}

export function getCopilotBaseUrl(): string {
  const state = getState();
  // An explicit GHE data-residency endpoint takes precedence. Otherwise use
  // the account-appropriate host returned by the token response.
  if (state.config.copilot_api_base_url) {
    return getConfiguredCopilotApiBaseUrl(state.config);
  }
  return state.copilot_base_url || getConfiguredCopilotApiBaseUrl(state.config);
}

export function getGitHubApiBaseUrl(): string {
  return configuredGitHubApiBaseUrl(getState().config);
}

let _refreshPromise: Promise<void> | null = null;

export async function refreshCopilotToken(): Promise<void> {
  const state = getState();

  // Check if still valid
  if (state.copilot_token && Date.now() < (state.token_expires_at - 60) * 1000) {
    return;
  }

  // Deduplicate concurrent refreshes
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    try {
      console.log("[Auth] Refreshing Copilot token...");
      const resp = await fetch(`${getGitHubApiBaseUrl()}/copilot_internal/v2/token`, {
        headers: getGitHubHeaders(),
      });

      if (!resp.ok) {
        throw new Error(`Failed to get Copilot token: ${resp.status} ${await resp.text()}`);
      }

      const data = (await resp.json()) as {
        token: string;
        refresh_in?: number;
        endpoints?: { api?: string };
      };
      state.copilot_token = data.token;
      state.token_expires_at = Date.now() / 1000 + (data.refresh_in ?? 1800);
      // Capture the account-appropriate upstream host (individual / business /
      // enterprise) straight from the token response, so we never have to guess.
      if (data.endpoints?.api) {
        state.copilot_base_url = data.endpoints.api;
      }
      console.log("[Auth] Copilot token refreshed successfully");
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

export async function ensureCopilotToken(): Promise<void> {
  const state = getState();
  if (!state.copilot_token || Date.now() / 1000 >= state.token_expires_at - 60) {
    await refreshCopilotToken();
  }
}

export async function fetchModels(): Promise<void> {
  await ensureCopilotToken();
  const state = getState();

  const resp = await fetch(`${getCopilotBaseUrl()}/models`, {
    headers: {
      Authorization: `Bearer ${state.copilot_token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": `vscode/${state.config.vscode_version}`,
      "Editor-Plugin-Version": `copilot-chat/${state.config.copilot_version}`,
      "User-Agent": `GitHubCopilotChat/${state.config.copilot_version}`,
      "X-GitHub-Api-Version": state.config.api_version,
    },
  });

  if (resp.ok) {
    state.models = (await resp.json()) as { data: any[] };
    console.log(`[Auth] Loaded ${state.models.data.length} models`);
  } else {
    console.error(`[Auth] Failed to fetch models: ${resp.status}`);
  }
}

export function supportsDirectAnthropicApi(modelId: string): boolean {
  const state = getState();
  if (!state.models?.data) return false;
  const model = state.models.data.find((m) => m.id === modelId);
  if (!model) return false;
  return (model.supported_endpoints ?? []).includes("/v1/messages");
}

export function supportsResponsesApi(modelId: string): boolean {
  const state = getState();
  if (!state.models?.data) return false;
  const model = state.models.data.find((m) => m.id === modelId);
  if (!model) return false;
  return (model.supported_endpoints ?? []).includes("/responses");
}
