import type { Config } from "../config/schema";

export interface CopilotModel {
  id: string;
  name?: string;
  vendor?: string;
  preview?: boolean;
  capabilities?: {
    limits?: {
      max_prompt_tokens?: number;
      max_output_tokens?: number;
      max_context_window_tokens?: number;
    };
    supports?: {
      vision?: boolean;
      tool_calls?: boolean;
      reasoning_effort?: string[];
    };
  };
  supported_endpoints?: string[];
}

export interface State {
  github_token: string;
  copilot_token: string;
  token_expires_at: number;
  /**
   * Upstream Copilot API base URL, taken from the token response's
   * `endpoints.api` (so individual / business / enterprise accounts each hit the
   * right host automatically — no manual account_type to configure).
   */
  copilot_base_url: string;
  models: { data: CopilotModel[] } | null;
  config: Config;
}

let _state: State | null = null;

export function initState(config: Config): State {
  _state = {
    github_token: "",
    copilot_token: "",
    token_expires_at: 0,
    copilot_base_url: "",
    models: null,
    config,
  };
  return _state;
}

export function getState(): State {
  if (!_state) throw new Error("State not initialized. Call initState() first.");
  return _state;
}
