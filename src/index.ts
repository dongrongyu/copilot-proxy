#!/usr/bin/env node
import { Command } from "commander";
import { startServer } from "./cli/start";
import { configureGheEndpoint, loginCommand } from "./cli/login";
import { configCommand } from "./cli/config";
import { usageCommand } from "./cli/usage";
import { logsCommand } from "./cli/logs";
import { serviceCommand } from "./cli/service";
import { webSearchCommand } from "./cli/web-search";
import { effortCommand } from "./cli/effort";
import { VERSION } from "./version";
import { MSFT_GHE_ENDPOINT } from "./auth/github-endpoints";

const program = new Command();

program
  .name("copilot-proxy")
  .description("GitHub Copilot Model API Proxy — expose Copilot as OpenAI/Anthropic-compatible endpoints")
  .version(VERSION, "-V, --version", "show version")
  .option("--msft-ghe-endpoint", "use the Microsoft GHE tenant (https://msft.ghe.com)")
  .helpOption("-h, --help", "show help");

function useMsftGheEndpoint(local: {
  msftGheEndpoint?: boolean;
} = {}): boolean {
  const global = program.opts() as {
    msftGheEndpoint?: boolean;
  };
  return Boolean(local.msftGheEndpoint || global.msftGheEndpoint);
}

program
  .command("start")
  .description("start the proxy server")
  .option("-p, --port <port>", "port to listen on")
  .option("-H, --host <host>", "host to bind to")
  .action(startServer);

program
  .command("login")
  .description("sign in to GitHub via Device Flow OAuth")
  .option("--msft-ghe-endpoint", "sign in through https://msft.ghe.com")
  .action((opts) => loginCommand({
    gheEndpoint: useMsftGheEndpoint(opts) ? MSFT_GHE_ENDPOINT : undefined,
  }));

program
  .command("config <target>")
  .description("configure a client tool: claude | codex | gemini | all")
  .option("-o, --output <path>", "custom output path for the generated settings file")
  .action((target, opts) => configCommand(target, opts));

program
  .command("usage")
  .description("show token usage statistics")
  .option("-m, --month <YYYY-MM>", "month to report")
  .action(usageCommand);

program
  .command("logs")
  .description("show recent request logs")
  .option("-l, --limit <n>", "number of entries to show", "20")
  .option("-e, --errors", "show only errors")
  .option("--model <model>", "filter by model name")
  .option("-d, --date <YYYY-MM-DD>", "logs for a specific date")
  .action(logsCommand);

program
  .command("service <action>")
  .description("manage the systemd user service: install | uninstall | reinstall (WSL/Linux)")
  .action((action: string) => {
    if (action !== "install" && action !== "uninstall" && action !== "reinstall") {
      console.error(`Unknown action: ${action}. Use: install | uninstall | reinstall`);
      process.exit(1);
    }
    serviceCommand(action);
  });

program
  .command("web-search [action] [arg2] [arg3]")
  .description("configure web search fallback: web-search use <tavily|webiq> [key] | on | off | status")
  .action((action, arg2, arg3) => webSearchCommand(action, arg2, arg3));

program
  .command("effort [value]")
  .description("set reasoning effort for supported requests: low | medium | high | xhigh | max | status")
  .action((value) => effortCommand(value));

program.addHelpText("after", `
Examples:
  $ copilot-proxy login                 sign in with your GitHub account
  $ copilot-proxy login --msft-ghe-endpoint
                                        sign in through msft.ghe.com
  $ copilot-proxy start                 run the proxy (default http://127.0.0.1:8989)
  $ copilot-proxy start -p 8080         run on a custom port
  $ copilot-proxy config claude         wire Claude Code to this proxy
  $ copilot-proxy web-search use webiq <key>   set WebIQ key, switch provider, enable
  $ copilot-proxy web-search use tavily        switch to Tavily using its saved key
  $ copilot-proxy web-search on                enable web search (current provider)
  $ copilot-proxy web-search off               disable web search
  $ copilot-proxy web-search status            show current web search settings
  $ copilot-proxy effort max                   set reasoning effort to max
  $ copilot-proxy effort status                show current reasoning effort
  $ copilot-proxy logs -e -l 50         tail the last 50 error requests
  $ copilot-proxy usage -m 2026-04      show token usage for April 2026
  $ copilot-proxy service install       install as a systemd user service
`);

program.action((opts) => {
  if (!useMsftGheEndpoint(opts)) {
    program.outputHelp();
    return;
  }
  try {
    configureGheEndpoint(MSFT_GHE_ENDPOINT);
    console.log("Run 'copilot-proxy login' to sign in through this tenant.");
  } catch (error) {
    console.error(`Failed to configure GHE endpoint: ${error}`);
    process.exitCode = 1;
  }
});

// Default to showing help when no command is given
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

program.parse();
