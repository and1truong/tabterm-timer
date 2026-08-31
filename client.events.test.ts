import { describe, expect, test } from "bun:test";
import activate from "./src/index.tsx";

// The host contract deliberately passes the raw module:event payload to
// events.on callbacks. Keep this regression test at the module boundary: an
// envelope-shaped cast makes timer/alarm fires throw before they can chime.
function activateWithHost() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const chimes: Array<{ sound: string; volume: number }> = [];
  const notifications: Array<{ title: string; body?: string }> = [];

  activate({
    settings: {
      get: () => ({
        timers: { timers: [], volume: 0.25, muted: false },
        alarms: { alarms: [], volume: 0.75, muted: false },
        pomodoro: { sound: "chime", volume: 0.5, muted: false },
      }),
    },
    events: {
      on: (event: string, cb: (payload: unknown) => void) => {
        listeners.set(event, cb);
        return () => listeners.delete(event);
      },
    },
    actions: {
      playChime: (sound: string, volume: number) => chimes.push({ sound, volume }),
      notify: (opts: { title: string; body?: string }) => notifications.push(opts),
    },
    ui: { registerUI: () => () => {}, toggleFloatingBox: () => {} },
  } as any);

  const emit = (event: string, payload: unknown) => listeners.get(event)?.(payload);
  return { chimes, notifications, emit };
}

describe("timer client event payloads", () => {
  test("handles raw timer and alarm fire payloads", () => {
    const { chimes, notifications, emit } = activateWithHost();

    emit("timers:fire", { kind: "timer", id: "tea", label: "Tea", sound: "ding", seq: 1 });
    emit("alarms:fire", { kind: "alarm", id: "wake", label: "Wake", sound: "bell", seq: 1 });

    expect(chimes).toEqual([
      { sound: "ding", volume: 0.25 },
      { sound: "bell", volume: 0.75 },
    ]);
    expect(notifications).toEqual([
      { title: "Timer", body: "Tea" },
      { title: "Alarm", body: "Wake" },
    ]);
  });
});
