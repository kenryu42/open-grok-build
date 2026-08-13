# open-grok-build

[![CI](https://github.com/kenryu42/open-grok-build/actions/workflows/ci.yml/badge.svg)](https://github.com/kenryu42/open-grok-build/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/open-grok-build?label=npm&color=blue)](https://www.npmjs.com/package/open-grok-build)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](./LICENSE)

<div align="center">

[![Open Grok Build account dashboard](./.github/assets/open-grok-build.png)](./.github/assets/open-grok-build.png)

</div>

Use Grok Build models in [OpenCode](https://opencode.ai/) with OAuth, account rotation, and quota tracking.

- **OAuth login:** Sign in through a browser, device code, or pasted callback with automatic token refresh.
- **Multiple accounts:** Manage accounts in a private browser dashboard and automatically switch when quota runs out.
- **Usage tracking:** Check the selected account's subscription tier, weekly allowance, and reset time.
- **Protocol support:** Preserve reasoning continuity and adapt OpenCode requests for the Grok Build API.

> Requires OpenCode 1.15.0 or newer and an xAI account with access to the selected model. Availability varies by account, plan, region, and xAI rollout. The Grok Build executable is not required.
>
> This is an unofficial community integration. It does not bypass xAI access controls, quotas, or billing.

## Quick start

### 1. Install and start OpenCode

```bash
opencode plugin -g open-grok-build
opencode
```

Restart OpenCode after installation.

### 2. Log in

Inside OpenCode, run:

```text
/connect grok-build
```

Choose one of these methods:

- **Browser login (default):** Opens xAI authorization with a local callback.
- **Device login (headless):** Displays a URL and short code for SSH, containers, and remote hosts.
- **Paste callback/code (remote):** Accepts an OAuth callback URL, query string, or one-time code.

### 3. Select a model

Open the model picker and select a model under the `grok-build` provider. `grok-build/grok-composer-2.5-fast` is a good starting point for agentic coding and supports image input.

### 4. Verify account usage

```text
/grok-build-usage
```

This shows the selected account's subscription tier, weekly allowance usage, and reset time without consuming an LLM turn.

## Manage multiple accounts

Open the private browser dashboard:

```text
/grok-build-accounts
```

The dashboard can add, rename, select, log in, log out, remove, and refresh accounts and quota. Only add accounts that you own or are authorized to access.

OpenCode continues to show one `grok-build` provider. Additional credentials use internal slots such as `grok-build-2`; they do not add duplicate providers to the model picker. The primary account can be logged out but cannot be removed.

When Grok returns the exact final balance-exhausted response, open-grok-build:

1. skips the exhausted account for five minutes;
2. selects an authenticated account, preferring the one with the most weekly allowance remaining;
3. retries a request that has not started streaming, or continues the session after a started stream ends.

Rotation stops when no eligible account remains. It does not start for authentication failures, rate limits, or similar errors.

Credentials from `GROK_BUILD_OAUTH_TOKEN` or `OPENCODE_AUTH_CONTENT` are environment-managed. The dashboard can show these accounts but cannot change or remove their credentials.

## Models

The package includes an eight-model fallback catalog. `GROK_BUILD_MODELS` can replace the visible model list. Registered limits can differ from the limits that xAI enforces for an account.

| Model ID | Registered context | Reasoning | Input |
| --- | ---: | --- | --- |
| `grok-composer-2.5-fast` | 200K | no | text + image |
| `grok-build` | 500K | yes | text + image |
| `grok-4.3` | 1M | yes | text + image |
| `grok-4.5` | 500K | yes | text + image |
| `grok-4.6` | 500K | yes | text + image |
| `grok-4.20-0309-reasoning` | 2M | yes | text + image |
| `grok-4.20-0309-non-reasoning` | 2M | no | text + image |
| `grok-4.20-multi-agent-0309` | 2M | yes | text + image |

## Commands

| Command | Description |
| --- | --- |
| `/grok-build-accounts` | Open the account and quota dashboard. |
| `/grok-build-usage` | Fetch current quota, update its cache, and show cached data if refresh fails. |

## Configuration

The package has two entry points:

- `open-grok-build` provides models, authentication, and request routing.
- `open-grok-build/tui` provides the account and usage commands.

OpenCode loads server and TUI plugins from separate configuration. When you use a local checkout, point both entries at the package directory.

Plugin-owned state is stored under:

```text
~/.local/share/opencode/open-grok-build/
├── config.json
└── quota-cache.json
```

`XDG_DATA_HOME` is honored. `config.json` stores account labels and selection. `quota-cache.json` stores quota responses. OAuth credentials remain in OpenCode's auth store and are not copied into plugin state.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `GROK_BUILD_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Grok Build API and billing base URL. |
| `GROK_BUILD_MODELS` | all bundled models | Comma-separated model IDs to expose. |
| `GROK_BUILD_OAUTH_TOKEN` | not set | Account 1 access token override with no automatic refresh. |
| `GROK_BUILD_OAUTH_CLIENT_ID` | built in | OAuth client ID override. |
| `GROK_BUILD_OAUTH_SCOPE` | built in | OAuth scope override. |
| `GROK_BUILD_CALLBACK_HOST` | `127.0.0.1` | OAuth callback host. |
| `GROK_BUILD_CALLBACK_PORT` | `56122` | Preferred OAuth callback port. |
| `GROK_BUILD_TOKEN_TIMEOUT_MS` | `30000` | OAuth request timeout in milliseconds. |

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `grok-build` is missing from the model picker | Confirm the package is installed, then restart OpenCode. |
| Account or usage commands are missing | Confirm that OpenCode loads the `open-grok-build/tui` entry, then restart OpenCode. |
| xAI shows a one-time code | Use **Paste callback/code (remote)** and paste the code. |
| Browser login does not return to OpenCode | Use **Paste callback/code (remote)** or **Device login (headless)**. |
| Authentication returns HTTP 401 or 403 | Run `/connect grok-build` again and confirm that the account can access the selected model. |
| A listed model is unavailable | Try another model. Availability can differ by account, plan, region, and rollout. |
| Account rotation does not start | Confirm that at least two accounts are logged in. Rotation responds only to the final balance-exhausted response. |
| The dashboard reports a lost connection | Run `/grok-build-accounts` again to open a new dashboard session. |

## Security and data flow

Prompts, model context, and image inputs are sent to the configured Grok Build endpoint. Custom endpoint overrides also receive bearer credentials. Only use endpoints that you trust.

The account dashboard binds to `127.0.0.1` on an ephemeral port. It uses a one-use bootstrap capability, an HttpOnly SameSite cookie, CSRF and Origin checks, strict Host validation, a content security policy, bounded request bodies, and idle shutdown. Dashboard responses do not include OAuth credentials or secrets.

Config and cache writes are atomic and owner-only. Never include tokens, authorization codes, callback URLs, prompts, or private project data in public issues.

## Support and contributing

Report bugs and feature requests through [GitHub Issues](https://github.com/kenryu42/open-grok-build/issues). Include the OpenCode version, open-grok-build version, selected model, login method, and exact error message.

For local development:

```bash
bun install
bun run check
```

Pull requests should include tests for behavior changes and pass `bun run check`.

## License

[MIT](./LICENSE) © 2026 kenryu42
