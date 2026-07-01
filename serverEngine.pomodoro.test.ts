import { describe, test, expect } from "bun:test";
import { createTimerEngine } from "./server.ts";
import type { TimerConfig } from "./shared.ts";

const PHASES: TimerConfig = {
  phases: [
    { label: "A", ms: 60_000 },
    { label: "B", ms: 30_000 },
    { label: "C", ms: 90_000 },
  ],
  sound: "bell",
  volume: 0.5,
  muted: false,
};

// Fake schedule: captures the registered callback so tests can fire it manually.
function makeSchedule() {
  let pending: (() => void) | null = null;
  const schedule = (delayMs: number, cb: () => void): (() => void) => {
    pending = cb;
    return () => { pending = null; };
  };
  const fire = () => { const cb = pending; pending = null; cb?.(); };
  const hasPending = () => pending !== null;
  return { schedule, fire, hasPending };
}

describe("start", () => {
  test("creates a running phase-0 timer clocked to phases[0].ms", () => {
    let t = 1000;
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => t, schedule, broadcast: () => {}, config: PHASES });
    const s = eng.start();
    expect(s).not.toBeNull();
    expect(s!.phaseIndex).toBe(0);
    expect(s!.running).toBe(true);
    expect(s!.remainingMs).toBe(PHASES.phases[0].ms);
    expect(s!.endTs).toBe(t + PHASES.phases[0].ms);
  });

  test("restarting from a later phase resets to phase 0", () => {
    let t = 1000;
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => t, schedule, broadcast: () => {}, config: PHASES });
    eng.start();
    eng.skip();
    expect(eng.getState()!.phaseIndex).toBe(1);
    eng.start();
    expect(eng.getState()!.phaseIndex).toBe(0);
  });
});

describe("pause / resume", () => {
  test("pause preserves remaining time and clears running", () => {
    let t = 1000;
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => t, schedule, broadcast: () => {}, config: PHASES });
    eng.start();
    t = 5000; // advance time
    const s = eng.pause();
    expect(s!.running).toBe(false);
    expect(s!.remainingMs).toBe(PHASES.phases[0].ms - (5000 - 1000));
  });

  test("resume clocks endTs to now + remainingMs and flips running back on", () => {
    let t = 1000;
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => t, schedule, broadcast: () => {}, config: PHASES });
    eng.start();
    t = 5000;
    eng.pause();
    const remaining = eng.getState()!.remainingMs;
    t = 10000;
    const s = eng.resume();
    expect(s!.running).toBe(true);
    expect(s!.endTs).toBe(t + remaining);
  });

  test("pause is a no-op when idle", () => {
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => 0, schedule, broadcast: () => {}, config: PHASES });
    expect(eng.pause()).toBeNull();
  });

  test("pause is a no-op when already paused", () => {
    let t = 1000;
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => t, schedule, broadcast: () => {}, config: PHASES });
    eng.start();
    eng.pause();
    const snap = eng.getState()!;
    const again = eng.pause();
    expect(again).toEqual(snap);
  });
});

describe("skip", () => {
  test("advances to next phase, wraps at end, leaves autoAdvances untouched", () => {
    let t = 1000;
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => t, schedule, broadcast: () => {}, config: PHASES });
    eng.start();
    expect(eng.getState()!.autoAdvances).toBe(0);
    eng.skip();
    expect(eng.getState()!.phaseIndex).toBe(1);
    expect(eng.getState()!.autoAdvances).toBe(0);
    eng.skip();
    expect(eng.getState()!.phaseIndex).toBe(2);
    eng.skip(); // wraps
    expect(eng.getState()!.phaseIndex).toBe(0);
    expect(eng.getState()!.autoAdvances).toBe(0);
  });

  test("no-op when idle", () => {
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => 0, schedule, broadcast: () => {}, config: PHASES });
    expect(eng.skip()).toBeNull();
  });
});

describe("stop", () => {
  test("clears state and returns null", () => {
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => 0, schedule, broadcast: () => {}, config: PHASES });
    eng.start();
    expect(eng.stop()).toBeNull();
    expect(eng.getState()).toBeNull();
  });
});

