# Supporting OpenCode v1 and v2 from one package

Investigated 2026-09-22, against `open-grok-build` 0.4.0 and `@opencode/plugin@2.0.12`.

**Decision: stay v2-only.** This note records why, and what the escape hatch looks like
if that changes.

## The question

`open-grok-build` 0.4.0 requires OpenCode 2.0 (`6e3e3d3`, `feat!: port plugin to OpenCode v2`).
A sibling project, `cc-safety-net`, ships a single package that loads in both OpenCode 1.x and
2.x. Can the same be done here?

## The packaging is not the problem

`cc-safety-net` uses three tricks, all of which would work here:

1. **Dual export from one module.** v1's loader picks up named function exports; v2's reads the
   default export. One file can carry both:

   ```ts
   export const CCSafetyNetPlugin: Plugin = createCCSafetyNetPlugin();       // v1
   export default { ...createOpenCodeV2Plugin(), server: CCSafetyNetPlugin }; // v2
   ```

2. **Types-only subpath.** `./opencode/v2` maps `types` to a separate `.d.ts` but `import` back
   to the same `dist/index.js`. v2 consumers get correct types with no second bundle; the entry
   source is just `declare const plugin: Plugin; export default plugin`.

3. **Optional peers plus bundling.** Both `@opencode-ai/plugin` and `@opencode/plugin` are
   optional `peerDependencies` imported as `import type`. The v2 runtime values that are
   genuinely needed (`effect`, `@opencode/schema/tool`) are bundled into `dist` — its chunks
   import nothing but node builtins. A v1 host therefore never resolves `@opencode/plugin`.

Point 3 is the one that matters for us: `open-grok-build` ships raw TypeScript
(`main: ./src/opencode/plugin.ts`), so a top-level `import { Plugin } from '@opencode/plugin'`
would load v2's whole tree inside a v1 host. Adding a build step removes that objection.

## The host surface is the problem

`cc-safety-net` touches the host in four places — `tool.execute.before`, `shell.create.before`,
one slash command, one plugin option — and all four exist in both versions. Its decision logic
is a pure function `(tool, input, cwd) → allow/deny`, so its v2 adapter
(`src/hosts/opencode/v2.ts`) is 80 lines of signature translation. It is stateless and read-only
with respect to the host.

`open-grok-build` *is a provider*. Every capability below is a mechanism v2 replaced rather than
renamed:

| Capability | cc-safety-net | open-grok-build: v1 → v2 |
| --- | --- | --- |
| Provider registration | — | mutate `config.provider[…]` → `ctx.provider.transform` |
| OAuth / credentials | — | read `auth.json` / `OPENCODE_AUTH_CONTENT` → host integration connections |
| Multi-account + rotation | — | plugin-owned slots → keyed on host connection identity |
| Request interception | — | custom `fetch` + `chat.headers`/`chat.params` → `http.request`/`http.response`/`retry` |
| TUI | — | single `tui.tsx` → CLI plugin + typed RPC contract |
| Persisted state tied to host identity | — | quota cache + `config.accounts.selected` |

## What dual support would actually cost

Host-coupled modules today total ~875 lines of ~4,400 in `src`:

```
src/imagine/register.ts        src/opencode/plugin.ts
src/opencode/accounts.ts       src/opencode/providerModels.ts
src/opencode/integration.ts    src/opencode/requests.ts
                               src/opencode/rpc.ts
                               src/opencode/tui.ts
```

Supporting v1 again means each of those gaining a second implementation, plus resurrecting
`src/opencode/runtime.ts` (389 lines) and `src/opencode/tui.tsx` (159 lines) deleted in `6e3e3d3`,
plus a second fake-host test harness (`tests/opencode/runtime.test.ts`, 369 lines), plus
typechecking against both dependency trees — note the v1 entry already carried `@ts-nocheck`
because its payload types did not line up.

The account model is the worst of it. v2 accounts *are* host integration connections
(`credential:<id>` / `env:<name>`, resolved by the host); v1 had no such concept and the plugin
owned storage itself. Two account models feed `accounts.ts`, rotation, the quota cache keys, the
dashboard listing and `config.accounts.selected`. `src/config.ts` currently resets a version-1
file to defaults, so a shared schema would have to be reintroduced too.

## Why v2-only wins for now

The pure core — `auth/oauth.ts`, `models/catalog.ts`, `payload/sanitize.ts`, `billing.ts`,
`quotaCache.ts`, `dashboard/server.ts`, the Imagine internals — is ~80% of the tree and already
host-agnostic. That is also where bugs actually occur. Backporting a core fix to a maintenance
branch is far cheaper than paying an abstraction seam on every v2 change:

```bash
git branch v1 68248f1                      # v0.3.0, the last v1 release
npm dist-tag add open-grok-build@0.3.0 v1
```

Demand is also thin: one issue has ever been filed, and no `v1` dist-tag exists.

## If that changes

The defensible middle path is **v1 for the provider only**: adopt `cc-safety-net`'s packaging
(build step, dual export, types-only subpath), restore `runtime.ts` plus a thin auth loader
(~450 lines), and support OAuth, the model catalog, payload sanitization and a single account on
v1. Multi-account rotation, the dashboard and the TUI stay v2-only. The pure core is shared
untouched.

Full dual support — every capability in the table above on both hosts — is not worth it unless
v1 usage becomes significant.
