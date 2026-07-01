# @tabterm/module-timer

The **timer** module for [tabterm](https://github.com/and1truong/tabterm) — consolidates
three time tools behind one module (`id: timer`).

- **Timers** — ad-hoc countdown timers (floating box + Tools menu). kv key `timers`.
- **Alarms** — clock-time recurring alarms (floating box + Tools menu + ringing header
  chip). kv key `alarms`.
- **Pomodoro** — interval/phase timer in a header chip. kv key `pomodoro`.

Each sub-feature keeps its own engine, `host.kv` namespace key, namespaced RPC methods
(`timers:*`, `alarms:*`, `pomodoro:*`), and namespaced broadcast events.

Extracted from the tabterm monorepo (`modules/timer/`) into its own repository.

## Layout

```
shared.ts            Borrowed timer domain types (Alarm, AlarmFire, TimerConfig,
                     TimerRunState, TimerPhase) — copied from the host at extraction
server.ts            Server entry — activate(host): three engines, host.kv per feature,
                     namespaced RPC + broadcasts
src/index.tsx        Client entry — activate(host): floating boxes, header chips,
                     Tools-menu items (all types inline)
scripts/build-modules.ts   Builds the two self-contained dist artifacts
```

The module talks to the host **only** through `@tabterm/module-host` (the type-only
contract) plus its own files — no deep imports into tabterm's `src/`. It owns its
persisted config (`host.kv`), its RPC methods (`host.registerRpc`), its broadcasts
(`host.broadcast`), and its UI (`host.ui.registerUI`). See `docs/modules.md` in tabterm
for the full host API.

## Development

```sh
bun install        # resolves lucide-react + links @tabterm/module-host
bun run typecheck  # tsc --noEmit
bun test           # timers/alarms/pomodoro engine tests
make build         # -> dist/modules/timer/{client.js,server.js}
```

`@tabterm/module-host` (the type-only host contract) is **vendored** under
`vendor/module-host/` and resolved via `file:./vendor/module-host` (see `package.json`
devDependencies) — no npm/registry dependency. To update it, run
`make vendor TABTERM=<path-to-tabterm>`.

## Consuming this module in tabterm

Unlike a monorepo module, this repo builds its own artifacts. `make build` emits two
self-contained files under `dist/modules/timer/`:

- **`client.js`** — ESM client bundle. `react`/`react-dom` stay external (host-provided at
  runtime); `lucide-react` is inlined. No CSS (Tailwind classes only). Default export is
  `activate(host)`.
- **`server.js`** — server half (`--target bun` ESM). Default export is `activate(host)`.

Point tabterm's config at them:

```yaml
modules:
  - { id: timer, enabled: true,
      client: ~/dirs/tabterm-timer/dist/modules/timer/client.js,
      server: ~/dirs/tabterm-timer/dist/modules/timer/server.js }
```

Rebuild here (`make build`) whenever the module changes; tabterm picks up the new bundles
on its next load.

### Install from a release

Each [release](https://github.com/and1truong/tabterm-timer/releases) ships the two
self-contained files — no build step:

```sh
mkdir -p dist/modules/timer
curl -L -o dist/modules/timer/client.js \
  https://github.com/and1truong/tabterm-timer/releases/latest/download/client.js
curl -L -o dist/modules/timer/server.js \
  https://github.com/and1truong/tabterm-timer/releases/latest/download/server.js
```

then wire the same `modules:` entry (pointing at wherever you dropped them).

## Migrating from the old separate modules

Before consolidation, tabterm shipped three modules (`timers`, `alarms`, `pomodoro`), each
with its own `module_kv` config. The one-time `migrateLegacyConfigs` that copied those into
the unified `timer` namespace was **dropped at extraction** — it required reading another
module's KV, which the host contract doesn't expose. If you're upgrading from those
separate modules, re-enter your timer/alarm/pomodoro config once; new installs are
unaffected.
