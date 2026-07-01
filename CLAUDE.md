# tabterm-timer

The **timer** module for [tabterm](https://github.com/and1truong/tabterm), extracted
into its own repository — countdown timers, clock-time alarms, and a Pomodoro phase
timer behind one module (`id: timer`). A tabterm *module*, not a standalone app: it has
no server/SPA of its own; it activates inside a tabterm host through the
`@tabterm/module-host` contract.

## Toolchain

- **Runtime + package manager: [Bun](https://bun.sh)** (required ≥1.3.5, see `package.json` engines).
  Use `bun` for everything. Do **not** use `npm`, `yarn`, or `pnpm`. Lockfile is `bun.lock`.
- **Typecheck:** `bun run typecheck` (`tsc --noEmit`) — or `make typecheck`.
- **Test:** `bun test` (timers/alarms/pomodoro engine tests) — or `make test`.
- **Full local gate:** `make check` (typecheck + test).
- **Build:** `make build` → `dist/modules/timer/{client.js,server.js}`.
- `make help` lists every target.

## Architecture

The module talks to the host **only** through `@tabterm/module-host` plus its own files —
no deep imports into a host's `src/`. It owns everything it needs:

- `shared.ts` — the borrowed timer domain types (`Alarm`, `AlarmFire`, `TimerConfig`,
  `TimerRunState`, `TimerPhase`), copied from the host at extraction so the module has no
  deep import. The host keeps its own copies for its legacy settings row.
- `server.ts` — server entry: `activate(host)` wires three sub-features (timers, alarms,
  pomodoro), each with its own engine, `host.kv` namespace key, namespaced RPC methods
  (`timers:*` / `alarms:*` / `pomodoro:*`), and namespaced broadcast events.
- `src/index.tsx` — client entry: `activate(host)` registers the floating boxes, header
  chips, and Tools-menu items. All client types are inline; it imports only React +
  `lucide-react` + the host contract.

Three time tools, one module — see `README.md`.

## Host contract (`@tabterm/module-host`)

- **Vendored** under `vendor/module-host/`, resolved via `file:./vendor/module-host` — no
  registry dependency. Pinned to a tagged snapshot (see `vendor/README.md`).
- Refresh it with `make vendor TABTERM=<path-to-tabterm>` when the contract changes, then
  bump `vendor/module-host/package.json` and re-tag.
- `react` / `react-dom` are **host-provided** at runtime (externalized in the module
  build) — declared here as peer/dev deps for typecheck + tests only. `lucide-react` is a
  real dependency and is bundled into `client.js`.

## Building / consuming this module

This repo ships **source** and builds its own **self-contained** artifacts. `make build`
(`scripts/build-modules.ts`) compiles:
- `src/index.tsx` → `dist/modules/timer/client.js` (ESM, react/react-dom external,
  no code-splitting, no CSS — Tailwind classes only);
- `server.ts` → `dist/modules/timer/server.js` (`--target bun`).

A tabterm host loads these two files via its `modules:` config. See `README.md`.

## Conventions

- Surgical changes; match existing style. The module's clean host-only boundary is the
  whole point of the extraction — never reach back into a host's internals.
- Tests are colocated (`*.test.ts`).
- **Dropped at extraction:** the old `migrateLegacyConfigs` one-time migration (it copied
  configs from the pre-consolidation `timers`/`alarms`/`pomodoro` modules by reading their
  `module_kv` rows — a cross-module read the host contract doesn't expose). New installs
  don't need it; anyone upgrading from those separate modules re-enters their config once.
