import type { ServerHost, JsonSchema } from "@tabterm/module-host/server";
import type { Alarm, AlarmFire, TimerConfig, TimerRunState } from "./shared.ts";

// ---------------------------------------------------------------------------
// timers engine
// ---------------------------------------------------------------------------

// Types (inline — module is self-contained)

interface TimerEntry {
  id: string;
  label: string;
  durationMs: number;
  sound: string;
}

interface TimersConfig {
  timers: TimerEntry[];
  volume: number;
  muted: boolean;
}

interface TimerEntryRunState {
  id: string;
  running: boolean;
  endTs: number;
  remainingMs: number;
}

interface TimerEntryAlarmFire {
  kind: "timer";
  id: string;
  label: string;
  sound: string;
  seq: number;
}

// Engine

export interface TimerEntryEngineOptions {
  now: () => number;
  schedule: (delayMs: number, cb: () => void) => () => void;
  broadcast: (event: string, payload: unknown) => void;
  kv: { get(key: string): unknown; set(key: string, value: unknown): void };
}

export interface TimerEntryEngine {
  getStates(): TimerEntryRunState[];
  start(id: string): TimerEntryRunState[];
  pause(id: string): TimerEntryRunState[];
  resume(id: string): TimerEntryRunState[];
  reset(id: string): TimerEntryRunState[];
  setConfig(next: TimersConfig): void;
  dispose(): void;
}

const DEFAULT_CONFIG: TimersConfig = { timers: [], volume: 0.5, muted: false };

