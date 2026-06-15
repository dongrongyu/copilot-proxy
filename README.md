# copilot-proxy

Expose your GitHub Copilot subscription as **OpenAI-**, **Anthropic-**, and **Gemini-compatible** HTTP endpoints, so any tool that speaks those APIs — Claude Code, Codex CLI, Gemini CLI, custom scripts — can route through Copilot.

Runs on Node.js ≥ 20 (or [Bun](https://bun.sh/) in development).

## Features

- **OpenAI-compatible**: `POST /v1/chat/completions`, `/chat/completions`, `/v1/responses` (streaming + non-streaming), plus `GET /v1/models`
- **Anthropic-compatible**: `POST /v1/messages`, `/v1/messages/count_tokens` (streaming + non-streaming)
- **Gemini-compatible**: `POST /v1beta/models/{model}:generateContent` / `:streamGenerateContent` / `:countTokens`, plus `GET /v1beta/models` for CLI preflight
- **Format translation**: Anthropic ↔ OpenAI, Gemini ↔ OpenAI, and Responses ↔ Chat Completions for models that don't support `/v1/responses` natively (e.g. Claude via Copilot)
- **Web search fallback** via Tavily or WebIQ — when a model rejects Anthropic's `web_search` tool, the proxy runs the query and injects synthetic `server_tool_use` / `web_search_tool_result` blocks (Anthropic `/v1/messages` only — i.e. Claude Code)
- **Vision passthrough** — image inputs are forwarded to vision-capable Copilot models
- **GitHub Device Flow OAuth** — one-time login, tokens persisted locally
- **Auto-refreshing Copilot token** — the short-lived upstream token is refreshed in the background
- **Model aliasing** — `claude-opus-4-6` ↔ `claude-opus-4.6`, etc.
- **5-category token tracking** — every request logged with input / cache-creation / cache-read / output / reasoning tokens, duration, status
- **One-shot client configuration** for Claude Code, Codex, and Gemini CLIs
- **systemd user service** — install/uninstall as a background service on Linux/WSL

## Getting started

> **Use this from inside WSL.** Install the package in your WSL distro, log in once, then install it as a background service. The proxy listens on `127.0.0.1:8989` and serves **both WSL and Windows** clients on that port — there is no Windows-side install needed.

### 1. Open a WSL shell

```bash
wsl                 # or launch your distro from the Start menu
```

Make sure Node.js ≥ 20 is available inside WSL (`node -v`).

### 2. Install the package

```bash
npm install -g @ascdong/copilot-proxy
```

### 3. Sign in to GitHub

```bash
copilot-proxy login
```

A device-flow code is printed; open the URL in your browser and confirm. Tokens are persisted under `~/.copilot-proxy/`.

### 4. Install as a background service

```bash
copilot-proxy service install
```

This registers a **user-level systemd unit** that starts the proxy on login and restarts it on failure. Verify it's up:

```bash
systemctl --user status copilot-proxy
curl http://127.0.0.1:8989/v1/models   # should return JSON
```

From here, any OpenAI / Anthropic / Gemini client — running in WSL **or** in Windows — can point at `http://127.0.0.1:8989`. Any API key will do; the proxy uses your Copilot session, not the client-provided key.

### 5. (Optional) wire up a client CLI

```bash
copilot-proxy config claude    # writes ~/.claude/settings.json (+ Windows path under WSL)
copilot-proxy config codex     # writes ~/.codex/config.toml
copilot-proxy config gemini    # writes ~/.gemini/.env + ~/.gemini/settings.json
```

Existing settings are **merged**, not overwritten.

### Service management

```bash
copilot-proxy service reinstall   # apply package updates
copilot-proxy service uninstall
journalctl --user -u copilot-proxy -f
```

---

## Configuration options

Optional YAML at `~/.copilot-proxy/config.yaml` (auto-generated on first run). Defaults are fine for most users; override `port` / `address` / log level as needed. Environment variable `GITHUB_TOKEN` can be used in place of the interactive login.

### Web search fallback (Claude Code only)

When a model rejects Anthropic's `web_search` tool, the proxy can transparently run the query through a search provider and synthesize `server_tool_use` / `web_search_tool_result` blocks so the client still gets a normal Anthropic-shaped response.

> **This only applies to the Anthropic `/v1/messages` endpoint** — in practice, **Claude Code**. The OpenAI and Gemini endpoints do not have an equivalent `web_search` tool, so this fallback never triggers for Codex or Gemini CLI.

Configure it with the `web-search` command — no need to hand-edit the config file:

```bash
copilot-proxy web-search use tavily tvly-...     # set Tavily key, switch provider, enable
copilot-proxy web-search use webiq <key>         # set WebIQ key, switch provider, enable
copilot-proxy web-search use tavily              # switch to a provider with a saved key (no re-entry)
copilot-proxy web-search on                      # enable (current provider)
copilot-proxy web-search off                     # disable
copilot-proxy web-search status                  # show current settings (key masked)
```

Setting a provider key automatically enables web search and switches to that provider. Keys are saved in `~/.copilot-proxy/config.yaml`, so switching providers later doesn't require re-entering them. **Restart the proxy after any change** for it to take effect.

Supported providers:

| Provider | Key from |
| --- | --- |
| [Tavily](https://tavily.com) | `tvly-...` API key |
| WebIQ (`api.microsoft.ai`) | Microsoft AI API key |

With web search disabled (the default) or no key set, `web_search` requests are passed through unchanged.

---

## CLI reference

```
copilot-proxy <command> [options]

Commands:
  start [-p <port>] [-H <host>]        start the proxy server (foreground)
  login                                sign in to GitHub via Device Flow OAuth
  config <claude|codex|gemini>         configure a client tool
         [-o <path>]                   override the settings output path
  usage [-m <YYYY-MM>]                 show token usage statistics
  logs  [-l <n>] [-e] [--model <m>]    show recent request logs
        [-d <YYYY-MM-DD>]
  web-search use <tavily|webiq> [key]  configure web search fallback (Claude Code only)
            | on | off | status
  service <install|uninstall|reinstall>
                                       manage the systemd user service (Linux/WSL)
```

Run `copilot-proxy --help` for the full listing with examples.

### `logs` — inspect requests

```
[13:34:22] 200  claude-opus-4.7          /v1/messages       1 in   12 cc   84 cr  938 out   0 r  21.2s
 │          │    │                        │                  │      │       │      │         └─ reasoning tokens
 │          │    │                        │                  │      │       │      └─ output tokens
 │          │    │                        │                  │      │       └─ cache read tokens
 │          │    │                        │                  │      └─ cache creation tokens
 │          │    │                        │                  └─ fresh input tokens
 │          │    │                        └─ endpoint
 │          │    └─ model (translated name when aliased)
 │          └─ HTTP status
 └─ request time
```

Request logs live at `~/.copilot-proxy/logs/requests/YYYY-MM-DD.jsonl` (180-day retention by default; cleanup runs on server startup).

## References

- [sxwxs/ghc-api](https://github.com/sxwxs/ghc-api)
- [Joouis/agent-maestro](https://github.com/Joouis/agent-maestro)

## License

MIT
