export interface WebSearchConfig {
  enabled: boolean;
  provider: "tavily" | "searxng";
  tavily_api_key: string;
  searxng_url: string;
}

export interface ModelMappingsConfig {
  exact: Record<string, string>;
  prefix: Record<string, string>;
}

export interface Config {
  address: string;
  port: number;
  account_type: "individual" | "business" | "enterprise";
  vscode_version: string;
  api_version: string;
  copilot_version: string;
  max_connection_retries: number;
  model_mappings: ModelMappingsConfig;
  web_search: WebSearchConfig;
  save_usage_to_file: boolean;
}

export const DEFAULT_CONFIG: Config = {
  address: "localhost",
  port: 8989,
  account_type: "individual",
  vscode_version: "1.93.0",
  api_version: "2025-04-01",
  copilot_version: "0.26.7",
  max_connection_retries: 3,
  model_mappings: {
    exact: {},
    prefix: {},
  },
  web_search: {
    enabled: false,
    provider: "tavily",
    tavily_api_key: "",
    searxng_url: "http://localhost:8888",
  },
  save_usage_to_file: true,
};
