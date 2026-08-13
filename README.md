# open-grok-build

[![CI](https://github.com/kenryu42/open-grok-build/actions/workflows/ci.yml/badge.svg)](https://github.com/kenryu42/open-grok-build/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/kenryu42/open-grok-build?label=version&color=blue)](https://github.com/kenryu42/open-grok-build)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](https://opensource.org/licenses/MIT)

OpenCode integration for xAI's Grok Build CLI service. It provides Grok models, OAuth, multiple accounts with automatic quota rotation, a private account dashboard, and subscription-tier and quota tracking.

## Install

```bash
opencode plugin -g open-grok-build
```

The package has two entry points:

- `open-grok-build` is the server plugin for models, authentication, and routing.
- `open-grok-build/tui` supplies account and usage commands.

OpenCode loads server and TUI plugins from separate configuration; point both at the package
directory when using a local checkout.

The supported OpenCode plugin range remains `>=1.15.0`.

## Connect

Run `/connect grok-build`, then choose:

- **Browser login (default)** for local loopback OAuth.
- **Device login (headless)** for SSH, containers, or remote hosts.
- **Paste callback/code (remote)** when you need to paste an OAuth callback URL, query string, or one-time code.

Credentials remain in OpenCode's auth store. Plugin settings and caches never contain access or refresh tokens.
Credentials supplied through `GROK_BUILD_OAUTH_TOKEN` or `OPENCODE_AUTH_CONTENT` are shown as
environment-managed and cannot be changed from the dashboard.

## Features

### Models and protocol compatibility

The plugin exposes one OpenCode provider, `grok-build`, with a seven-model fallback catalog. `GROK_BUILD_MODELS` can override the visible model IDs. Requests use the current Grok Build `0.2.111` identity, preserve ordered reasoning replay and encrypted reasoning continuity, and sanitize Responses payloads for Grok's protocol.

| Model | Context | Reasoning | Input |
|---|---:|---:|---|
| `grok-composer-2.5-fast` | 200K | — | text, image |
| `grok-build` | 500K | yes | text, image |
| `grok-4.3` | 1M | yes | text, image |
| `grok-4.5` | 500K | yes | text, image |
| `grok-4.6` | 500K | yes | text, image |
| `grok-4.20-0309-reasoning` | 2M | yes | text, image |
| `grok-4.20-0309-non-reasoning` | 2M | — | text, image |
| `grok-4.20-multi-agent-0309` | 2M | yes | text, image |

### Multiple accounts and automatic rotation

`/grok-build-accounts` opens a loopback-only browser dashboard. It can add, rename, select, log in, log out, remove, and refresh accounts and quota.

OpenCode still sees only the `grok-build` provider. Additional credentials use internal auth slots such as `grok-build-2`; they do not add duplicate providers to the model picker.

When Grok returns the exact final “usage balance exhausted” 402 response, the request router:

1. marks the account exhausted for five minutes;
2. selects an authenticated account, preferring the one with the most weekly allowance remaining;
3. retries the same pre-stream request without repeating completed work.

An OpenCode continuation is used only when exhaustion arrives after the HTTP stream has already started.

### Usage

`/grok-build-usage` shows the selected account's subscription tier and weekly allowance usage without consuming an LLM turn. It reads the weekly credits endpoint, and uses the last private cache entry if refresh fails. Reset times are shown in your local timezone.

## TUI commands

| Command | Purpose |
|---|---|
| `/grok-build-accounts` | Open the private account and quota dashboard |
| `/grok-build-usage` | Show billing and token status |

## State and security

Plugin-owned state is stored under:

```text
~/.local/share/opencode/open-grok-build/
  config.json
  quota-cache.json
```

`XDG_DATA_HOME` is honored. Config and cache writes are atomic and owner-only. OAuth credentials stay in OpenCode's `auth.json`.

The account dashboard binds to `127.0.0.1` on an ephemeral port and uses a one-use bootstrap capability, HttpOnly SameSite cookie, CSRF and Origin checks, strict Host validation, CSP, bounded request bodies, and idle shutdown. Dashboard state explicitly excludes credentials and OAuth secrets.

Custom endpoint overrides receive bearer credentials and request content; only point them at systems you trust.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `GROK_BUILD_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Grok Build API and billing base URL |
| `GROK_BUILD_MODELS` | fallback catalog | Comma-separated model IDs |
| `GROK_BUILD_OAUTH_TOKEN` | unset | Account 1 token bypass; no automatic refresh |
| `GROK_BUILD_OAUTH_CLIENT_ID` | built in | OAuth client ID override |
| `GROK_BUILD_OAUTH_SCOPE` | built in | OAuth scope override |
| `GROK_BUILD_CALLBACK_HOST` | `127.0.0.1` | OAuth callback host |
| `GROK_BUILD_CALLBACK_PORT` | `56122` | Preferred OAuth callback port |
| `GROK_BUILD_TOKEN_TIMEOUT_MS` | `30000` | OAuth request timeout |

## Development

```bash
bun install
bun run check
```

`bun run check` formats, typechecks, checks production exports and duplication, and runs the full coverage suite.

## License

[MIT](LICENSE)
