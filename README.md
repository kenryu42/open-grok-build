# open-grok-build

[![CI](https://github.com/kenryu42/open-grok-build/actions/workflows/ci.yml/badge.svg)](https://github.com/kenryu42/open-grok-build/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/kenryu42/open-grok-build?label=version&color=blue)](https://github.com/kenryu42/open-grok-build)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](https://opensource.org/licenses/MIT)


[OpenCode](https://opencode.ai) plugin that connects xAI's **Grok Build** models (`cli-chat-proxy.grok.com`) to your terminal. Ships OAuth 2.0 + PKCE authentication, a curated model catalog, payload sanitization for xAI API quirks, Cursor-style tool shims, and live billing queries — all as a drop-in plugin.

## Features

- **OAuth 2.0 + PKCE** — Browser-based login via `auth.x.ai` with automatic token refresh
- **Model catalog** — Six Grok Build models with correct cost, context window, and reasoning metadata
- **Payload sanitization** — Transparent rewrites for xAI's Responses API quirks (reasoning strip, image normalization, system→instructions, `response_format`→`text.format`, and more)
- **Tool shims** — Cursor-compatible filesystem and shell tools (`Grep`, `Glob`, `LS`, `Read`, `Write`, `StrReplace`, `Edit`, `Delete`, `Shell`)
- **Billing usage** — `/grok-build-usage` slash command shows live credit quota as a TUI toast (no LLM turn consumed)

## Quick Start

### 1. Install

```bash
opencode plugin -g open-grok-build
```

This registers both the server plugin (models, OAuth, payload sanitization, tool shims) and the TUI plugin (`/grok-build-usage` slash command). Restart the TUI after installing.

### 2. Connect

```
/connect grok-build → Grok Build (cli-chat-proxy)
```

Or set `GROK_BUILD_OAUTH_TOKEN` for a static token bypass (no auto-refresh).

### Local checkout

For development, use an absolute path:

```json
{
  "plugin": ["/path/to/open-grok-build"]
}
```

See [LOCAL_OPENCODE_TESTING.md](docs/LOCAL_OPENCODE_TESTING.md) for the full local testing workflow.

## Models

| Model | Context | Max Output | Reasoning | Input |
|---|---|---|---|---|
| `grok-composer-2.5-fast` | 200K | 30K | — | text, image |
| `grok-build` | 512K | 30K | ✓ | text, image |
| `grok-4.3` | 1M | 30K | ✓ | text, image |
| `grok-4.20-0309-reasoning` | 2M | 30K | ✓ | text, image |
| `grok-4.20-0309-non-reasoning` | 2M | 30K | — | text, image |
| `grok-4.20-multi-agent-0309` | 2M | 30K | ✓ | text, image |

Override with `GROK_BUILD_MODELS` (comma-separated model IDs). Unknown IDs get sensible defaults.

## Tool Shims

The plugin registers Cursor-compatible tool definitions that Grok Build models can call:

| Tool | Description |
|---|---|
| `Grep` / `Glob` | Search file contents and filenames |
| `LS` | List directory contents |
| `Read` | Read file contents |
| `Write` / `StrReplace` / `Edit` / `Delete` | Modify files |
| `Shell` | Execute shell commands |

`web_search` / `websearch` are suppressed — Grok Build does not support web search through this endpoint.

## Payload Sanitization

The plugin transparently rewrites outgoing requests to handle xAI's Responses API differences from stock OpenAI:

- Strips replayed `reasoning` items (cause 400 errors on xAI)
- Drops empty-string content items
- Moves `role: "developer"` / `role: "system"` messages to top-level `instructions`
- Converts `image_url` parts to `input_image` with data URIs
- Resolves local image paths (`.jpg`, `.jpeg`, `.png`) to base64 — workspace-scoped for security
- Extracts images from `function_call_output.output` arrays into separate user messages
- Maps `response_format` → `text.format`
- Adds `prompt_cache_key` for session-affinity caching
- Normalizes `reasoning.effort` for models that support it

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GROK_BUILD_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | API base URL |
| `GROK_BUILD_MODELS` | *(catalog)* | Comma-separated model IDs to expose |
| `GROK_BUILD_OAUTH_CLIENT_ID` | *(built-in)* | OAuth client ID override |
| `GROK_BUILD_CALLBACK_HOST` | `127.0.0.1` | OAuth loopback callback host |
| `GROK_BUILD_CALLBACK_PORT` | `56122` | OAuth loopback callback port |
| `GROK_BUILD_OAUTH_TOKEN` | — | Static token bypass (skips OAuth, no refresh) |
| `GROK_BUILD_TOKEN_TIMEOUT_MS` | `30000` | Timeout for OAuth token requests |

## Development

```bash
bun install
bun run check        # lint + typecheck + knip + duplicate check + coverage
bun run test         # tests only
bun run typecheck    # tsc --noEmit
bun run coverage     # tests with coverage
```

See [OPENCODE_PLUGIN_SETUP.md](docs/OPENCODE_PLUGIN_SETUP.md) for packaging details.

## License

[MIT](LICENSE)