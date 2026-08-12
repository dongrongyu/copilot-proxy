import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getConfigDir, updateUpstreamEndpoints } from "../config/loader";
import { loginWithDeviceFlow } from "../auth/github-token";
import {
  DEFAULT_COPILOT_API_BASE_URL,
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_WEB_BASE_URL,
  resolveGheEndpoints,
  type GitHubEnterpriseEndpoints,
} from "../auth/github-endpoints";

function resolveLoginEndpoints(gheEndpoint?: string): GitHubEnterpriseEndpoints {
  if (gheEndpoint) return resolveGheEndpoints(gheEndpoint);
  return {
    github_web_base_url: DEFAULT_GITHUB_WEB_BASE_URL,
    github_api_base_url: DEFAULT_GITHUB_API_BASE_URL,
    copilot_api_base_url: DEFAULT_COPILOT_API_BASE_URL,
  };
}

function persistUpstreamEndpoints(endpoints: GitHubEnterpriseEndpoints): string {
  return updateUpstreamEndpoints({
    github_api_base_url: endpoints.github_api_base_url,
    copilot_api_base_url: endpoints.copilot_api_base_url,
  });
}

export function configureGheEndpoint(endpoint: string): GitHubEnterpriseEndpoints {
  const resolved = resolveGheEndpoints(endpoint);
  const configPath = persistUpstreamEndpoints(resolved);

  console.log(`Configured GHE endpoints in ${configPath}:`);
  console.log(`  GitHub OAuth: ${resolved.github_web_base_url}`);
  console.log(`  GitHub API:   ${resolved.github_api_base_url}`);
  console.log(`  Copilot API:  ${resolved.copilot_api_base_url}`);
  return resolved;
}

export interface LoginOptions {
  gheEndpoint?: string;
}

export async function loginCommand(options: LoginOptions = {}) {
  try {
    const endpoints = resolveLoginEndpoints(options.gheEndpoint);
    const token = await loginWithDeviceFlow(endpoints.github_api_base_url);
    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true });
    const tokenPath = join(configDir, "github_token.txt");
    writeFileSync(tokenPath, token, "utf-8");
    const configPath = persistUpstreamEndpoints(endpoints);
    console.log(`\nGitHub token saved to: ${tokenPath}`);
    console.log(`GitHub endpoints saved to: ${configPath}`);
    console.log("[Auth] GitHub login successful!");
    console.log("If using systemd, run: copilot-proxy service reinstall");
  } catch (err) {
    console.error(`Login failed: ${err}`);
    process.exit(1);
  }
}
