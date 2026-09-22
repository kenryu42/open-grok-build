# Testing open-grok-build locally with OpenCode v2

## 0. Prerequisites

- OpenCode 2.0 or newer (`opencode --version`), or a dev build of the [opencode](https://github.com/anomalyco/opencode) monorepo.
- In this repo: `bun install` (installs `@opencode/plugin` and `zod` for the runtime).
- Optional: `GROK_BUILD_OAUTH_TOKEN` to test without a browser OAuth round trip.

Automated checks (no OpenCode process):

```bash
bun run check
```

---

## Option A — point `opencode.json` at this checkout

In the project you want to test from (this repo works too), add:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/Users/kenryu/Developer/420024-lab/open-grok-build" }]
}
```

A plain string works as well; `{ "package": … }` additionally accepts an `options` object. Use an **absolute** path, or one starting with `./` / `../` relative to the config file. The target must be the package **directory** — a path to a single file is skipped with `configured plugin path must be a directory` in the log.

One entry is enough for both halves: OpenCode resolves `.` (server) and `./tui` from the package exports.

**Verify**

1. Start OpenCode in that directory.
2. Check the log for plugin load errors (`service=plugin`, `failed to load plugin`).
3. `/connect` lists **Grok Build** with Browser, Device, and Paste-code methods.
4. `/models` shows models under `grok-build`; `grok-build/grok-4.7#xhigh` selects Extra High.
5. `/grok-build-usage` shows a toast without starting an assistant turn.
6. `/grok-build-accounts` opens the dashboard in a browser.
7. `/grok-build-imagine a red bicycle --aspect 16:9` writes a JPEG under `~/.local/share/opencode/open-grok-build/images/<session>/`.

**Env overrides** (same shell as OpenCode):

```bash
export GROK_BUILD_OAUTH_TOKEN="…"        # optional; appears as the Environment token account
export GROK_BUILD_MODELS="grok-4.7,grok-build"
opencode
```

---

## Option B — a plugins directory

Directories inside `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global) are discovered without any config entry:

```bash
mkdir -p .opencode/plugins
ln -sfn /Users/kenryu/Developer/420024-lab/open-grok-build .opencode/plugins/open-grok-build
```

The link must point at the package directory, not at a source file. Explicit `plugins` config is applied after discovery, so `"-open-grok-build"` there disables a discovered copy.

---

## Option C — install the published package

```bash
opencode plugin add open-grok-build
opencode plugin list
```

`plugin add` only accepts npm registry or Git specifiers; use Option A or B for a working copy.

---

## Option D — against the opencode monorepo

1. Build or run OpenCode from your `opencode` checkout.
2. Add this folder with Option A or B.
3. Keep `@opencode/plugin` on the same minor as the OpenCode you run (`2.0.x`); the plugin API changed between majors.

---

## Troubleshooting

| Symptom | What to check |
|--------|----------------|
| Plugin not listed / load error | Path in `plugins` points at the package directory; `bun install` ran in this repo; check the OpenCode log. |
| `configured plugin path must be a directory` | The entry points at a file. Use the folder that contains `package.json`. |
| Slash commands missing | The TUI entry comes from the same `plugins` entry; restart OpenCode and look for a TUI plugin failure in the plugin dialog. |
| Provider missing after connect | The provider is registered in `setup`; a failed server plugin means no provider. Fix the load error first. |
| Auth fails | `/connect` → Grok Build, or set `GROK_BUILD_OAUTH_TOKEN`; check that the OAuth loopback port is reachable. |
| Imagine reports HTTP 401 | The selected account's token is rejected by `api.x.ai`; reconnect, or point `GROK_BUILD_IMAGINE_BASE_URL` at a test endpoint. |
| Config warning about v1 | Expected once: a version-1 `config.json` is reset to defaults. Reconnect extra accounts. |

---

## Quick checklist

- [ ] `bun install` in open-grok-build
- [ ] `plugins` entry (or `.opencode/plugins/` link) in place
- [ ] OpenCode starts without plugin errors
- [ ] `grok-build` appears in `/connect` and `/models`
- [ ] `/grok-build-usage` toast works
- [ ] A chat turn on a `grok-build` model succeeds
