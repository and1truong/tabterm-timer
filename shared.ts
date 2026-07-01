// Timer domain + wire types the module borrows. Copied from tabterm's
// src/shared/types.ts at extraction — the host keeps its own copies for the
// legacy settings-row global timer; the module owns this self-contained set so
// it has no deep import into a host's src/. These are stable value-object
// shapes; if the host contract changes them, re-sync by hand.

// One phase of the Pomodoro-style timer: a label and a duration in ms.
export interface TimerPhase {
  label: string;
  ms: number;
}

// Persisted timer configuration. `sound` is an id into SOUND_BANK; `none` is
// silent. `muted` is independent of `sound` so the choice is preserved across
// mute/unmute.
export interface TimerConfig {
  phases: TimerPhase[]; // ≥ 1, ≤ 20
  sound: string;
  volume: number; // 0..1
  muted: boolean;
}

// Live timer state held server-side, broadcast to every client. `endTs` is
// authoritative while running; `remainingMs` while paused. `autoAdvances` is
// bumped only when a phase boundary fires from the server's internal setTimeout
// — clients chime on increases, not on user-driven start/pause/resume/skip/stop.
export interface TimerRunState {
  phaseIndex: number;
  running: boolean;
  endTs: number;
  remainingMs: number;
  autoAdvances: number;
}

// A scheduled clock-time alarm. Fires at `hour:minute` local server time. When
// `days` is empty the alarm is one-shot (auto-disables after firing); otherwise
// it repeats on the listed weekdays (0=Sun..6=Sat). `sound` is an id into
// SOUND_BANK; "none" = silent.
export interface Alarm {
  id: string;
  label: string;
  hour: number; // 0..23
  minute: number; // 0..59
  days: number[]; // [] = one-shot; else subset of 0..6
  enabled: boolean;
  sound: string;
  // Epoch-ms of the most recent scheduled occurrence already fired. Persisted so
  // a restart, or a miss recovered after a pause, never re-fires the same
  // occurrence. Absent until the alarm has fired once.
  lastFiredTs?: number;
}

// A fire event broadcast when an alarm or timer comes due. `seq` is a monotonic
// counter (like TimerRunState.autoAdvances): a client acts only on a seq higher
// than the last it handled, so a replayed fire after reconnect never
// double-chimes.
export interface AlarmFire {
  kind: "alarm" | "timer";
  id: string;
  label: string;
  sound: string;
  seq: number;
}
