import { loadConfig, updateWebSearchConfig, getConfigPath } from "../config/loader";
import type { WebSearchUpdate } from "../config/loader";

/**
 * Provider registry. To add a new search provider (e.g. webiq):
 *   1. Add its key field to WebSearchConfig / WebSearchUpdate in schema/loader.
 *   2. Add a line here mapping the provider name to that field.
 *   3. Implement its search function in src/proxy/web-search.ts.
 * The CLI usage (`web-search use <provider> <key>`) then works unchanged.
 */
const PROVIDERS: Record<string, { keyField: keyof WebSearchUpdate }> = {
  tavily: { keyField: "tavily_api_key" },
  webiq: { keyField: "webiq_api_key" },
};

const KEY_PREVIEW_VISIBLE = 4;

function maskKey(key: string): string {
  if (!key) return "(not set)";
  if (key.length <= KEY_PREVIEW_VISIBLE) return "*".repeat(key.length);
  return `${key.slice(0, KEY_PREVIEW_VISIBLE)}${"*".repeat(key.length - KEY_PREVIEW_VISIBLE)}`;
}

function savedKeyFor(provider: string): string {
  const ws = loadConfig().web_search;
  const keyField = PROVIDERS[provider]?.keyField;
  return keyField ? (ws[keyField] as string) : "";
}

function printStatus(): void {
  const ws = loadConfig().web_search;
  const keyField = PROVIDERS[ws.provider]?.keyField;
  const keyValue = keyField ? (ws[keyField] as string) : "";
  console.log("\nWeb search configuration:");
  console.log(`  enabled:  ${ws.enabled}`);
  console.log(`  provider: ${ws.provider}`);
  if (keyField) console.log(`  key:      ${maskKey(keyValue)}`);
  console.log(`\n  config: ${getConfigPath()}`);
}

function printUsage(): void {
  const names = Object.keys(PROVIDERS).join(" | ");
  console.log("\nUsage:");
  console.log(`  copilot-proxy web-search use <${names}> [api-key]   switch provider (and set its key)`);
  console.log(`  copilot-proxy web-search on                          enable web search`);
  console.log(`  copilot-proxy web-search off                         disable web search`);
  console.log(`  copilot-proxy web-search status                      show current settings`);
}

function applyAndReport(updates: WebSearchUpdate, message: string): void {
  const path = updateWebSearchConfig(updates);
  console.log(`${message}: ${path}`);
  printStatus();
  console.log("\nRestart the proxy for changes to take effect.");
}

function handleUse(provider?: string, key?: string): void {
  if (!provider) {
    console.error("Missing provider. Usage: copilot-proxy web-search use <" + Object.keys(PROVIDERS).join(" | ") + "> [api-key]");
    process.exit(1);
  }
  const name = provider.toLowerCase();
  const entry = PROVIDERS[name];
  if (!entry) {
    console.error(`Unknown provider: ${provider}. Available: ${Object.keys(PROVIDERS).join(", ")}`);
    process.exit(1);
  }

  // Switch using the saved key — no key re-entry needed.
  if (!key) {
    if (!savedKeyFor(name)) {
      console.error(
        `No saved API key for "${name}". Provide one: copilot-proxy web-search use ${name} <api-key>`,
      );
      process.exit(1);
    }
    applyAndReport(
      { provider: name as WebSearchUpdate["provider"], enabled: true },
      `Switched to ${name} and enabled web search`,
    );
    return;
  }

  // Set/replace the key, switch provider, and enable.
  applyAndReport(
    {
      provider: name as WebSearchUpdate["provider"],
      enabled: true,
      [entry.keyField]: key,
    },
    `Set ${name} key and enabled web search`,
  );
}

export function webSearchCommand(action?: string, arg2?: string, arg3?: string): void {
  // No args → show status + usage hint.
  if (!action) {
    printStatus();
    printUsage();
    return;
  }

  switch (action.toLowerCase()) {
    case "status":
    case "show":
      printStatus();
      return;

    case "on":
    case "enable": {
      const ws = loadConfig().web_search;
      if (!savedKeyFor(ws.provider)) {
        console.error(
          `Cannot enable: no saved API key for provider "${ws.provider}". ` +
            `Set one with: copilot-proxy web-search use ${ws.provider} <api-key>`,
        );
        process.exit(1);
      }
      applyAndReport({ enabled: true }, "Enabled web search");
      return;
    }

    case "off":
    case "disable":
      applyAndReport({ enabled: false }, "Disabled web search");
      return;

    case "use":
      handleUse(arg2, arg3);
      return;

    default:
      // Friendly redirect when a provider name is used as the first word
      // (the pre-`use` habit): `web-search webiq <key>` → suggest `use`.
      if (PROVIDERS[action.toLowerCase()]) {
        console.error(
          `Did you mean: copilot-proxy web-search use ${action.toLowerCase()}` +
            (arg2 ? ` ${arg2}` : " <api-key>") + "?",
        );
      } else {
        console.error(`Unknown action: ${action}.`);
      }
      printUsage();
      process.exit(1);
  }
}
