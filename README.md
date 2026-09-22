# open-grok-build

[![CI](https://github.com/kenryu42/open-grok-build/actions/workflows/ci.yml/badge.svg)](https://github.com/kenryu42/open-grok-build/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/open-grok-build?label=npm&color=blue)](https://www.npmjs.com/package/open-grok-build)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](./LICENSE)

<div align="center">

[![Open Grok Build account dashboard](./.github/assets/open-grok-build.png)](./.github/assets/open-grok-build.png)

</div>

Use Grok Build models in [OpenCode](https://opencode.ai/) with OAuth, account rotation, quota tracking, and Grok Imagine image generation.

- **OAuth login** — browser, device code, or pasted callback. OpenCode stores and refreshes the credentials.
- **Multiple accounts** — manage them in a private browser dashboard and switch automatically when a balance runs out.
- **Usage tracking** — subscription tier, weekly allowance, and reset time for the selected account.
- **Protocol support** — reasoning continuity, reasoning-effort variants, and recovery from proxy errors with a fresh conversation ID.
- **Image generation** — Grok Imagine from a slash command or the `image_gen` tool.

> Requires OpenCode 2.0 or newer and an xAI account with access to the selected model. Availability varies by account, plan, region, and xAI rollout. The Grok Build executable is not required.
>
> On open-grok-build 0.3.x or earlier? See [Migrating from v1](#migrating-from-v1).
>
> This is an unofficial community integration. It does not bypass xAI access controls, quotas, or billing.

## Quick start

### 1. Install

```bash
opencode plugin add open-grok-build
```

Or add it to `opencode.json` yourself:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["open-grok-build"]
}
```

Restart OpenCode. The single entry loads both halves of the package — the server plugin (provider, authentication, requests) and the TUI plugin (slash commands, dashboard).

### 2. Connect an account

Run `/connect`, choose **Grok Build**, then pick a method:

- **Browser login (default)** — xAI authorization with a local callback.
- **Device login (headless)** — URL plus short code, for SSH, containers, and remote hosts.
- **Paste callback code (remote)** — accepts a callback URL, query string, or one-time code.

Setting `GROK_BUILD_OAUTH_TOKEN` adds a fourth, environment-managed connection instead.

### 3. Select a model

Run `/models` and pick one under the `grok-build` provider, for example `grok-build/grok-4.7`. Reasoning models take an effort variant appended to the ID:

```text
grok-build/grok-4.7#xhigh
```

`#low`, `#medium`, and `#high` work on every reasoning model. `#xhigh` is available on `grok-4.6`, `grok-4.7`, and `grok-4.7-build-fast`.

### 4. Check usage

`/grok-build-usage` shows the selected account's subscription tier, weekly allowance usage, and reset time in a toast, without consuming an LLM turn.

## Multiple accounts

`/grok-build-accounts` opens a private browser dashboard that can add, rename, select, sign in, remove, and refresh accounts and their quota. Only add accounts you own or are authorized to access.

Every account is a credential of the same `grok-build` integration, so extra accounts never add duplicate providers to the model picker.

When Grok returns the exact final balance-exhausted response, the plugin skips that account for five minutes, selects another connected account — preferring the one with the most weekly allowance remaining — and asks OpenCode to retry immediately. Rotation stops when no eligible account remains, and the original error surfaces. Authentication failures rotate too; rate limits and other errors do not.

An account from `GROK_BUILD_OAUTH_TOKEN` appears as **Environment token**. It can be selected and used, but not renamed, signed in, or removed — unset the variable and restart OpenCode instead.

## Models

The package ships a ten-model fallback catalog; `GROK_BUILD_MODELS` can narrow the visible list. Registered limits can differ from the limits xAI enforces for an account.

| Model ID | Registered context | Reasoning | Extra High | Input |
| --- | ---: | --- | --- | --- |
| `grok-composer-2.5-fast` | 200K | no | no | text + image |
| `grok-build` | 500K | yes | no | text + image |
| `grok-4.3` | 1M | yes | no | text + image |
| `grok-4.5` | 500K | yes | no | text + image |
| `grok-4.6` | 500K | yes | yes | text + image |
| `grok-4.7` | 500K | yes | yes | text + image |
| `grok-4.7-build-fast` | 500K | yes | yes | text + image |
| `grok-4.20-0309-reasoning` | 2M | yes | no | text + image |
| `grok-4.20-0309-non-reasoning` | 2M | no | no | text + image |
| `grok-4.20-multi-agent-0309` | 2M | yes | no | text + image |

`grok-4.7-build-fast` is billed at twice the `grok-4.7` rate. Above 200K prompt tokens xAI doubles all rates again; the registered cost is the below-200K tier.

## Commands

| Command | Description |
| --- | --- |
| `/grok-build-usage` | Fetch current quota, update its cache, and fall back to cached data if the refresh fails. |
| `/grok-build-accounts` | Open the account and quota dashboard. |
| `/grok-build-imagine <prompt>` | Generate or edit an image with Grok Imagine. |
| `/grok-build-imagine:tool [on\|off\|status]` | Turn the `image_gen` tool on or off, or report its state. |

### Imagine

```text
/grok-build-imagine a red bicycle on a wet street --aspect 16:9
/grok-build-imagine make the sky orange --image ./photo.png --out ./edited.jpg
```

| Option | Default | Description |
| --- | --- | --- |
| `--aspect`, `--aspect-ratio` | `auto` | One of `auto`, `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`. |
| `--image`, `--edit` | none | Local PNG, JPEG, or WebP to edit, at most 400 KiB. Relative paths resolve against the project directory. |
| `--out`, `-o` | timestamped file in the session directory | Write the image here instead. |
| `--resolution` | `1k` | Only `1k` is available. |

Images are saved as JPEG under `~/.local/share/opencode/open-grok-build/images/<session id>/<timestamp>.jpg`; a request without a session ID falls back to a `no-session` directory.

The `image_gen` tool exposes the same generation and editing to the model via `prompt`, `image`, and `aspect_ratio`, and returns the saved absolute path. It is registered only while `imagine.enabled` is true — `/grok-build-imagine:tool off` persists the setting and reloads the tool list. The slash command works either way.

## Configuration

Plugin-owned state lives under `~/.local/share/opencode/open-grok-build/` (`XDG_DATA_HOME` is honored):

```text
config.json      # version, selected account, imagine toggle
quota-cache.json # last billing response per account
images/
```

```json
{
  "version": 2,
  "accounts": { "selected": "credential:<id>" },
  "imagine": { "enabled": true }
}
```

OAuth credentials live in OpenCode's credential store and are never copied into plugin state. Config and cache writes are atomic and owner-only.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `GROK_BUILD_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Grok Build API and billing base URL. |
| `GROK_BUILD_MODELS` | all bundled models | Comma-separated model IDs to expose. |
| `GROK_BUILD_OAUTH_TOKEN` | not set | Access token read by OpenCode as the **Environment token** connection. No automatic refresh. |
| `GROK_BUILD_IMAGINE_BASE_URL` | `https://api.x.ai/v1` | Grok Imagine base URL. |
| `GROK_BUILD_IMAGINE_MODEL` | `grok-imagine-image-quality` | Grok Imagine model ID. |
| `GROK_BUILD_OAUTH_CLIENT_ID` | built in | OAuth client ID override. |
| `GROK_BUILD_OAUTH_SCOPE` | built in | OAuth scope override. |
| `GROK_BUILD_CALLBACK_HOST` | `127.0.0.1` | OAuth callback host. |
| `GROK_BUILD_CALLBACK_PORT` | `56122` | Preferred OAuth callback port. |
| `GROK_BUILD_TOKEN_TIMEOUT_MS` | `30000` | OAuth request timeout in milliseconds. |

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `grok-build` is missing from the model picker | Confirm the package is listed under `plugins` in `opencode.json`, then restart OpenCode. |
| Commands are missing from the `/` menu | The TUI entry loads with the same `plugins` entry; restart OpenCode and check its log for plugin load errors. |
| Browser login does not return, or xAI shows a one-time code | Use **Paste callback code (remote)** or **Device login (headless)**. |
| Authentication returns HTTP 401 or 403 | Run `/connect` again and confirm the account can access the selected model. |
| Requests fail with HTTP 401, 502, or 520 | These are retried with a new conversation ID, at most twice before the next successful response. A third failure surfaces the error. |
| Balance exhausted | Connect a second account so rotation has a candidate. With no eligible account the 402 is shown. |
| A listed model is unavailable | Try another. Availability differs by account, plan, region, and rollout. |
| The dashboard reports a lost connection | Run `/grok-build-accounts` again for a new dashboard session. |
| Imagine reports HTTP 401 | Run `/connect` and choose Grok Build, or set `GROK_BUILD_OAUTH_TOKEN`. |

## Migrating from v1

open-grok-build 0.4 requires OpenCode 2.0 and does not load in OpenCode 1.x. The last release supporting OpenCode 1.x is 0.3.0.

- Configuration moved from the `plugin` key to the `plugins` array; a separate `tui.json` entry is no longer needed.
- Authentication is owned by OpenCode: `/connect` replaces `/connect grok-build` slots, and the plugin no longer reads `auth.json` or `OPENCODE_AUTH_CONTENT`.
- The internal `grok-build-2`, `grok-build-3`, … account slots are gone. Each account is a credential of the `grok-build` integration, every account can be removed, and there is no privileged primary account.:qa
- The plugin's own `config.json` is reset to defaults the first time a version-1 file is loaded, and the reset is reported as a warning. Reconnect extra accounts with `/connect` or the dashboard.

Why the package does not support both versions at once: [docs/OPENCODE_V1_V2_DUAL_SUPPORT.md](./docs/OPENCODE_V1_V2_DUAL_SUPPORT.md).

## Security and data flow

Prompts, model context, and image inputs are sent to the configured Grok Build endpoint; Imagine prompts and source images go to the configured Imagine endpoint. Custom endpoint overrides also receive bearer credentials — only use endpoints you trust.

The account dashboard binds to `127.0.0.1` on an ephemeral port, behind a one-use bootstrap capability, an HttpOnly SameSite cookie, CSRF and Origin checks, strict Host validation, a content security policy, bounded request bodies, and idle shutdown. Dashboard responses never include OAuth credentials or secrets.

Never include tokens, authorization codes, callback URLs, prompts, or private project data in public issues.

## Support and contributing

Report bugs and feature requests through [GitHub Issues](https://github.com/kenryu42/open-grok-build/issues). Include the OpenCode version, open-grok-build version, selected model, login method, and exact error message.

```bash
bun install
bun run check
```

See [docs/LOCAL_OPENCODE_TESTING.md](./docs/LOCAL_OPENCODE_TESTING.md) for running a checkout against OpenCode, and [docs/OPENCODE_PLUGIN_SETUP.md](./docs/OPENCODE_PLUGIN_SETUP.md) for how OpenCode resolves the plugin entries.

Pull requests should include tests for behavior changes and pass `bun run check`.

## License

[MIT](./LICENSE) © 2026 kenryu42
