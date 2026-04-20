# copilot-proxy

Expose your GitHub Copilot subscription as **OpenAI-** and **Anthropic-compatible** HTTP endpoints, so any tool that speaks those APIs — Claude Code, Codex CLI, Gemini CLI, custom scripts — can route through Copilot.

Runs on Node.js ≥ 20 (or [Bun](https://bun.sh/) in development).

## Features

- **OpenAI-compatible**: `POST /v1/chat/completions`, `/chat/completions`, `/v1/responses` (streaming + non-streaming)
- **Anthropic-compatible**: `POST /v1/messages`, `/v1/messages/count_tokens` (streaming + non-streaming)
- **Format translation**: Anthropic ↔ OpenAI, and Responses ↔ Chat Completions for models that don't support `/v1/responses` natively (e.g. Claude via Copilot)
- **GitHub Device Flow OAuth** — one-time login, tokens persisted locally
- **Auto-refreshing Copilot token** — the short-lived upstream token is refreshed in the background
- **Model aliasing** — `claude-opus-4-6` ↔ `claude-opus-4.6`, etc.
- **Token usage tracking** — every request logged with `input_tokens` / `output_tokens` / `cache_read_input_tokens` / duration / status
- **One-shot client configuration** — wire Claude Code, Codex, and Gemini CLIs to this proxy without hand-editing settings files
- **systemd user service** — install/uninstall as a background service on Linux/WSL

## Install

Requires Bun ≥ 1.1.

```bash
bun install -g copilot-proxy
```

## Quickstart

```bash
# 1. Sign in to GitHub (Device Flow — opens your browser)
copilot-proxy login

# 2. Start the proxy (defaults to http://127.0.0.1:8989)
copilot-proxy start

# 3. (Optional) wire up a client CLI
copilot-proxy config claude   # or: codex | gemini | all
```

Once running, point any OpenAI/Anthropic client at the proxy:

```bash
# OpenAI-compatible
curl http://127.0.0.1:8989/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'

# Anthropic-compatible
curl http://127.0.0.1:8989/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-opus-4.6","max_tokens":256,"messages":[{"role":"user","content":"hi"}]}'
```

Any API key will do — the proxy uses your GitHub Copilot session, not the client-provided key.

## CLI

```
copilot-proxy <command> [options]

Commands:
  start [-p <port>] [-H <host>]        start the proxy server
  login                                sign in to GitHub via Device Flow OAuth
  config <claude|codex|gemini|all>     configure a client tool
         [-o <path>]                   override the settings output path
  usage [-m <YYYY-MM>]                 show token usage statistics
  logs  [-l <n>] [-e] [--model <m>]    show recent request logs
        [-d <YYYY-MM-DD>]
  service <install|uninstall>          manage the systemd user service (Linux/WSL)
```

Run `copilot-proxy --help` for the full listing with examples.

### `config` — wire up a client

```bash
copilot-proxy config claude    # writes ~/.claude/settings.json (+ Windows path under WSL)
copilot-proxy config codex     # writes ~/.codex/config.toml  (Copilot Proxy or AOAI mode)
copilot-proxy config gemini    # prints the GEMINI_API_* env vars to export
copilot-proxy config all       # all of the above
```

Existing settings are **merged**, not overwritten.

### `logs` — inspect requests

```
[13:34:22] 200  claude-opus-4.7          /v1/messages              1 in    938 out  21.2s
 │          │    │                        │                         │         │        └─ duration
 │          │    │                        │                         │         └─ output tokens
 │          │    │                        │                         └─ input tokens
 │          │    │                        └─ endpoint
 │          │    └─ model (translated name when aliased)
 │          └─ HTTP status
 └─ request time
```

Request logs live at `~/.config/copilot-proxy/requests-YYYY-MM-DD.jsonl`.

### `service install` (Linux/WSL)

Registers a **user-level** systemd unit (`~/.config/systemd/user/copilot-proxy.service`) that runs the proxy on boot/login and restarts on failure. Uses the globally-installed `copilot-proxy` binary, so it survives package updates.

```bash
copilot-proxy service install
systemctl --user status copilot-proxy
journalctl --user -u copilot-proxy -f
copilot-proxy service uninstall
```

On WSL, systemd must be enabled (`systemd=true` in `/etc/wsl.conf`). To keep the service running when no user is logged in: `loginctl enable-linger $USER`.

## Configuration file

Optional YAML at `~/.config/copilot-proxy/config.yaml`. Defaults are fine for most users; override `port` / `address` / `log level` as needed. Environment variable `GITHUB_TOKEN` can be used in place of the interactive login.

## Development

```bash
git clone https://github.com/dongrongyu/copilot-proxy.git
cd copilot-proxy
bun install
bun run src/index.ts --help     # run from source
bun test                        # unit tests
bun run typecheck               # tsc --noEmit
```

## License

MIT
