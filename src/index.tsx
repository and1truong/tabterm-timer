import type { ClientHost } from "@tabterm/module-host/client";
import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import {
  Timer as TimerIcon, Play, Pause, RotateCcw, Plus, Trash2, Volume2, VolumeX, ChevronDown,
  AlarmClock, BellRing,
} from "lucide-react";

// The module keeps its whole config in one schema-validated host.settings object
// with sub-keys { timers, alarms, pomodoro } (see server.ts CONFIG_SCHEMA). These
// helpers read/subscribe to one sub-key of that object, so each sub-feature's
// client stays keyed by its own name.
function getSub<T>(host: ClientHost, key: "timers" | "alarms" | "pomodoro"): T | null {
  return ((host.settings.get() as Record<string, unknown> | null)?.[key] as T) ?? null;
}
function subscribeSub<T>(
  host: ClientHost,
  key: "timers" | "alarms" | "pomodoro",
  cb: (v: T | null) => void,
): () => void {
  return host.settings.subscribe((config) => {
    cb(((config as Record<string, unknown> | null)?.[key] as T) ?? null);
  });
}

// ===========================================================================
// TIMERS
// ===========================================================================

// ---------------------------------------------------------------------------
// Types
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

// ---------------------------------------------------------------------------
// Shared sound + CSS helpers (identical in timers and alarms — one definition)
// ---------------------------------------------------------------------------

const SOUND_OPTIONS: { id: string; label: string }[] = [
  { id: "bell", label: "Bell" },
  { id: "chime", label: "Chime" },
  { id: "ding", label: "Ding" },
  { id: "soft", label: "Soft" },
  { id: "none", label: "Silent" },
];

const inputCls =
  "text-[11px] bg-transparent border border-[var(--border-2)] rounded px-1.5 py-0.5 outline-none focus:border-[var(--text)]";

const iconBtn =
  "w-6 h-6 grid place-items-center rounded text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-30 disabled:hover:bg-transparent";

// ---------------------------------------------------------------------------
// Formatting helpers (fmt for timers uses ceil; fmtPomo for pomodoro uses floor)
// ---------------------------------------------------------------------------

