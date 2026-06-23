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
  models: { data: CopilotModel[] } | null;
  config: Config;
}

let _state: State | null = null;

export function initState(config: Config): State {
  _state = {
    github_token: "",
    copilot_token: "",
    token_expires_at: 0,
    models: null,
    config,
  };
  return _state;
}

export function getState(): State {
  if (!_state) throw new Error("State not initialized. Call initState() first.");
  return _state;
}
