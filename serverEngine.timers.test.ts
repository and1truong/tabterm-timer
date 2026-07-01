import { describe, test, expect } from "bun:test";
import { createTimerEntryEngine } from "./server.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

type FireRecord = { kind: string; id: string; seq: number };

function makeKv(initial?: TimersConfig) {
  let stored: TimersConfig | undefined = initial;
  return {
    get(key: string): unknown {
      if (key === "config") return stored;
      return undefined;
    },
    set(key: string, value: unknown): void {
      if (key === "config") stored = value as TimersConfig;
    },
    stored() {
      return stored;
    },
    subscribe(_key: string, _cb: () => void): () => void {
      return () => {};
    },
  };
}

// schedule: captures the last registered callback per id; fire(id) drives it manually.
function makeSchedule() {
  const pending = new Map<string, () => void>();
  const schedule = (_delayMs: number, cb: () => void): (() => void) => {
    // We return a cancel fn; caller maps id->cancelFn so we capture one slot
    // per-invocation. We store by sequence so tests can drive by order.
    let key = `_${pending.size}`;
    pending.set(key, cb);
    return () => {
      pending.delete(key);
    };
  };
  // fire the last registered pending cb (the most recently armed timer)
  const fireLast = () => {
    if (pending.size === 0) return;
    const keys = [...pending.keys()];
    const last = keys[keys.length - 1]!;
    const cb = pending.get(last)!;
    pending.delete(last);
    cb();
  };
  return { schedule, fireLast, pendingCount: () => pending.size };
}

function makeEngine(cfg: TimersConfig, clockMs: number) {
  let clock = clockMs;
  const fires: FireRecord[] = [];
  const statesBroadcasts: TimerEntryRunState[][] = [];
  const kv = makeKv(cfg);
  const { schedule, fireLast, pendingCount } = makeSchedule();

  const engine = createTimerEntryEngine({
    now: () => clock,
    schedule,
    broadcast: (event, payload) => {
      if (event === "fire") fires.push(payload as FireRecord);
      if (event === "states") statesBroadcasts.push(payload as TimerEntryRunState[]);
    },
    kv,
  });

  return {
    engine,
    fires,
    statesBroadcasts,
    kv,
    fireLast,
    pendingCount,
    setTime: (t: number) => { clock = t; },
  };
}

const baseCfg = (): TimersConfig => ({
  timers: [
    { id: "tea", label: "Tea", durationMs: 4 * 60_000, sound: "bell" },
    { id: "pom", label: "Pomodoro", durationMs: 25 * 60_000, sound: "chime" },
  ],
  volume: 0.5,
  muted: false,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getStates seeds idle per timer", () => {
  test("returns one idle run state per configured timer", () => {
    const { engine } = makeEngine(baseCfg(), 1_000_000);
    const states = engine.getStates();
    expect(states.map((s) => s.id).sort()).toEqual(["pom", "tea"]);
    const tea = states.find((s) => s.id === "tea")!;
    expect(tea.running).toBe(false);
    expect(tea.remainingMs).toBe(4 * 60_000);
  });
});

describe("start / pause / resume / reset", () => {
  test("start sets running with endTs = now + duration", () => {
    const clock = 1_000_000;
    const { engine } = makeEngine(baseCfg(), clock);
    const states = engine.start("tea");
    const tea = states.find((s) => s.id === "tea")!;
    expect(tea.running).toBe(true);
    expect(tea.endTs).toBe(clock + 4 * 60_000);
  });

  test("pause freezes remainingMs; resume re-bases endTs", () => {
    let clock = 1_000_000;
    const { engine, setTime } = makeEngine(baseCfg(), clock);
    engine.start("tea");

    clock += 60_000; // 1 min elapsed
    setTime(clock);
    const paused = engine.pause("tea").find((s) => s.id === "tea")!;
    expect(paused.running).toBe(false);
    expect(paused.remainingMs).toBe(3 * 60_000);

    clock += 10_000; // time passes while paused — must not count
    setTime(clock);
    const resumed = engine.resume("tea").find((s) => s.id === "tea")!;
    expect(resumed.running).toBe(true);
    expect(resumed.endTs).toBe(clock + 3 * 60_000);
  });

  test("reset returns to idle at full duration", () => {
    let clock = 1_000_000;
    const { engine, setTime } = makeEngine(baseCfg(), clock);
    engine.start("tea");
    clock += 120_000;
    setTime(clock);
    const r = engine.reset("tea").find((s) => s.id === "tea")!;
    expect(r.running).toBe(false);
    expect(r.remainingMs).toBe(4 * 60_000);
  });

  test("start with durationMs <= 0 is a no-op", () => {
    const cfg: TimersConfig = {
      timers: [{ id: "zero", label: "Zero", durationMs: 0, sound: "bell" }],
      volume: 0.5,
      muted: false,
    };
    const { engine } = makeEngine(cfg, 1_000_000);
    const before = engine.getStates();
    const after = engine.start("zero");
    expect(after).toEqual(before);
  });
});

describe("fire resets to idle + bumps seq", () => {
  test("scheduled fire broadcasts fire event + resets timer to idle + broadcasts states", () => {
    const clock = 1_000_000;
    const { engine, fires, statesBroadcasts, fireLast } = makeEngine(baseCfg(), clock);
    engine.start("tea");

    fireLast(); // trigger the scheduled callback

    expect(fires).toHaveLength(1);
    expect(fires[0]!.kind).toBe("timer");
    expect(fires[0]!.id).toBe("tea");
    expect(fires[0]!.seq).toBe(1);

    // states broadcast after fire → tea is back to idle
    expect(statesBroadcasts).toHaveLength(1);
    const teaAfter = statesBroadcasts[0]!.find((s) => s.id === "tea")!;
    expect(teaAfter.running).toBe(false);
    expect(teaAfter.remainingMs).toBe(4 * 60_000);
  });

  test("seq increments per fire", () => {
    const clock = 1_000_000;
    const { engine, fires, fireLast } = makeEngine(baseCfg(), clock);
    engine.start("tea");
    fireLast();
    engine.start("tea");
    fireLast();
    expect(fires).toHaveLength(2);
    expect(fires[1]!.seq).toBe(fires[0]!.seq! + 1);
  });
});

describe("setConfig prunes run state for removed timers", () => {
  test("run state for a dropped timer is removed", () => {
    const cfg = baseCfg();
    const { engine } = makeEngine(cfg, 1_000_000);
    engine.start("tea");

    const next: TimersConfig = { ...cfg, timers: [cfg.timers[1]!] }; // drop "tea"
    engine.setConfig(next);

    expect(engine.getStates().map((s) => s.id)).toEqual(["pom"]);
  });
});

describe("dispose cancels all pending timers", () => {
  test("dispose does not throw", () => {
    const { engine } = makeEngine(baseCfg(), 1_000_000);
    engine.start("tea");
    engine.start("pom");
    expect(() => engine.dispose()).not.toThrow();
  });
});
