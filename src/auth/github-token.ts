import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../config/loader";
import {
  DEFAULT_GITHUB_API_BASE_URL,
  getGitHubWebBaseUrl,
} from "./github-endpoints";

const GITHUB_OAUTH_CLIENT_ID = "01ab8ac9400c4e429b23";
const GITHUB_OAUTH_SCOPE = "read:user copilot";

export function getGitHubToken(): string {
  // Priority 1: Environment variable
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) {
    console.log("[Auth] Using GitHub token from GITHUB_TOKEN env var");
    return envToken;
  }

  // Priority 2: Token file
  const tokenPath = join(getConfigDir(), "github_token.txt");
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf-8").trim();
    if (token) {
      console.log("[Auth] Using GitHub token from file");
      return token;
    }
  }

  throw new Error(
    "No GitHub token found. Set GITHUB_TOKEN env var, " +
    `place token in ${join(getConfigDir(), "github_token.txt")}, ` +
    "or run: copilot-proxy login"
  );
}

export async function loginWithDeviceFlow(
  githubApiBaseUrl = DEFAULT_GITHUB_API_BASE_URL,
): Promise<string> {
  const githubWebBaseUrl = getGitHubWebBaseUrl(githubApiBaseUrl);
  console.log(`[Auth] Starting GitHub Device Flow on ${githubWebBaseUrl}...`);

  // Step 1: Request device code
  const codeResp = await fetch(`${githubWebBaseUrl}/login/device/code`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      scope: GITHUB_OAUTH_SCOPE,
    }),
  });

  if (!codeResp.ok) {
    throw new Error(`Device code request failed: ${codeResp.status}`);
  }

  const codeData = (await codeResp.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
  };

  console.log(`\nPlease visit: ${codeData.verification_uri}`);
  console.log(`Enter code: ${codeData.user_code}\n`);

  // Step 2: Poll for token
  const interval = Math.max(codeData.interval ?? 5, 0) * 1000;
  const deadline = Date.now() + codeData.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));

    const tokenResp = await fetch(
      `${githubWebBaseUrl}/login/oauth/access_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: GITHUB_OAUTH_CLIENT_ID,
          device_code: codeData.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      }
    );

    const tokenData = (await tokenResp.json()) as {
      access_token?: string;
      error?: string;
    };

    if (tokenData.access_token) {
      console.log("[Auth] GitHub login successful!");
      return tokenData.access_token;
    }

    if (tokenData.error === "authorization_pending") {
      continue;
    }

    if (tokenData.error === "slow_down") {
      await new Promise((r) => setTimeout(r, interval));
      continue;
    }

    if (tokenData.error === "expired_token") {
      throw new Error("Device code expired. Please try again.");
    }

    throw new Error(`OAuth error: ${tokenData.error}`);
  }

  throw new Error("Device flow timed out.");
}