export function createTimerEntryEngine(opts: TimerEntryEngineOptions): TimerEntryEngine {
  const { now, schedule, broadcast, kv } = opts;

  let config: TimersConfig = (kv.get("config") as TimersConfig | undefined) ?? { ...DEFAULT_CONFIG };

  // In-memory run state per timer id
  const timerRuns = new Map<string, TimerEntryRunState>();
  // Cancel fn per timer id (replaces setTimeout handle)
  const pending = new Map<string, () => void>();
  let seq = 0;

  function idle(id: string, durationMs: number): TimerEntryRunState {
    return { id, running: false, endTs: 0, remainingMs: durationMs };
  }

  function getStates(): TimerEntryRunState[] {
    return config.timers.map((t) => timerRuns.get(t.id) ?? idle(t.id, t.durationMs));
  }

  function durationOf(id: string): number {
    return config.timers.find((t) => t.id === id)?.durationMs ?? 0;
  }

  function clearPending(id: string): void {
    const cancel = pending.get(id);
    if (cancel) {
      cancel();
      pending.delete(id);
    }
  }

  function armEntry(id: string): void {
    clearPending(id);
    const st = timerRuns.get(id);
    if (!st || !st.running) return;
    const wait = Math.max(0, st.endTs - now());
    const cancel = schedule(wait, () => {
      pending.delete(id);
      fireEntry(id);
    });
    pending.set(id, cancel);
  }

  function fireEntry(id: string): void {
    const entry = config.timers.find((t) => t.id === id);
    if (!entry) return;
    seq += 1;
    broadcast("fire", { kind: "timer", id, label: entry.label, sound: entry.sound, seq } satisfies TimerEntryAlarmFire);
    timerRuns.set(id, idle(id, entry.durationMs));
    broadcast("states", getStates());
  }

  // Drop run state + cancel schedules for timers no longer in config; keep the rest.
  function syncTimerRuns(): void {
    const ids = new Set(config.timers.map((t) => t.id));
    for (const id of [...timerRuns.keys()]) if (!ids.has(id)) timerRuns.delete(id);
    for (const id of [...pending.keys()]) {
      if (!ids.has(id)) {
        pending.get(id)!();
        pending.delete(id);
      }
    }
  }

  return {
    getStates,

    start(id: string): TimerEntryRunState[] {
      const ms = durationOf(id);
      if (ms <= 0) return getStates();
      timerRuns.set(id, { id, running: true, endTs: now() + ms, remainingMs: ms });
      armEntry(id);
      return getStates();
    },

    pause(id: string): TimerEntryRunState[] {
      const st = timerRuns.get(id);
      if (st && st.running) {
        timerRuns.set(id, { ...st, running: false, remainingMs: Math.max(0, st.endTs - now()) });
        clearPending(id);
      }
      return getStates();
    },

    resume(id: string): TimerEntryRunState[] {
      const st = timerRuns.get(id);
      if (st && !st.running && st.remainingMs > 0) {
        timerRuns.set(id, { ...st, running: true, endTs: now() + st.remainingMs });
        armEntry(id);
      }
      return getStates();
    },

    reset(id: string): TimerEntryRunState[] {
      clearPending(id);
      timerRuns.set(id, idle(id, durationOf(id)));
      return getStates();
    },

    setConfig(next: TimersConfig): void {
      config = next;
      kv.set("config", config);
      syncTimerRuns();
      broadcast("states", getStates());
    },

    dispose(): void {
      for (const cancel of pending.values()) cancel();
      pending.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// alarms engine
// ---------------------------------------------------------------------------

// Alarm-module-only config shape — no `timers` (those live in the timers module).
export interface AlarmsModuleConfig {
  alarms: Alarm[];
  volume: number;
  muted: boolean;
}

// ---------------------------------------------------------------------------
// Pure scheduling functions — exported for direct test use
// ---------------------------------------------------------------------------

// Next fire time (epoch-ms) at or after `from`, or null if disabled.
export function nextDueTs(alarm: Alarm, from: number): number | null {
  if (!alarm.enabled) return null;
  const base = new Date(from);
  const at = (dayOffset: number): number => {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, alarm.hour, alarm.minute, 0, 0);
    return d.getTime();
  };
  if (alarm.days.length === 0) {
    const today = at(0);
    return today > from ? today : at(1);
  }
  for (let i = 0; i < 8; i += 1) {
    const cand = at(i);
    const weekday = new Date(cand).getDay();
    if (alarm.days.includes(weekday) && cand > from) return cand;
  }
  return null; // unreachable for a non-empty days set, but keeps the type honest
}

// Most recent scheduled occurrence at or before `from` (epoch-ms), or null if
// the alarm is disabled. Used for miss-recovery: fire keys off the occurrence
// instant so a delayed fire still rings, keyed on lastFiredTs for exactly-once.
export function prevDueTs(alarm: Alarm, from: number): number | null {
  if (!alarm.enabled) return null;
  const base = new Date(from);
  const at = (dayOffset: number): number =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, alarm.hour, alarm.minute, 0, 0).getTime();
  if (alarm.days.length === 0) {
    const today = at(0);
    return today <= from ? today : at(-1);
  }
  for (let i = 0; i < 8; i += 1) {
    const cand = at(-i);
    if (alarm.days.includes(new Date(cand).getDay()) && cand <= from) return cand;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface AlarmEngineOptions {
  now: () => number;
  schedule: (delayMs: number, cb: () => void) => () => void;
  interval: (ms: number, cb: () => void) => () => void;
  broadcast: (event: string, payload: unknown) => void;
  kv: { get(key: string): unknown; set(key: string, value: unknown): void };
}

export interface AlarmEngine {
  getConfig(): AlarmsModuleConfig;
  setConfig(next: AlarmsModuleConfig): void;
  dismiss(kind: "alarm" | "timer", id: string): void;
  nextDueTs(alarm: Alarm, from: number): number | null;
  prevDueTs(alarm: Alarm, from: number): number | null;
  // Test hook: synchronously drive the fire pass against the injected clock.
  fireDuePass(): void;
  dispose(): void;
}

export function createAlarmEngine(opts: AlarmEngineOptions): AlarmEngine {
  const DEFAULT_CONFIG: AlarmsModuleConfig = { alarms: [], volume: 0.5, muted: false };

  // Load from kv; drop any `timers` field that may be present from the old schema.
  function loadConfig(): AlarmsModuleConfig {
    const raw = opts.kv.get("config") as AlarmsModuleConfig | undefined;
    if (!raw) return { ...DEFAULT_CONFIG };
    const { alarms = [], volume = 0.5, muted = false } = raw;
    return { alarms, volume, muted };
  }

  let config: AlarmsModuleConfig = loadConfig();
  let seq = 0;
  let cancelAlarm: (() => void) | null = null;
  let cancelSafety: (() => void) | null = null;

  // An alarm with no lastFiredTs has never fired. Seed it to now() IN MEMORY
  // only so prevDueTs's past occurrences are treated as already-handled. A
  // persisted real lastFiredTs is left untouched.
  function seedLastFired(): void {
    const t = opts.now();
    for (const a of config.alarms) {
      if (a.lastFiredTs === undefined) a.lastFiredTs = t;
    }
  }

  function persistConfig(): void {
    opts.kv.set("config", config);
  }

  function broadcastConfig(): void {
    opts.broadcast("config", config);
  }

  function armAlarms(): void {
    if (cancelAlarm) {
      cancelAlarm();
      cancelAlarm = null;
    }
    const from = opts.now();
    let soonest = Infinity;
    for (const a of config.alarms) {
      const due = nextDueTs(a, from);
      if (due !== null && due < soonest) soonest = due;
    }
    if (soonest !== Infinity) {
      cancelAlarm = opts.schedule(Math.max(0, soonest - from), () => {
        cancelAlarm = null;
        fireDueAlarms();
      });
    }
    // Coarse safety tick: recover any fire missed during a pause (sleep/wake, GC).
    // Created only once — subsequent armAlarms calls leave it running.
    if (!cancelSafety) {
      cancelSafety = opts.interval(60_000, () => fireDueAlarms());
    }
  }

  function fireDueAlarms(): void {
    const from = opts.now();
    let changed = false;
    for (const a of config.alarms) {
      const due = prevDueTs(a, from);
      if (due === null) continue;
      if (a.lastFiredTs !== undefined && a.lastFiredTs >= due) continue; // already fired this occurrence
      seq += 1;
      opts.broadcast("fire", { kind: "alarm", id: a.id, label: a.label, sound: a.sound, seq } satisfies AlarmFire);
      a.lastFiredTs = due;
      if (a.days.length === 0) a.enabled = false; // one-shot: disable after firing
      changed = true;
    }
    if (changed) {
      persistConfig();
      broadcastConfig();
    }
    armAlarms();
  }

  // Initialize: seed, then arm.
  seedLastFired();
  armAlarms();

  return {
    getConfig(): AlarmsModuleConfig {
      return config;
    },

    setConfig(next: AlarmsModuleConfig): void {
      config = next;
      seedLastFired(); // newly-added alarms ring on next occurrence, not retroactively
      persistConfig();
      broadcastConfig();
      armAlarms();
    },

    dismiss(_kind: "alarm" | "timer", _id: string): void {
      // Active-fire bookkeeping is client-side. Server has no per-fire state to clear.
    },

    nextDueTs(alarm: Alarm, from: number): number | null {
      return nextDueTs(alarm, from);
    },

    prevDueTs(alarm: Alarm, from: number): number | null {
      return prevDueTs(alarm, from);
    },

    fireDuePass(): void {
      fireDueAlarms();
    },

    dispose(): void {
      if (cancelAlarm) {
        cancelAlarm();
        cancelAlarm = null;
      }
      if (cancelSafety) {
        cancelSafety();
        cancelSafety = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// pomodoro engine
// ---------------------------------------------------------------------------

export const DEFAULT_TIMER_CONFIG: TimerConfig = {
  phases: [
    { label: "Focus", ms: 1_500_000 },
    { label: "Break", ms: 300_000 },
  ],
  sound: "bell",
  volume: 0.5,
  muted: false,
};

interface TimerEngineOptions {
  now: () => number;
  schedule: (delayMs: number, cb: () => void) => () => void;
  broadcast: (state: TimerRunState | null) => void;
  config: TimerConfig;
}

interface TimerEngine {
  start(): TimerRunState | null;
  pause(): TimerRunState | null;
  resume(): TimerRunState | null;
  stop(): null;
  skip(): TimerRunState | null;
  setConfig(next: TimerConfig): TimerRunState | null;
  getState(): TimerRunState | null;
  dispose(): void;
}

export function createTimerEngine(opts: TimerEngineOptions): TimerEngine {
  let config: TimerConfig = opts.config;
  let run: TimerRunState | null = null;
  let cancelPending: (() => void) | null = null;

  function reschedule(): void {
    if (cancelPending) {
      cancelPending();
      cancelPending = null;
    }
    if (!run || !run.running) return;
    const wait = Math.max(0, run.endTs - opts.now());
    cancelPending = opts.schedule(wait, () => {
      cancelPending = null;
      if (!run || !run.running) return;
      run = nextPhase(run);
      reschedule();
      opts.broadcast(run);
    });
  }

  function nextPhase(prev: TimerRunState): TimerRunState {
    const phaseIndex = (prev.phaseIndex + 1) % config.phases.length;
    const ms = config.phases[phaseIndex].ms;
    const now = opts.now();
    return {
      phaseIndex,
      running: true,
      endTs: now + ms,
      remainingMs: ms,
      autoAdvances: prev.autoAdvances + 1,
    };
  }

  return {
    start(): TimerRunState | null {
      const ms = config.phases[0].ms;
      const now = opts.now();
      run = {
        phaseIndex: 0,
        running: true,
        endTs: now + ms,
        remainingMs: ms,
        autoAdvances: run ? run.autoAdvances : 0,
      };
      reschedule();
      opts.broadcast(run);
      return run;
    },

    pause(): TimerRunState | null {
      if (!run || !run.running) return run;
      run = {
        ...run,
        running: false,
        remainingMs: Math.max(0, run.endTs - opts.now()),
      };
      reschedule();
      opts.broadcast(run);
      return run;
    },

    resume(): TimerRunState | null {
      if (!run || run.running) return run;
      run = {
        ...run,
        running: true,
        endTs: opts.now() + run.remainingMs,
      };
      reschedule();
      opts.broadcast(run);
      return run;
    },

    stop(): null {
      run = null;
      reschedule();
      opts.broadcast(run);
      return null;
    },

    skip(): TimerRunState | null {
      if (!run) return null;
      const phaseIndex = (run.phaseIndex + 1) % config.phases.length;
      const ms = config.phases[phaseIndex].ms;
      const now = opts.now();
      run = {
        phaseIndex,
        running: true,
        endTs: now + ms,
        remainingMs: ms,
        autoAdvances: run.autoAdvances,
      };
      reschedule();
      opts.broadcast(run);
      return run;
    },

    setConfig(next: TimerConfig): TimerRunState | null {
      config = next;
      if (!run) return null;
      const phaseIndex = Math.min(run.phaseIndex, next.phases.length - 1);
      const ms = next.phases[phaseIndex].ms;
      const now = opts.now();
      run = run.running
        ? {
            phaseIndex,
            running: true,
            endTs: now + ms,
            remainingMs: ms,
            autoAdvances: run.autoAdvances,
          }
        : {
            phaseIndex,
            running: false,
            endTs: 0,
            remainingMs: ms,
            autoAdvances: run.autoAdvances,
          };
      reschedule();
      return run;
    },

    getState(): TimerRunState | null {
      return run;
    },

    dispose(): void {
      if (cancelPending) {
        cancelPending();
        cancelPending = null;
      }
    },
  };
}

// The module's whole config, one schema-validated object in module_settings
// (host.settings). It folds the three sub-feature configs — timers, alarms,
// pomodoro — that previously lived in three separate module_kv rows. The host
// validates every write against this schema and exposes it to clients.
const CONFIG_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    timers: {
      type: "object",
      properties: {
        timers: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string", maxLength: 80, default: "Timer" },
              durationMs: { type: "integer", minimum: 1000, maximum: 86_400_000, default: 60_000 },
              sound: { type: "string", maxLength: 40, default: "bell" },
            },
          },
          default: [],
        },
        volume: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
        muted: { type: "boolean", default: false },
      },
    },
    alarms: {
      type: "object",
      properties: {
        alarms: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string", maxLength: 80, default: "Alarm" },
              hour: { type: "integer", minimum: 0, maximum: 23, default: 0 },
              minute: { type: "integer", minimum: 0, maximum: 59, default: 0 },
              days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, default: [] },
              enabled: { type: "boolean", default: true },
              sound: { type: "string", maxLength: 40, default: "bell" },
              lastFiredTs: { type: "number", default: 0 },
            },
          },
          default: [],
        },
        volume: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
        muted: { type: "boolean", default: false },
      },
    },
    pomodoro: {
      type: "object",
      properties: {
        phases: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              label: { type: "string", maxLength: 40, default: "Phase" },
              ms: { type: "integer", minimum: 1000, maximum: 86_400_000, default: 60_000 },
            },
          },
          default: DEFAULT_TIMER_CONFIG.phases,
        },
        sound: { type: "string", maxLength: 32, default: "bell" },
        volume: { type: "number", minimum: 0, maximum: 1, default: 0.5 },
        muted: { type: "boolean", default: false },
      },
    },
  },
};