describe("setConfig", () => {
  test("clamps phaseIndex into new phases range", () => {
    let t = 1000;
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => t, schedule, broadcast: () => {}, config: PHASES });
    eng.start();
    eng.skip(); eng.skip();
    expect(eng.getState()!.phaseIndex).toBe(2);
    const s = eng.setConfig({
      ...PHASES,
      phases: [{ label: "X", ms: 60_000 }, { label: "Y", ms: 30_000 }],
    });
    expect(s!.phaseIndex).toBe(1);
  });

  test("restarts current phase clock so new duration takes effect", () => {
    let t = 1000;
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => t, schedule, broadcast: () => {}, config: PHASES });
    eng.start();
    const s = eng.setConfig({
      ...PHASES,
      phases: [{ label: "Long", ms: 99 * 60_000 }, ...PHASES.phases.slice(1)],
    });
    expect(s!.remainingMs).toBe(99 * 60_000);
  });

  test("paused → stays paused; remainingMs follows new phase length", () => {
    let t = 1000;
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => t, schedule, broadcast: () => {}, config: PHASES });
    eng.start();
    eng.pause();
    const s = eng.setConfig({
      ...PHASES,
      phases: [{ label: "Short", ms: 5_000 }, ...PHASES.phases.slice(1)],
    });
    expect(s!.running).toBe(false);
    expect(s!.remainingMs).toBe(5_000);
  });

  test("returns null when idle", () => {
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => 0, schedule, broadcast: () => {}, config: PHASES });
    expect(eng.setConfig(PHASES)).toBeNull();
  });
});

describe("auto-advance", () => {
  test("scheduled callback bumps autoAdvances and calls broadcast", () => {
    let t = 1000;
    const { schedule, fire } = makeSchedule();
    const broadcasts: any[] = [];
    const eng = createTimerEngine({
      now: () => t,
      schedule,
      broadcast: (s) => broadcasts.push(s),
      config: PHASES,
    });
    eng.start();
    t = 1000 + PHASES.phases[0].ms + 1; // advance past phase end
    fire(); // simulate the scheduled phase-end callback firing
    const cur = eng.getState();
    expect(cur).not.toBeNull();
    expect(cur!.phaseIndex).toBe(1);
    expect(cur!.autoAdvances).toBe(1);
    expect(broadcasts.length).toBeGreaterThan(0);
    // start() also broadcasts (autoAdvances 0), so the auto-advance is the latest.
    expect(broadcasts.at(-1).autoAdvances).toBe(1);
  });

  test("start/skip do not bump autoAdvances", () => {
    let t = 1000;
    const { schedule } = makeSchedule();
    const eng = createTimerEngine({ now: () => t, schedule, broadcast: () => {}, config: PHASES });
    const s1 = eng.start();
    const before = s1!.autoAdvances;
    const s2 = eng.skip();
    expect(s2!.autoAdvances).toBe(before);
    const s3 = eng.start();
    expect(s3!.autoAdvances).toBe(before);
  });
});

describe("manual actions broadcast (live UI sync)", () => {
  // The chip's controls ignore the RPC return value and rely on the broadcast to
  // update the UI. So every manual mutation must broadcast its new state — otherwise
  // the clock doesn't visibly start/stop until a refresh re-reads getState.
  function setup() {
    let t = 1000;
    const { schedule, fire } = makeSchedule();
    const broadcasts: (any)[] = [];
    const eng = createTimerEngine({
      now: () => t,
      schedule,
      broadcast: (s) => broadcasts.push(s),
      config: PHASES,
    });
    return { eng, broadcasts, fire, setT: (v: number) => (t = v) };
  }

  test("start broadcasts the running state", () => {
    const { eng, broadcasts } = setup();
    eng.start();
    expect(broadcasts.length).toBe(1);
    expect(broadcasts.at(-1)!.running).toBe(true);
  });

  test("pause broadcasts the paused state", () => {
    const { eng, broadcasts } = setup();
    eng.start();
    const n = broadcasts.length;
    eng.pause();
    expect(broadcasts.length).toBe(n + 1);
    expect(broadcasts.at(-1)!.running).toBe(false);
  });

  test("resume broadcasts the resumed state", () => {
    const { eng, broadcasts, setT } = setup();
    eng.start();
    eng.pause();
    const n = broadcasts.length;
    setT(5000);
    eng.resume();
    expect(broadcasts.length).toBe(n + 1);
    expect(broadcasts.at(-1)!.running).toBe(true);
  });

  test("skip broadcasts the next phase", () => {
    const { eng, broadcasts } = setup();
    eng.start();
    const n = broadcasts.length;
    eng.skip();
    expect(broadcasts.length).toBe(n + 1);
    expect(broadcasts.at(-1)!.phaseIndex).toBe(1);
  });

  test("stop broadcasts the cleared (null) state", () => {
    const { eng, broadcasts } = setup();
    eng.start();
    const n = broadcasts.length;
    eng.stop();
    expect(broadcasts.length).toBe(n + 1);
    expect(broadcasts.at(-1)).toBeNull();
  });
});

describe("dispose", () => {
  test("cancels any pending schedule", () => {
    let t = 1000;
    const { schedule, hasPending } = makeSchedule();
    const eng = createTimerEngine({ now: () => t, schedule, broadcast: () => {}, config: PHASES });
    eng.start();
    expect(hasPending()).toBe(true);
    eng.dispose();
    expect(hasPending()).toBe(false);
  });
});
