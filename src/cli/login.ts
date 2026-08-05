import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  getConfigDir,
  loadConfig,
  updateUpstreamEndpoints,
} from "../config/loader";
import { loginWithDeviceFlow } from "../auth/github-token";
import {
  getGitHubApiBaseUrl,
  resolveGheEndpoints,
  type GitHubEnterpriseEndpoints,
} from "../auth/github-endpoints";

export function configureGheEndpoint(endpoint: string): GitHubEnterpriseEndpoints {
  const resolved = resolveGheEndpoints(endpoint);
  const configPath = updateUpstreamEndpoints({
    github_api_base_url: resolved.github_api_base_url,
    copilot_api_base_url: resolved.copilot_api_base_url,
  });

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
    if (options.gheEndpoint) configureGheEndpoint(options.gheEndpoint);
    const config = loadConfig();
    const token = await loginWithDeviceFlow(getGitHubApiBaseUrl(config));
    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true });
    const tokenPath = join(configDir, "github_token.txt");
    writeFileSync(tokenPath, token, "utf-8");
    console.log(`\nGitHub token saved to: ${tokenPath}`);
    console.log("If using systemd, run: copilot-proxy service reinstall");
  } catch (err) {
    console.error(`Login failed: ${err}`);
    process.exit(1);
  }
}
