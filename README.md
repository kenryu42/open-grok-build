# open-grok-build

OpenCode plugin for **Grok Build** (`cli-chat-proxy.grok.com`): OAuth, payload sanitization, live billing via `/grok-build-usage` (TUI toast, no LLM turn), and Cursor-style tool shims. **No WebSearch.**

## Install

**Server** (provider, OAuth, tools) — `opencode.json`:

```json
{
  "plugin": ["open-grok-build"]
}
```

**TUI** (`/grok-build-usage` toast) — `~/.config/opencode/tui.json` (or project `tui.json`):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["open-grok-build"]
}
```

Local checkout (absolute path is most reliable):

```json
{
  "plugin": ["/path/to/open-grok-build"]
}
```

**Testing locally:** [docs/LOCAL_OPENCODE_TESTING.md](docs/LOCAL_OPENCODE_TESTING.md)

Connect: `/connect grok-build` → **Grok Build (cli-chat-proxy)** or `GROK_BUILD_OAUTH_TOKEN` + API key method.

Usage: in the OpenCode TUI, `/grok-build-usage` shows billing quota in a toast (no LLM turn, no local cache).

**Important:** the slash is registered by the **TUI** plugin. Listing `open-grok-build` only in `opencode.json` loads the server (models/OAuth) but **will not** show `/grok-build-usage`. Add the same package to `~/.config/opencode/tui.json` (or project `.opencode/tui.json`). Restart the TUI after changes.

## Tool shims

`Grep`, `Glob`, `LS`, `Read`, `Write`, `StrReplace`, `Edit`, `Delete`, `Shell` (plugin `tool` hooks).

## Environment

| Variable | Default | Description |
|---|---|---|
| `GROK_BUILD_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | API base URL |
| `GROK_BUILD_MODELS` | (catalog) | Comma-separated model IDs |
| `GROK_BUILD_OAUTH_CLIENT_ID` | (built-in default) | OAuth client id override |
| `GROK_BUILD_CALLBACK_HOST` / `GROK_BUILD_CALLBACK_PORT` | `127.0.0.1` / `56122` | OAuth loopback callback |
| `GROK_BUILD_OAUTH_TOKEN` | — | Static token bypass (no refresh) |

## OpenCode packaging

`@opencode-ai/plugin` and `@opencode-ai/sdk` are **runtime `dependencies`** (not peer-only) so OpenCode’s Bun install pulls them when this package is loaded from npm. See [docs/OPENCODE_PLUGIN_SETUP.md](docs/OPENCODE_PLUGIN_SETUP.md).

## Development

```bash
bun install
bun run test
bun run typecheck
```