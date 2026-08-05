export interface WebSearchConfig {
  enabled: boolean;
  provider: "tavily" | "searxng" | "webiq";
  tavily_api_key: string;
  webiq_api_key: string;
  searxng_url: string;
}

export interface ModelMappingsConfig {
  exact: Record<string, string>;
  prefix: Record<string, string>;
}

/**
 * Factory-default model name translations (Claude Code model name -> Copilot
 * model ID). This is the single source of truth for the defaults: it seeds the
 * generated config.yaml (so users can see and edit them) and is injected into
 * existing configs whose mappings are still empty. It is intentionally NOT part
 * of DEFAULT_CONFIG.model_mappings (which stays empty as the delete-everything
 * floor) — the real defaults live in the user's config file, not in code the
 * user never sees.
 *
 * Prefix rules normalize dash-form Claude Code names (e.g. "claude-opus-4-6-...")
 * to dot-form Copilot IDs. Dot-form names (e.g. "claude-opus-4.6-1m") are already
 * valid Copilot IDs and pass through verbatim, so they are deliberately absent
 * here — a dot-form prefix would wrongly strip suffixes like "-1m".
 */
export const DEFAULT_MODEL_MAPPINGS: ModelMappingsConfig = {
  exact: {
    opus: "claude-opus-4.8",
    sonnet: "claude-sonnet-4.6",
    haiku: "claude-haiku-4.5",
    "claude-opus-4-6": "claude-opus-4.6",
    "claude-opus-4-7": "claude-opus-4.7",
    "claude-opus-4-8": "claude-opus-4.8",
    "claude-opus-4-5": "claude-opus-4.5",
    "claude-haiku-4-5": "claude-haiku-4.5",
  },
  prefix: {
    "claude-sonnet-4-": "claude-sonnet-4.6",
    "claude-haiku-4-5-": "claude-haiku-4.5",
    "claude-opus-4-5-": "claude-opus-4.5",
    "claude-opus-4-6-": "claude-opus-4.6",
    "claude-opus-4-7-": "claude-opus-4.7",
    "claude-opus-4-8-": "claude-opus-4.8",
  },
};

export interface Config {
  address: string;
  port: number;
  github_api_base_url: string;
  copilot_api_base_url: string;
  vscode_version: string;
  api_version: string;
  copilot_version: string;
  max_connection_retries: number;
  /**
   * Target reasoning effort applied to supported requests, for models that
   * advertise a `reasoning_effort` capability. The proxy injects this value
   * (clamped to the nearest effort the model actually supports). Validation of
   * allowed values lives in the application layer, not here.
   */
  effort: string;
  model_mappings: ModelMappingsConfig;
  web_search: WebSearchConfig;
}

export const DEFAULT_CONFIG: Config = {
  address: "localhost",
  port: 8989,
  github_api_base_url: "",
  copilot_api_base_url: "",
  vscode_version: "1.93.0",
  api_version: "2025-04-01",
  copilot_version: "0.26.7",
  max_connection_retries: 3,
  effort: "xhigh",
  model_mappings: {
    exact: {},
    prefix: {},
  },
  web_search: {
    enabled: false,
    provider: "tavily",
    tavily_api_key: "",
    webiq_api_key: "",
    searxng_url: "http://localhost:8888",
  },
};