function fmt(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// TimerRow
// ---------------------------------------------------------------------------

function TimerRow({
  timer,
  status,
  remaining,
  onPrimary,
  onReset,
  onDelete,
}: {
  timer: TimerEntry;
  status: "idle" | "running" | "paused";
  remaining: number;
  onPrimary: () => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const progress = Math.max(0, Math.min(1, 1 - remaining / timer.durationMs));

  return (
    <div className="flex flex-col gap-1 py-1.5 border-b border-[var(--border)] last:border-0">
      <div className="flex items-center gap-2">
        <span
          className="mono text-[18px] font-semibold tabular-nums w-14 shrink-0 leading-none"
          style={{
            color:
              status === "running" && remaining <= 60_000
                ? "var(--orange)"
                : status === "running"
                ? "var(--green)"
                : "var(--text)",
          }}
        >
          {fmt(remaining)}
        </span>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="truncate font-medium">{timer.label}</span>
          <span
            className="text-[10px]"
            style={{
              color:
                status === "running"
                  ? "var(--green)"
                  : status === "paused"
                  ? "var(--orange)"
                  : "var(--muted)",
            }}
          >
            {status === "running" ? "Running" : status === "paused" ? "Paused" : "Idle"}
          </span>
        </div>
        <button
          onClick={onPrimary}
          className={`${iconBtn} border border-[var(--accent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]`}
          title={status === "running" ? "Pause" : status === "paused" ? "Resume" : "Start"}
        >
          {status === "running" ? <Pause size={11} /> : <Play size={11} />}
        </button>
        <button onClick={onReset} disabled={status === "idle"} className={iconBtn} title="Reset">
          <RotateCcw size={11} />
        </button>
        <button onClick={onDelete} className={iconBtn} title="Delete timer">
          <Trash2 size={11} />
        </button>
      </div>
      <div className="h-0.5 rounded-full bg-[var(--border-2)] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${progress * 100}%`,
            background:
              status === "running" && remaining <= 60_000 ? "var(--orange)" : "var(--accent)",
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddTimerForm
// ---------------------------------------------------------------------------

function AddTimerForm({ onAdd }: { onAdd: (t: TimerEntry) => void }) {
  const [mins, setMins] = useState("5");
  const [label, setLabel] = useState("");
  const [sound, setSound] = useState(SOUND_OPTIONS[0]?.id ?? "bell");

  const submit = () => {
    const m = parseFloat(mins);
    if (!Number.isFinite(m) || m <= 0) return;
    onAdd({
      id: crypto.randomUUID(),
      label: label.trim() || "Timer",
      durationMs: Math.round(m * 60_000),
      sound,
    });
    setMins("5");
    setLabel("");
  };

  return (
    <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-[var(--border)]">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <input
            value={mins}
            onChange={(e) => setMins(e.target.value)}
            inputMode="decimal"
            placeholder="Min"
            className={`${inputCls} w-16 tabular-nums text-right`}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
          <span className="opacity-50 text-[11px]">min</span>
        </div>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          maxLength={40}
          className={`${inputCls} flex-1`}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <select
            value={sound}
            onChange={(e) => setSound(e.target.value)}
            className={`${inputCls} w-full pr-5 appearance-none cursor-pointer`}
          >
            {SOUND_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          <ChevronDown size={10} className="absolute right-1 top-1/2 -translate-y-1/2 opacity-70 pointer-events-none" />
        </div>
        <button
          onClick={submit}
          className="flex items-center gap-1 px-2 h-6 rounded-md border border-[var(--accent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]"
        >
          <Plus size={11} />
          <span>Add</span>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimersVolumeRow
// ---------------------------------------------------------------------------

function TimersVolumeRow({
  config,
  onUpdate,
}: {
  config: TimersConfig;
  onUpdate: (next: TimersConfig) => void;
}) {
  return (
    <div className="flex items-center gap-2 pt-2 mt-2 border-t border-[var(--border)]">
      <button
        onClick={() => onUpdate({ ...config, muted: !config.muted })}
        className="text-[var(--muted)] hover:text-[var(--text)]"
        title={config.muted ? "Unmute" : "Mute"}
      >
        {config.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={config.volume}
        onChange={(e) => onUpdate({ ...config, volume: parseFloat(e.target.value) })}
        disabled={config.muted}
        className="flex-1"
        style={{ accentColor: "var(--accent)" }}
      />
      <span className="w-8 text-right tabular-nums opacity-70">
        {Math.round(config.volume * 100)}%
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimersBox (floating box)
// ---------------------------------------------------------------------------

const TIMERS_DEFAULT_CONFIG: TimersConfig = { timers: [], volume: 0.5, muted: false };

function TimersBox({ host }: { host: ClientHost }) {
  const [config, setConfig] = useState<TimersConfig>(
    () => getSub<TimersConfig>(host, "timers") ?? TIMERS_DEFAULT_CONFIG,
  );
  const [states, setStates] = useState<TimerEntryRunState[]>([]);
  const [, tick] = useState(0);

  // Config sync from host.settings
  useEffect(() => {
    return subscribeSub<TimersConfig>(host, "timers", (next) => {
      setConfig(next ?? TIMERS_DEFAULT_CONFIG);
    });
  }, []);

  // Subscribe before seeding, so a concurrent state broadcast cannot be
  // overwritten by an older getStates response.
  useEffect(() => {
    let receivedUpdate = false;
    const off = host.events.on("timers:states", (raw) => {
      receivedUpdate = true;
      setStates(raw as TimerEntryRunState[]);
    });
    host.rpc.call("timers:getStates").then((initial: TimerEntryRunState[]) => {
      if (!receivedUpdate) setStates(initial);
    });
    return off;
  }, []);

  // 1s tick to re-render live countdowns
  useEffect(() => {
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, []);

  function sendConfig(next: TimersConfig) {
    host.rpc.call("timers:configUpdate", next);
    setConfig(next);
  }

  function remainingOf(id: string, fallback: number): number {
    const st = states.find((s) => s.id === id);
    if (!st) return fallback;
    return st.running ? st.endTs - Date.now() : st.remainingMs;
  }

  function timerStatus(id: string, durationMs: number): "idle" | "running" | "paused" {
    const st = states.find((s) => s.id === id);
    if (!st) return "idle";
    if (st.running) return "running";
    return st.remainingMs >= durationMs ? "idle" : "paused";
  }

  const setTimers = (timers: TimerEntry[]) => sendConfig({ ...config, timers });

  return (
    <aside className="shrink-0 float-card flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 h-11 border-b border-[var(--border)] shrink-0">
        <TimerIcon size={15} className="text-[var(--accent-soft)]" />
        <span className="text-xs font-semibold tracking-wide text-[var(--text)] flex-1">TIMERS</span>
        <span className="text-[11px] text-[var(--faint)]">{config.timers.length}</span>
      </div>
      <div
        className="px-3 py-2 max-h-[280px] overflow-y-auto flex flex-col text-[11px]"
        style={{ color: "var(--text)" }}
      >
        {config.timers.length === 0 && (
          <p className="opacity-40 py-2 text-center">No timers</p>
        )}
        {config.timers.map((t) => {
          const status = timerStatus(t.id, t.durationMs);
          return (
            <TimerRow
              key={t.id}
              timer={t}
              status={status}
              remaining={remainingOf(t.id, t.durationMs)}
              onPrimary={() => {
                if (status === "running") host.rpc.call("timers:pause", { id: t.id });
                else if (status === "paused") host.rpc.call("timers:resume", { id: t.id });
                else host.rpc.call("timers:start", { id: t.id });
              }}
              onReset={() => host.rpc.call("timers:reset", { id: t.id })}
              onDelete={() => setTimers(config.timers.filter((x) => x.id !== t.id))}
            />
          );
        })}
        <AddTimerForm onAdd={(t) => setTimers([...config.timers, t])} />
        <TimersVolumeRow config={config} onUpdate={sendConfig} />
      </div>
    </aside>
  );
}

// ===========================================================================
// ALARMS
// ===========================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Alarm {
  id: string;
  label: string;
  hour: number;
  minute: number;
  days: number[];
  enabled: boolean;
  sound: string;
  lastFiredTs?: number;
}

interface AlarmsModuleConfig {
  alarms: Alarm[];
  volume: number;
  muted: boolean;
}

interface RingingItem {
  kind: "alarm";
  id: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Shared ringing store (module-level — bridges separate React trees)
// ---------------------------------------------------------------------------

let _ringing: RingingItem[] = [];
const _listeners = new Set<() => void>();

function getRinging(): RingingItem[] {
  return _ringing;
}

function subscribeRinging(cb: () => void): () => void {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

function setRinging(next: RingingItem[]): void {
  _ringing = next;
  _listeners.forEach((cb) => cb());
}

function pushRinging(item: RingingItem): void {
  if (_ringing.some((r) => r.id === item.id)) return;
  setRinging([..._ringing, item]);
}

function removeRinging(id: string): void {
  setRinging(_ringing.filter((r) => r.id !== id));
}

function useRinging(): RingingItem[] {
  return useSyncExternalStore(subscribeRinging, getRinging);
}

// ---------------------------------------------------------------------------
// Day helpers
// ---------------------------------------------------------------------------

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function recurrence(days: number[]): string {
  if (days.length === 0) return "Once";
  if (days.length === 7) return "Every day";
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)))
    return "Weekdays";
  return days.map((d) => DAYS[d]).join(", ");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const ALARMS_DEFAULT_CONFIG: AlarmsModuleConfig = { alarms: [], volume: 0.5, muted: false };

// ---------------------------------------------------------------------------
// AlarmRow
// ---------------------------------------------------------------------------

function AlarmRow({
  alarm,
  onToggle,
  onDelete,
}: {
  alarm: Alarm;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-[var(--border)] last:border-0">
      <span className="mono text-[18px] font-semibold tabular-nums w-14 shrink-0 leading-none">
        {pad2(alarm.hour)}:{pad2(alarm.minute)}
      </span>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="truncate font-medium">{alarm.label}</span>
        <span className="opacity-50">{recurrence(alarm.days)}</span>
      </div>
      <button
        onClick={onToggle}
        title={alarm.enabled ? "Disable" : "Enable"}
        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
          alarm.enabled ? "bg-[var(--accent)]" : "bg-[var(--border-2)]"
        }`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            alarm.enabled ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
      <button onClick={onDelete} className={iconBtn} title="Delete alarm">
        <Trash2 size={11} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddAlarmForm
// ---------------------------------------------------------------------------

function AddAlarmForm({ onAdd }: { onAdd: (a: Alarm) => void }) {
  const [time, setTime] = useState("08:00");
  const [label, setLabel] = useState("");
  const [days, setDays] = useState<number[]>([]);
  const [sound, setSound] = useState(SOUND_OPTIONS[0]?.id ?? "bell");

  const toggleDay = (d: number) =>
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)
    );

  const submit = () => {
    const [h, m] = time.split(":").map(Number);
    onAdd({
      id: crypto.randomUUID(),
      label: label.trim() || "Alarm",
      hour: h ?? 8,
      minute: m ?? 0,
      days,
      enabled: true,
      sound,
    });
    setTime("08:00");
    setLabel("");
    setDays([]);
  };

  return (
    <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-[var(--border)]">
      <div className="flex items-center gap-2">
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className={`${inputCls} flex-1`}
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label"
          maxLength={40}
          className={`${inputCls} flex-1`}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </div>
      <div className="flex items-center gap-1">
        {DAYS.map((name, d) => (
          <button
            key={d}
            onClick={() => toggleDay(d)}
            className={`w-7 h-6 rounded text-[10px] font-semibold border transition-colors ${
              days.includes(d)
                ? "border-[var(--accent)] text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]"
                : "border-[var(--border-2)] text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hover)]"
            }`}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <select
            value={sound}
            onChange={(e) => setSound(e.target.value)}
            className={`${inputCls} w-full pr-5 appearance-none cursor-pointer`}
          >
            {SOUND_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <ChevronDown
            size={10}
            className="absolute right-1 top-1/2 -translate-y-1/2 opacity-70 pointer-events-none"
          />
        </div>
        <button
          onClick={submit}
          className="flex items-center gap-1 px-2 h-6 rounded-md border border-[var(--accent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]"
        >
          <Plus size={11} />
          <span>Add</span>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AlarmsVolumeRow (differs from TimersVolumeRow only in config type)
// ---------------------------------------------------------------------------

function AlarmsVolumeRow({
  config,
  onUpdate,
}: {
  config: AlarmsModuleConfig;
  onUpdate: (next: AlarmsModuleConfig) => void;
}) {
  return (
    <div className="flex items-center gap-2 pt-2 mt-2 border-t border-[var(--border)]">
      <button
        onClick={() => onUpdate({ ...config, muted: !config.muted })}
        className="text-[var(--muted)] hover:text-[var(--text)]"
        title={config.muted ? "Unmute" : "Mute"}
      >
        {config.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={config.volume}
        onChange={(e) => onUpdate({ ...config, volume: parseFloat(e.target.value) })}
        disabled={config.muted}
        className="flex-1"
        style={{ accentColor: "var(--accent)" }}
      />
      <span className="w-8 text-right tabular-nums opacity-70">
        {Math.round(config.volume * 100)}%
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AlarmsBox (floating box)
// ---------------------------------------------------------------------------

function AlarmsBox({ host }: { host: ClientHost }) {
  const [config, setConfig] = useState<AlarmsModuleConfig>(
    () => getSub<AlarmsModuleConfig>(host, "alarms") ?? ALARMS_DEFAULT_CONFIG,
  );

  useEffect(() => {
    return subscribeSub<AlarmsModuleConfig>(host, "alarms", (next) => {
      setConfig(next ?? ALARMS_DEFAULT_CONFIG);
    });
  }, []);

  function sendConfig(next: AlarmsModuleConfig) {
    host.rpc.call("alarms:configUpdate", next);
    setConfig(next);
  }

  const setAlarms = (alarms: Alarm[]) => sendConfig({ ...config, alarms });

  return (
    <aside className="shrink-0 float-card flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 h-11 border-b border-[var(--border)] shrink-0">
        <AlarmClock size={15} className="text-[var(--accent-soft)]" />
        <span className="text-xs font-semibold tracking-wide text-[var(--text)] flex-1">ALARMS</span>
        <span className="text-[11px] text-[var(--faint)]">{config.alarms.length}</span>
      </div>
      <div
        className="px-3 py-2 max-h-[280px] overflow-y-auto flex flex-col text-[11px]"
        style={{ color: "var(--text)" }}
      >
        {config.alarms.length === 0 && (
          <p className="opacity-40 py-2 text-center">No alarms</p>
        )}
        {config.alarms.map((a) => (
          <AlarmRow
            key={a.id}
            alarm={a}
            onToggle={() =>
              setAlarms(config.alarms.map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled } : x)))
            }
            onDelete={() => setAlarms(config.alarms.filter((x) => x.id !== a.id))}
          />
        ))}
        <AddAlarmForm onAdd={(a) => setAlarms([...config.alarms, a])} />
        <AlarmsVolumeRow config={config} onUpdate={sendConfig} />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// RingingChip (header item)
// ---------------------------------------------------------------------------

function RingingChip({ host }: { host: ClientHost }) {
  const ringing = useRinging();
  if (ringing.length === 0) return null;
  const head = ringing[0];
  const extra = ringing.length - 1;

  const dismiss = (item: RingingItem) => {
    removeRinging(item.id);
    host.rpc.call("alarms:dismiss", { kind: item.kind, id: item.id });
  };

  return (
    <button
      onClick={() => dismiss(head)}
      title={`Dismiss "${head.label}"`}
      className="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-xs text-[var(--accent)] border border-[var(--border-2)] animate-pulse"
      style={{ background: "color-mix(in srgb, var(--accent) 14%, transparent)" }}
    >
      <BellRing size={14} />
      <span className="truncate max-w-[120px]">{head.label}</span>
      {extra > 0 && <span className="mono opacity-70">+{extra}</span>}
    </button>
  );
}

// ===========================================================================
// POMODORO
// ===========================================================================

// Minimal PomoRunState shape mirrored from shared/types.ts
interface PomoRunState {
  phaseIndex: number;
  running: boolean;
  endTs: number;
  remainingMs: number;
  autoAdvances: number;
}

interface PomodoroConfig {
  sound: string;
  volume: number;
  muted: boolean;
}

const POMODORO_DEFAULT_CONFIG: PomodoroConfig = { sound: "bell", volume: 0.5, muted: false };

function fmtPomo(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function chipColor(running: boolean, phaseIndex: number, low: boolean): string {
  if (!running) return "var(--muted)";
  if (low) return "var(--orange)";
  return phaseIndex === 0 ? "var(--green)" : "var(--accent)";
}

// Pause icon SVG — avoids pulling in lucide-react which isn't an external
const PauseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
  </svg>
);
const PlayIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5,3 19,12 5,21" />
  </svg>
);
const StopIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="4" width="16" height="16" />
  </svg>
);
const SkipIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5,4 15,12 5,20" /><rect x="16" y="4" width="3" height="16" />
  </svg>
);
const PomoTimerIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="13" r="8" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="2" x2="8" y2="2" /><line x1="12" y1="2" x2="16" y2="2" />
  </svg>
);

interface PopoverProps {
  onClose: () => void;
  state: PomoRunState | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onSkip: () => void;
}

function TimerPopover({ onClose: _onClose, state, onStart, onPause, onResume, onStop, onSkip }: PopoverProps) {
  const running = !!state?.running;
  const paused = !!state && !state.running;
  const remaining = state
    ? state.running
      ? Math.max(0, state.endTs - Date.now())
      : state.remainingMs
    : 0;

  const playBtnLabel = running ? "Pause" : paused ? "Resume" : "Start";
  const onPlay = running ? onPause : paused ? onResume : onStart;
  const PlayControlIcon = running ? PauseIcon : PlayIcon;

  return (
    <div
      className="absolute top-full right-0 mt-2 z-50 w-64 rounded-lg border border-[var(--border)] shadow-xl flex flex-col gap-3 p-3 mono text-[11px]"
      style={{ background: "var(--panel)", color: "var(--text)" }}
    >
      <div className="flex items-center gap-2">
        <button
          onClick={onPlay}
          className="flex items-center gap-1.5 px-2 h-7 rounded-md border border-[var(--accent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]"
        >
          <PlayControlIcon />
          <span>{playBtnLabel}</span>
        </button>
        <button
          onClick={onSkip}
          disabled={!running && !paused}
          title="Skip to next phase"
          className="w-7 h-7 grid place-items-center rounded-md border border-[var(--accent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <SkipIcon />
        </button>
        <button
          onClick={onStop}
          disabled={!running && !paused}
          title="Stop"
          className="w-7 h-7 grid place-items-center rounded-md border border-[var(--accent)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <StopIcon />
        </button>
        {(running || paused) && (
          <span className="ml-auto opacity-70 tabular-nums">{fmtPomo(remaining)}</span>
        )}
      </div>
    </div>
  );
}

function Chip({ host }: { host: ClientHost }) {
  const [state, setState] = useState<PomoRunState | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastAutoAdvances = useRef(-1);

  // Seed initial state + subscribe to broadcasts
  useEffect(() => {
    let mounted = true;

    host.rpc.call("pomodoro:getState").then((s: PomoRunState | null) => {
      if (!mounted) return;
      setState(s);
      if (s !== null) lastAutoAdvances.current = s.autoAdvances;
    });

    const off = host.events.on("pomodoro:state", (raw) => {
      const incoming = raw as PomoRunState | null;
      setState(incoming);
      if (incoming !== null && incoming.autoAdvances > lastAutoAdvances.current) {
        const config = getSub<PomodoroConfig>(host, "pomodoro") ?? POMODORO_DEFAULT_CONFIG;
        host.actions.playChime(config.sound, config.muted ? 0 : config.volume);
        lastAutoAdvances.current = incoming.autoAdvances;
      } else if (incoming !== null) {
        lastAutoAdvances.current = incoming.autoAdvances;
      }
    });

    return () => {
      mounted = false;
      off();
    };
  }, []);

  // 1s tick while running
  const [, setTick] = useState(0);
  const running = !!state?.running;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Outside-click + Escape to dismiss
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const remaining = state
    ? state.running
      ? Math.max(0, state.endTs - Date.now())
      : state.remainingMs
    : 0;
  const low = !!state && remaining <= 60_000;
  const color = chipColor(running, state?.phaseIndex ?? 0, low);

  // Phase label glyph: first char of phase label, or fallback
  // We don't have phase labels from run state alone, but we can show phaseIndex-based glyph
  const phaseGlyph = state !== null ? (state.phaseIndex === 0 ? "F" : "B") : "";

  return (
    <div ref={wrapRef} className="relative mono text-[11px] select-none">
      <span
        className="flex items-center gap-1 cursor-pointer hover:bg-[var(--hover)] px-2 py-1 rounded-md"
        style={{ color, background: open ? "var(--hover)" : "transparent" }}
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) => { e.preventDefault(); if (state) host.rpc.call("pomodoro:stop"); }}
      >
        <PomoTimerIcon />
        {state !== null && (
          <>
            <span className="font-semibold">{phaseGlyph}</span>
            {fmtPomo(remaining)}
          </>
        )}
      </span>

      {open && (
        <TimerPopover
          onClose={() => setOpen(false)}
          state={state}
          onStart={() => host.rpc.call("pomodoro:start")}
          onPause={() => host.rpc.call("pomodoro:pause")}
          onResume={() => host.rpc.call("pomodoro:resume")}
          onStop={() => host.rpc.call("pomodoro:stop")}
          onSkip={() => host.rpc.call("pomodoro:skip")}
        />
      )}
    </div>
  );
}

// ===========================================================================
// activate
// ===========================================================================

export default function activate(host: ClientHost): () => void {
  // ---- timers -------------------------------------------------------------
  let timersLastSeq = -1;
  const offTimersFire = host.events.on("timers:fire", (raw) => {
    const payload = raw as { kind: string; id: string; label: string; sound: string; seq: number };
    if (payload.kind !== "timer") return;
    if (payload.seq <= timersLastSeq) return;
    timersLastSeq = payload.seq;
    const config = getSub<TimersConfig>(host, "timers") ?? TIMERS_DEFAULT_CONFIG;
    host.actions.playChime(payload.sound, config.muted ? 0 : config.volume);
    host.actions.notify({ title: "Timer", body: payload.label });
  });
  const offTimersInit = host.events.on("host:init", () => { timersLastSeq = -1; });
  const TimersBound = () => <TimersBox host={host} />;

  // ---- alarms -------------------------------------------------------------
  setRinging([]);
  let alarmsLastSeq = -1;
  const offAlarmsFire = host.events.on("alarms:fire", (raw) => {
    const payload = raw as { kind: string; id: string; label: string; sound: string; seq: number };
    if (payload.kind !== "alarm") return;
    if (payload.seq <= alarmsLastSeq) return;
    alarmsLastSeq = payload.seq;
    const config = getSub<AlarmsModuleConfig>(host, "alarms") ?? ALARMS_DEFAULT_CONFIG;
    host.actions.playChime(payload.sound, config.muted ? 0 : config.volume);
    host.actions.notify({ title: "Alarm", body: payload.label });
    pushRinging({ kind: "alarm", id: payload.id, label: payload.label });
  });
  const offAlarmsInit = host.events.on("host:init", () => { alarmsLastSeq = -1; });
  const AlarmsBound = () => <AlarmsBox host={host} />;
  const ChipBound = () => <RingingChip host={host} />;

  // ---- pomodoro -----------------------------------------------------------
  const PomoBound = () => <Chip host={host} />;

  // ---- chrome -------------------------------------------------------------
  // All of the timer module's UI elements in one batch. The arrays mount two
  // floatingBoxes (timers + alarms) and two headerItems (the ringing-alarm chip
  // and the pomodoro chip); offUI() tears every one of them down.
  const offUI = host.ui.registerUI({
    floatingBox: [
      { id: "timers", component: TimersBound },
      { id: "alarms", component: AlarmsBound },
    ],
    toolsMenuItem: [
      { id: "timers", icon: <TimerIcon size={14} className="text-[var(--muted)]" />, label: "Timers", onClick: () => host.ui.toggleFloatingBox("timers") },
      { id: "alarms", icon: <AlarmClock size={14} className="text-[var(--muted)]" />, label: "Alarms", onClick: () => host.ui.toggleFloatingBox("alarms") },
    ],
    headerItem: [
      { id: "alarms-ringing", component: ChipBound },
      { id: "pomodoro", component: PomoBound },
    ],
  });

  return () => {
    offTimersFire(); offTimersInit();
    offAlarmsFire(); offAlarmsInit();
    offUI();
    setRinging([]);
  };
}
