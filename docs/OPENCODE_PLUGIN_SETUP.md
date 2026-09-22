# OpenCode v2 plugin setup

Verified against OpenCode `v2.0.12` (`packages/core/src/config/plugin/source.ts`, `packages/plugin/src/host.ts`, `packages/cli/src/commands/handlers/plugin/add.ts`) and `@opencode/plugin@2.0.12`.

## How users load this plugin

**npm** (after publish):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["open-grok-build"]
}
```

Or let the CLI install it and write the entry:

```bash
opencode plugin add open-grok-build
```

`plugin add` requires an npm registry or Git package specifier. Because this package has a server entrypoint, the CLI writes it to the global OpenCode config.

**Local path** — a `plugins` entry may be a string or an object:

```json
{
  "plugins": [{ "package": "/Users/you/Developer/open-grok-build" }]
}
```

Rules that the host enforces:

- The target must be a **directory** containing `package.json`; a configured file path is skipped with a warning.
- `./relative` and `../relative` resolve against the directory of the config file that declares them; bare specifiers are treated as packages.
- A leading `-` removes a plugin (`"-open-grok-build"`).
- Directories dropped in `.opencode/plugins/` or `~/.config/opencode/plugins/` are discovered automatically; explicit config is applied last and wins.

`Host.resolve` probes the package's exports for the subpaths `server` or `.` (server), `tui`, and `rpc`. This package exports all three, so a single `plugins` entry loads the server plugin and the TUI plugin: the TUI reconciler merges the TUI entrypoints of server-configured plugins with its own `plugins` list from `cli.json`.

## Package shape for open-grok-build

| Item | Our choice | Why |
|------|------------|-----|
| `@opencode/plugin` | `dependencies`, `^2.0.12` | Needed at runtime; the host does not install peer dependencies for plugins. |
| `zod` | `dependencies` | Schemas for the RPC contract and the `image_gen` tool input. |
| `type` | `"module"` | The host's Bun runtime plugin only rewrites `solid-js`/`@opentui/*`/`@opencode/plugin/tui` imports in ESM files, so the TUI entry must be ESM. |
| `exports` | `.` → `src/opencode/plugin.ts`, `./tui` → `src/opencode/tui.ts`, `./rpc` → `src/opencode/rpc.ts` | The three subpaths `Host.resolve` looks for. |
| TUI peers | not declared | `@opentui/*`, `solid-js`, and `@opencode/theme` are supplied by the host at runtime; `solid-js` is a devDependency only so tests can import `@opencode/plugin/tui`. |

## API checklist (what this plugin uses)

- [x] `Plugin.define({ id, setup })` from `@opencode/plugin` — server entry, returns a cleanup function.
- [x] `ctx.integration.transform` — the `grok-build` integration: three OAuth methods with `refresh` callbacks plus an `env` method for `GROK_BUILD_OAUTH_TOKEN`. OpenCode owns the credentials and injects them.
- [x] `ctx.provider.transform` — adds the `grok-build` provider (`@opencode/ai/providers/xai`, `transport: "http"`) with models, costs, limits, and reasoning-effort variants.
- [x] `ctx.session.hook('http.request' | 'http.response' | 'retry', …, { providerID })` — bearer token, identity headers, conversation ID, payload sanitizing, account rotation, and bounded conversation-ID rotation.
- [x] `ctx.rpc.register` — `accounts.list`, `accounts.select`, `usage.report`, `quotas.refresh`, consumed by the TUI through `context.client.rpc(OpenGrokBuildRpc)`.
- [x] `ctx.tool.transform` / `ctx.command.transform` / `ctx.tool.reload()` — the `image_gen` tool and the Imagine commands.
- [x] `ctx.event.subscribe` — `credential.updated`, `credential.switched`, `integration.updated` invalidate the account list; `session.deleted` clears session state.
- [x] `Plugin.define` from `@opencode/plugin/tui` with `context.keymap.layer` — the `/grok-build-usage` and `/grok-build-accounts` slash commands.

## Local dev in this repo

```bash
bun install
bun run check
```

Then point OpenCode at this folder; see [LOCAL_OPENCODE_TESTING.md](./LOCAL_OPENCODE_TESTING.md).
