import { describe, test, expect } from "bun:test";
import { createAlarmEngine, nextDueTs, prevDueTs } from "./server.ts";
import type { AlarmsModuleConfig } from "./server.ts";
import type { Alarm } from "./shared.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FireRecord = { id: string; seq: number };
type ConfigRecord = AlarmsModuleConfig;

function makeKv(initial?: AlarmsModuleConfig) {
  let stored: AlarmsModuleConfig | undefined = initial;
  return {
    get(key: string): unknown {
      if (key === "config") return stored;
      return undefined;
    },
    set(key: string, value: unknown): void {
      if (key === "config") stored = value as AlarmsModuleConfig;
    },
    stored() {
      return stored;
    },
  };
}

// schedule: captures the registered callback; fire() drives it manually.
function makeSchedule() {
  let pending: (() => void) | null = null;
  const schedule = (_delayMs: number, cb: () => void): (() => void) => {
    pending = cb;
    return () => {
      pending = null;
    };
  };
  const fire = () => {
    const cb = pending;
    pending = null;
    cb?.();
  };
  return { schedule, fire };
}

// interval: captures the registered callback; tick() drives it manually.
function makeInterval() {
  let pending: (() => void) | null = null;
  const interval = (_ms: number, cb: () => void): (() => void) => {
    pending = cb;
    return () => {
      pending = null;
    };
  };
  const tick = () => pending?.();
  return { interval, tick };
}

function makeEngine(cfg: AlarmsModuleConfig, clockMs: number) {
  let clock = clockMs;
  const fires: FireRecord[] = [];
  const configs: ConfigRecord[] = [];
  const kv = makeKv(cfg);
  const { schedule, fire: fireSched } = makeSchedule();
  const { interval, tick: tickSafety } = makeInterval();

  const engine = createAlarmEngine({
    now: () => clock,
    schedule,
    interval,
    broadcast: (event, payload) => {
      if (event === "fire") fires.push(payload as FireRecord);
      if (event === "config") configs.push(payload as ConfigRecord);
    },
    kv,
  });

  return { engine, fires, configs, kv, fireSched, tickSafety, setTime: (t: number) => { clock = t; } };
}

// Minimal alarm builders
const oneShot = (hour: number, minute: number, overrides: Partial<Alarm> = {}): Alarm => ({
  id: "a",
  label: "Wake",
  hour,
  minute,
  days: [],
  enabled: true,
  sound: "bell",
  ...overrides,
});

const recurring = (hour: number, minute: number, days: number[], overrides: Partial<Alarm> = {}): Alarm => ({
  id: "a",
  label: "Daily",
  hour,
  minute,
  days,
  enabled: true,
  sound: "bell",
  ...overrides,
});

const emptyCfg = (): AlarmsModuleConfig => ({ alarms: [], volume: 0.5, muted: false });

// ---------------------------------------------------------------------------
// Pure function tests: nextDueTs
// ---------------------------------------------------------------------------

