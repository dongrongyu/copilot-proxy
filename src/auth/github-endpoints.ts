import type { Config } from "../config/schema";

export const DEFAULT_GITHUB_WEB_BASE_URL = "https://github.com";
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
export const DEFAULT_COPILOT_API_BASE_URL = "https://api.githubcopilot.com";
export const MSFT_GHE_ENDPOINT = "https://msft.ghe.com";

export interface GitHubEnterpriseEndpoints {
  github_web_base_url: string;
  github_api_base_url: string;
  copilot_api_base_url: string;
}

function parseHttpsOrigin(rawValue: string, label: string): URL {
  const raw = rawValue.trim();
  if (!raw) throw new Error(`${label} is required`);

  let parsed: URL;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error(`${label} is not a valid URL or hostname`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} contains unsupported URL components`);
  }
  if (parsed.pathname !== "/") {
    throw new Error(`${label} must not contain a path`);
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error(`${label} only supports the default HTTPS port`);
  }
  return parsed;
}

/**
 * Normalize a GHE.com tenant, REST API, or Copilot API origin into all three
 * endpoints required by Device Flow and Copilot traffic.
 */
export function resolveGheEndpoints(endpoint: string): GitHubEnterpriseEndpoints {
  const parsed = parseHttpsOrigin(endpoint, "GHE endpoint");
  let tenantHostname = parsed.hostname.toLowerCase();
  if (tenantHostname.startsWith("copilot-api.")) {
    tenantHostname = tenantHostname.slice("copilot-api.".length);
  } else if (tenantHostname.startsWith("api.")) {
    tenantHostname = tenantHostname.slice("api.".length);
  }

  if (tenantHostname === "ghe.com" || !tenantHostname.endsWith(".ghe.com")) {
    throw new Error("GHE endpoint must identify a tenant under *.ghe.com");
  }

  return {
    github_web_base_url: `https://${tenantHostname}`,
    github_api_base_url: `https://api.${tenantHostname}`,
    copilot_api_base_url: `https://copilot-api.${tenantHostname}`,
  };
}

export function getGitHubApiBaseUrl(config: Config): string {
  return (config.github_api_base_url || DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, "");
}

export function getConfiguredCopilotApiBaseUrl(config: Config): string {
  return (config.copilot_api_base_url || DEFAULT_COPILOT_API_BASE_URL).replace(/\/+$/, "");
}

/** Derive the OAuth/Device Flow origin from a supported GitHub REST origin. */
export function getGitHubWebBaseUrl(githubApiBaseUrl: string): string {
  const parsed = parseHttpsOrigin(githubApiBaseUrl, "GitHub API endpoint");
  const hostname = parsed.hostname.toLowerCase();

  if (hostname === "api.github.com") return DEFAULT_GITHUB_WEB_BASE_URL;
  if (hostname.startsWith("api.") && hostname.endsWith(".ghe.com")) {
    const tenantHostname = hostname.slice("api.".length);
    if (tenantHostname !== "ghe.com") return `https://${tenantHostname}`;
  }

  throw new Error(
    "Cannot derive the GitHub Device Flow host; expected "
    + "https://api.github.com or https://api.<tenant>.ghe.com",
  );
}
