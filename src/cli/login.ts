import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../config/loader";
import { loginWithDeviceFlow } from "../auth/github-token";

export async function loginCommand() {
  try {
    const token = await loginWithDeviceFlow();
    const configDir = getConfigDir();
    mkdirSync(configDir, { recursive: true });
    const tokenPath = join(configDir, "github_token.txt");
    writeFileSync(tokenPath, token, "utf-8");
    console.log(`\nGitHub token saved to: ${tokenPath}`);
  } catch (err) {
    console.error(`Login failed: ${err}`);
    process.exit(1);
  }
}