const CONFIG_DEFAULT = {
  timers: { timers: [], volume: 0.5, muted: false } satisfies TimersConfig,
  alarms: { alarms: [], volume: 0.5, muted: false } satisfies AlarmsModuleConfig,
  pomodoro: DEFAULT_TIMER_CONFIG,
};

// A kv-shaped adapter over one sub-key of the unified settings object, so the
// engines keep their existing { get, set } config handle unchanged. get()/set()
// read/write host.settings; a set merges just this sub-key (the host validates
// the whole object against CONFIG_SCHEMA and broadcasts it).
function subConfig(host: ServerHost, key: "timers" | "alarms" | "pomodoro") {
  return {
    get: () => (host.settings.get() as Record<string, unknown>)?.[key] ?? null,
    set: (_k: string, value: unknown) => host.settings.set({ [key]: value }),
  };
}

export default function activate(host: ServerHost): () => void {
  host.settings.define(CONFIG_SCHEMA, CONFIG_DEFAULT);

  // ---- timers sub-feature (settings.timers, events "timers:*") -------------
  const timersEngine = createTimerEntryEngine({
    now: host.now,
    schedule: host.schedule,
    broadcast: (event, payload) => host.broadcast(`timers:${event}`, payload),
    kv: subConfig(host, "timers"),
  });
  host.registerRpc("timers:start", (p) => timersEngine.start((p as { id: string }).id));
  host.registerRpc("timers:pause", (p) => timersEngine.pause((p as { id: string }).id));
  host.registerRpc("timers:resume", (p) => timersEngine.resume((p as { id: string }).id));
  host.registerRpc("timers:reset", (p) => timersEngine.reset((p as { id: string }).id));
  host.registerRpc("timers:configUpdate", (next: any) => {
    timersEngine.setConfig(next);
    return timersEngine.getStates();
  });

  // ---- alarms sub-feature (settings.alarms, events "alarms:*") -------------
  const alarmsEngine = createAlarmEngine({
    now: host.now,
    schedule: host.schedule,
    interval: host.interval,
    broadcast: (event, payload) => host.broadcast(`alarms:${event}`, payload),
    kv: subConfig(host, "alarms"),
  });
  host.registerRpc("alarms:configUpdate", (params) => {
    alarmsEngine.setConfig(params as Parameters<typeof alarmsEngine.setConfig>[0]);
    return alarmsEngine.getConfig();
  });
  host.registerRpc("alarms:dismiss", (params) => {
    const payload = params as { kind: "alarm" | "timer"; id: string };
    alarmsEngine.dismiss(payload.kind, payload.id);
  });

  // ---- pomodoro sub-feature (settings.pomodoro, events "pomodoro:*") -------
  const pomoCfg = (subConfig(host, "pomodoro").get() as TimerConfig | null) ?? DEFAULT_TIMER_CONFIG;
  const pomoEngine = createTimerEngine({
    now: host.now,
    schedule: host.schedule,
    broadcast: (state) => host.broadcast("pomodoro:state", state),
    config: pomoCfg,
  });
  host.registerRpc("pomodoro:start", () => pomoEngine.start());
  host.registerRpc("pomodoro:pause", () => pomoEngine.pause());
  host.registerRpc("pomodoro:resume", () => pomoEngine.resume());
  host.registerRpc("pomodoro:stop", () => pomoEngine.stop());
  host.registerRpc("pomodoro:skip", () => pomoEngine.skip());
  host.registerRpc("pomodoro:getState", () => pomoEngine.getState());
  host.registerRpc("pomodoro:setConfig", (params) => {
    const cfg = params as TimerConfig;
    subConfig(host, "pomodoro").set("config", cfg);
    return pomoEngine.setConfig(cfg);
  });

  return () => {
    timersEngine.dispose();
    alarmsEngine.dispose();
    pomoEngine.dispose();
  };
}