describe("nextDueTs", () => {
  // 2026-06-24 is a Wednesday (day 3). 09:00 local.
  const wedMorning = new Date(2026, 5, 24, 9, 0, 0, 0).getTime();

  test("one-shot later today", () => {
    const a = oneShot(17, 30);
    const due = nextDueTs(a, wedMorning)!;
    expect(new Date(due).getHours()).toBe(17);
    expect(new Date(due).getMinutes()).toBe(30);
    expect(new Date(due).getDate()).toBe(24); // still today
  });

  test("one-shot whose time already passed rolls to tomorrow", () => {
    const a = oneShot(8, 0);
    const due = nextDueTs(a, wedMorning)!;
    expect(new Date(due).getDate()).toBe(25); // tomorrow
    expect(new Date(due).getHours()).toBe(8);
  });

  test("recurring picks the next listed weekday", () => {
    // Fires Mondays (1) and Fridays (5). From Wed → next is Friday the 26th.
    const a = recurring(9, 0, [1, 5]);
    const due = nextDueTs(a, wedMorning)!;
    expect(new Date(due).getDay()).toBe(5);
    expect(new Date(due).getDate()).toBe(26);
  });

  test("recurring today but time passed → next week's same day", () => {
    // Fires Wednesdays (3) at 08:00; it's Wed 09:00 → next Wed the 1st of July.
    const a = recurring(8, 0, [3]);
    const due = nextDueTs(a, wedMorning)!;
    expect(new Date(due).getDay()).toBe(3);
    expect(new Date(due).getDate()).toBe(1); // Jul 1
  });

  test("disabled alarm returns null", () => {
    const a = oneShot(9, 0, { enabled: false });
    expect(nextDueTs(a, wedMorning)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pure function tests: prevDueTs
// ---------------------------------------------------------------------------

describe("prevDueTs", () => {
  // 2026-06-24 Wednesday (day 3), 09:00 local.
  const wedMorning = new Date(2026, 5, 24, 9, 0, 0, 0).getTime();

  test("one-shot whose time passed today → today's instant", () => {
    const a = oneShot(8, 0);
    const due = prevDueTs(a, wedMorning)!;
    expect(new Date(due).getDate()).toBe(24);
    expect(new Date(due).getHours()).toBe(8);
  });

  test("one-shot still upcoming today → yesterday's instant", () => {
    const a = oneShot(17, 0);
    const due = prevDueTs(a, wedMorning)!;
    expect(new Date(due).getDate()).toBe(23); // yesterday
    expect(new Date(due).getHours()).toBe(17);
  });

  test("recurring → most recent past matching weekday", () => {
    // Wednesdays (3) at 08:00; it's Wed 09:00 → today 08:00 is the prev occurrence.
    const a = recurring(8, 0, [3]);
    const due = prevDueTs(a, wedMorning)!;
    expect(new Date(due).getDay()).toBe(3);
    expect(new Date(due).getDate()).toBe(24);
  });

  test("disabled → null", () => {
    const a = oneShot(8, 0, { enabled: false });
    expect(prevDueTs(a, wedMorning)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Engine: alarm firing + miss recovery
// ---------------------------------------------------------------------------

describe("alarm firing + miss recovery", () => {
  const wed0900 = new Date(2026, 5, 24, 9, 0, 0, 0).getTime();
  const wed0930 = new Date(2026, 5, 24, 9, 30, 0, 0).getTime();
  const wed0945 = new Date(2026, 5, 24, 9, 45, 0, 0).getTime();

  test("init does not retroactively fire an alarm whose time already passed today", () => {
    // 08:00 already passed; engine seeds lastFiredTs to 'now' (09:00) so prevDueTs
    // finds 08:00 which is < lastFiredTs=09:00 → skipped.
    const cfg: AlarmsModuleConfig = { alarms: [oneShot(8, 0)], volume: 0.5, muted: false };
    const { engine, fires } = makeEngine(cfg, wed0900);
    engine.fireDuePass();
    expect(fires).toHaveLength(0);
  });

  test("a schema-defaulted lastFiredTs does not cause a retroactive fire", () => {
    // host.settings fills a missing numeric field with 0. It must still be
    // treated as a newly-created alarm, not as an occurrence at Unix epoch.
    const cfg: AlarmsModuleConfig = {
      alarms: [oneShot(8, 0, { lastFiredTs: 0 })],
      volume: 0.5,
      muted: false,
    };
    const { engine, fires, kv } = makeEngine(cfg, wed0900);

    engine.fireDuePass();
    expect(fires).toHaveLength(0);
    expect(kv.stored()!.alarms[0]!.lastFiredTs).toBe(wed0900);
  });

  test("fires once when occurrence is reached, not again on second pass", () => {
    const cfg: AlarmsModuleConfig = { alarms: [oneShot(9, 30)], volume: 0.5, muted: false };
    const { engine, fires, setTime } = makeEngine(cfg, wed0900);

    engine.fireDuePass();
    expect(fires).toHaveLength(0); // not due yet at 09:00

    setTime(wed0930);
    engine.fireDuePass();
    expect(fires).toHaveLength(1);

    engine.fireDuePass(); // immediate re-check
    expect(fires).toHaveLength(1); // dedup
  });

  test("recovers a fire missed during a long pause, exactly once", () => {
    const cfg: AlarmsModuleConfig = { alarms: [oneShot(9, 30)], volume: 0.5, muted: false };
    const { engine, fires, setTime } = makeEngine(cfg, wed0900);

    // Jump well past 09:30 — simulating sleep where the setTimeout never ran.
    setTime(wed0945);
    engine.fireDuePass();
    expect(fires).toHaveLength(1);

    engine.fireDuePass(); // second tick must NOT re-fire
    expect(fires).toHaveLength(1);
  });

  test("one-shot alarm disables itself after firing", () => {
    const cfg: AlarmsModuleConfig = { alarms: [oneShot(9, 30)], volume: 0.5, muted: false };
    const { engine, setTime, kv } = makeEngine(cfg, wed0900);

    setTime(wed0930);
    engine.fireDuePass();
    expect(kv.stored()!.alarms[0].enabled).toBe(false);
  });

  test("recurring alarm fires again on its next occurrence (across day boundary)", () => {
    const daily = recurring(9, 30, [0, 1, 2, 3, 4, 5, 6]);
    const cfg: AlarmsModuleConfig = { alarms: [daily], volume: 0.5, muted: false };
    const { engine, fires, setTime, kv } = makeEngine(cfg, wed0900);

    setTime(wed0930);
    engine.fireDuePass();
    engine.fireDuePass(); // same-day re-check → dedup
    expect(fires).toHaveLength(1);
    expect(kv.stored()!.alarms[0].enabled).toBe(true); // recurring stays enabled

    const thu0930 = new Date(2026, 5, 25, 9, 30, 0, 0).getTime();
    setTime(thu0930);
    engine.fireDuePass();
    expect(fires).toHaveLength(2); // next occurrence fires
  });

  test("a persisted lastFiredTs survives 'restart' and does not re-fire that occurrence", () => {
    // Pre-fire at 09:30; "restart" at 09:35 — should NOT re-fire 09:30.
    const firedAt = new Date(2026, 5, 24, 9, 30, 0, 0).getTime();
    const alarm = recurring(9, 30, [0, 1, 2, 3, 4, 5, 6], { lastFiredTs: firedAt });
    const cfg: AlarmsModuleConfig = { alarms: [alarm], volume: 0.5, muted: false };
    const bootTime = new Date(2026, 5, 24, 9, 35, 0, 0).getTime();
    const { engine, fires, kv } = makeEngine(cfg, bootTime);

    // seedLastFired must NOT clobber the persisted lastFiredTs
    expect(kv.stored()!.alarms[0].lastFiredTs).toBe(firedAt);
    engine.fireDuePass();
    expect(fires).toHaveLength(0); // today's 09:30 already fired pre-restart
  });

  test("alarms-disabled: a due alarm does not fire", () => {
    // Engine is created with an alarm already due; fireDuePass should skip it.
    const at8 = oneShot(8, 0, { lastFiredTs: 0 });
    const cfg: AlarmsModuleConfig = { alarms: [at8], volume: 0.5, muted: false };
    const now8_30 = new Date(2026, 0, 1, 8, 0, 30).getTime();
    const kv = makeKv(cfg);
    const { schedule } = makeSchedule();
    const { interval } = makeInterval();
    const fires: FireRecord[] = [];
    // disabled = alarmsEnabled false equivalent: pass enabled:false on the alarm
    // In the engine contract the "alarms disabled" feature flag means setConfig
    // with no alarms; alternatively, confirm the engine skips alarms[i].enabled=false.
    const disabledCfg: AlarmsModuleConfig = { alarms: [{ ...at8, enabled: false }], volume: 0.5, muted: false };
    const disabledKv = makeKv(disabledCfg);
    const disabledEngine = createAlarmEngine({
      now: () => now8_30,
      schedule,
      interval,
      broadcast: (event, payload) => {
        if (event === "fire") fires.push(payload as FireRecord);
      },
      kv: disabledKv,
    });
    disabledEngine.fireDuePass();
    expect(fires).toHaveLength(0);
  });

  test("seq increments per fire and is included in the fire payload", () => {
    const daily = recurring(9, 30, [0, 1, 2, 3, 4, 5, 6]);
    const cfg: AlarmsModuleConfig = { alarms: [daily], volume: 0.5, muted: false };
    const { engine, fires, setTime } = makeEngine(cfg, wed0900);

    setTime(wed0930);
    engine.fireDuePass();
    const seq1 = fires[0].seq;

    const thu0930 = new Date(2026, 5, 25, 9, 30, 0, 0).getTime();
    setTime(thu0930);
    engine.fireDuePass();
    expect(fires[1].seq).toBe(seq1 + 1);
  });
});

// ---------------------------------------------------------------------------
// Engine: getConfig / setConfig / dismiss
// ---------------------------------------------------------------------------

describe("getConfig / setConfig", () => {
  test("getConfig returns the current config", () => {
    const cfg = emptyCfg();
    const { engine } = makeEngine(cfg, Date.now());
    expect(engine.getConfig()).toEqual(cfg);
  });

  test("setConfig persists via kv and re-arms", () => {
    const cfg = emptyCfg();
    const { engine, kv } = makeEngine(cfg, Date.now());
    const next: AlarmsModuleConfig = { alarms: [oneShot(10, 0)], volume: 0.8, muted: true };
    engine.setConfig(next);
    expect(kv.stored()).toEqual(next);
    expect(engine.getConfig()).toEqual(next);
  });

  test("dismiss is a no-op (no throw)", () => {
    const { engine } = makeEngine(emptyCfg(), Date.now());
    expect(() => engine.dismiss("alarm", "a")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Engine: dispose cancels schedules
// ---------------------------------------------------------------------------

describe("dispose", () => {
  test("dispose does not throw and engine can be disposed cleanly", () => {
    const cfg: AlarmsModuleConfig = { alarms: [oneShot(9, 0)], volume: 0.5, muted: false };
    const { engine } = makeEngine(cfg, new Date(2026, 5, 24, 8, 0, 0, 0).getTime());
    expect(() => engine.dispose()).not.toThrow();
  });
});
