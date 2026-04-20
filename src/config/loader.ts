import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import yaml from "js-yaml";
import type { Config } from "./schema";
import { DEFAULT_CONFIG } from "./schema";

export function getConfigDir(): string {
  return join(homedir(), ".copilot-proxy");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.yaml");
}

export function loadConfig(): Config {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = readFileSync(configPath, "utf-8");
    const userConfig = yaml.load(content) as Partial<Config> | null;
    if (!userConfig) return { ...DEFAULT_CONFIG };

    return {
      ...DEFAULT_CONFIG,
      ...userConfig,
      model_mappings: {
        exact: {
          ...DEFAULT_CONFIG.model_mappings.exact,
          ...(userConfig.model_mappings?.exact ?? {}),
        },
        prefix: {
          ...DEFAULT_CONFIG.model_mappings.prefix,
          ...(userConfig.model_mappings?.prefix ?? {}),
        },
      },
      web_search: {
        ...DEFAULT_CONFIG.web_search,
        ...(userConfig.web_search ?? {}),
      },
    };
  } catch (err) {
    console.error(`[Config] Failed to load config: ${err}`);
    return { ...DEFAULT_CONFIG };
  }
}

export function generateDefaultConfig(): string {
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
  const configPath = getConfigPath();

  const content = `# Copilot Proxy Configuration
# ============================

# Server Settings
address: localhost
port: 8989

# GitHub Copilot Account Type
# Options: "individual", "business", "enterprise"
account_type: individual

# Version strings (used in request headers to emulate VS Code)
vscode_version: "1.93.0"
api_version: "2025-04-01"
copilot_version: "0.26.7"

# Connection retry settings
max_connection_retries: 3

# Model Name Mappings
# Translate incoming model names to Copilot API model names.
# User mappings override built-in defaults.
# Two types: exact (full match) and prefix (startsWith match).
#
# Example:
#   exact:
#     "claude-opus-4-6[1m]": "claude-opus-4.6-1m"
#   prefix:
#     "claude-opus-4-6-": "claude-opus-4.6-1m"
model_mappings:
  exact: {}
  prefix: {}

# Web Search Fallback
# When Copilot rejects web_search tools, use built-in search instead.
web_search:
  enabled: false
  provider: "tavily"        # "tavily" or "searxng"
  tavily_api_key: ""
  searxng_url: "http://localhost:8888"

# Usage logging
save_usage_to_file: true
`;

  if (existsSync(configPath)) {
    console.log(`Config already exists at: ${configPath}`);
  } else {
    writeFileSync(configPath, content, "utf-8");
    console.log(`Config generated at: ${configPath}`);
  }

  return configPath;
}
