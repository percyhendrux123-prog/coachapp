import { useEffect, useMemo, useState, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { CoachTabs } from "../components/CoachTabs";
import AppGate from "../components/AppGate";
import { getCoachSchedule, projectDays, startOfDay, ymd } from "../lib/schedule";

// Wave 2 #2 — Training calendar. Month grid where past/today cells show ACTUAL
// training sessions (real session_date) and today/future cells show the PLANNED
// day-sequence projected forward. Plus a "Next 7 days" roster schedule. Built
// entirely on existing coach-readable data — no new tables.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function daysBetween(a, b) {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86400000);
}

export default function CoachCalendar() {
  const { user, role } = useAuth();
  const [month, setMonth] = useState(() => { const d = startOfDay(); d.setDate(1); return d; });
  const [data, setData] = useState({ roster: [], sessions: [] });
  const [selected, setSelected] = useState(() => ymd(new Date()));
  const [err, setErr] = useState(null);
  const [loadState, setLoadState] = useState("loading"); // loading | ready | failed

  // The 6-week (42-cell) grid the month renders into, padded to whole weeks.
  const gridStart = useMemo(() => {
    const s = new Date(month);
    s.setDate(1 - s.getDay());
    return startOfDay(s);
  }, [month]);
  const cells = useMemo(
    () => Array.from({ length: 42 }, (_, i) => { const d = new Date(gridStart); d.setDate(gridStart.getDate() + i); return d; }),
    [gridStart],
  );

  const load = useCallback(async () => {
    setLoadState("loading");
    setErr(null);
    try {
      const from = cells[0], to = cells[41];
      setData(await getCoachSchedule({ fromDate: from, toDate: to }));
      setLoadState("ready");
    } catch (e) {
      setErr(e.message);
      setLoadState("failed");
    }
  }, [cells]);
  useEffect(() => { if (role === "coach") load(); }, [role, load]);

  const { roster, sessions } = data;
  const today = useMemo(() => startOfDay(), []);

  // Actual sessions bucketed by date, and a (client → day_id → label) lookup.
  const sessionsByDate = useMemo(() => {
    const m = {};
    for (const s of sessions) (m[s.date] ??= []).push(s);
    return m;
  }, [sessions]);
  const labelFor = useCallback((clientId, dayId) => {
    const r = roster.find((x) => x.clientId === clientId);
    const day = r?.days.find((d) => d.day_id === dayId);
    return day?.label ?? (day?.kind === "rest" ? "Rest" : "Workout");
  }, [roster]);

  // Planned training entries projected onto a given date (today or later).
  const plannedFor = useCallback((date) => {
    const offset = daysBetween(today, date);
    if (offset < 0) return [];
    const out = [];
    for (const r of roster) {
      if (!r.days.length) continue;
      const day = r.days[(r.currentDayIndex + offset) % r.days.length];
      if (day?.kind === "training") out.push({ clientId: r.clientId, displayName: r.displayName, label: day.label ?? "Training" });
    }
    return out;
  }, [roster, today]);

  if (!user) {
    return (
      <AppGate title="Sign in to open calendar" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
        Training calendar and next-week roster live here for coaches.
      </AppGate>
    );
  }
  if (role !== "coach") {
    return (
      <AppGate title="Coach area only" actionTo="/client" actionLabel="Client home" secondaryTo="/" secondaryLabel="Home">
        Calendar is for coaches.
      </AppGate>
    );
  }

  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const selDate = startOfDay(new Date(`${selected}T00:00:00`));
  const selActual = sessionsByDate[selected] ?? [];
  const selPlanned = plannedFor(selDate);

  function shiftMonth(delta) {
    const d = new Date(month); d.setMonth(d.getMonth() + delta); setMonth(startOfDay(d));
  }

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <CoachTabs active="calendar" />
      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <h1 className="display text-3xl">Calendar</h1>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => shiftMonth(-1)} className="btn-ghost px-2.5 py-1">←</button>
          <span className="min-w-[9rem] text-center font-bold">{monthLabel}</span>
          <button onClick={() => shiftMonth(1)} className="btn-ghost px-2.5 py-1">→</button>
        </div>
      </div>
      {loadState === "loading" && (
        <p className="mt-3 text-sm opacity-60">Loading calendar…</p>
      )}
      {loadState === "failed" && (
        <p className="mt-3 rounded-xl border border-dashed border-danger/40 bg-danger/5 px-3 py-3 text-sm text-danger">
          Could not load the calendar — failed read, not an empty schedule. {err}
        </p>
      )}
      {loadState === "ready" && err && <p className="mt-2 text-sm text-danger">{err}</p>}

      <p className="mt-1 text-xs opacity-55">
        Filled dots are completed sessions; hollow dots are planned training from each client's program sequence.
      </p>

      {/* Month grid */}
      <div className="glass mt-4 grid grid-cols-7 overflow-hidden text-sm">
        {WEEKDAYS.map((w) => (
          <div key={w} className="section-title border-b border-ink/10 bg-ink/[0.02] px-2 py-2 text-center">{w}</div>
        ))}
        {cells.map((date) => {
          const key = ymd(date);
          const inMonth = date.getMonth() === month.getMonth();
          const isToday = key === ymd(today);
          const isSel = key === selected;
          const actual = sessionsByDate[key]?.length ?? 0;
          const planned = plannedFor(date).length;
          return (
            <button key={key} onClick={() => setSelected(key)}
              className={`min-h-[64px] border-b border-r border-ink/5 p-1.5 text-left align-top hover:bg-ink/[0.02]
                ${isSel ? "bg-brand/10 ring-1 ring-inset ring-brand" : ""} ${inMonth ? "" : "opacity-35"}`}>
              <div className={`text-xs ${isToday ? "font-bold text-brand-fg" : "opacity-70"}`}>{date.getDate()}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {actual > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">
                    <span className="h-1.5 w-1.5 rounded-full bg-success" />{actual}
                  </span>
                )}
                {planned > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-ink/5 px-1.5 py-0.5 text-[10px] opacity-70">
                    <span className="h-1.5 w-1.5 rounded-full border border-brand" />{planned}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Selected-day detail */}
      <section className="glass mt-5 p-4">
        <h2 className="display text-lg normal-case">
          {selDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
        </h2>
        {selActual.length === 0 && selPlanned.length === 0 && (
          <p className="mt-2 text-sm opacity-55">Nothing on this day.</p>
        )}
        {selActual.length > 0 && (
          <div className="mt-2">
            <p className="section-title">Completed / in progress</p>
            <ul className="mt-1 space-y-1 text-sm">
              {selActual.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${s.status === "complete" ? "bg-success" : "bg-brand"}`} />
                  <span className="font-medium">{s.displayName}</span>
                  <span className="opacity-60">{labelFor(s.clientId, s.dayId)}</span>
                  <span className="text-xs opacity-45">{s.status === "complete" ? "done" : "in progress"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {selPlanned.length > 0 && (
          <div className="mt-3">
            <p className="section-title">Planned training</p>
            <ul className="mt-1 space-y-1 text-sm">
              {selPlanned.map((p) => (
                <li key={p.clientId} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full border border-brand" />
                  <span className="font-medium">{p.displayName}</span>
                  <span className="opacity-60">{p.label}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Next 7 days roster schedule */}
      <RosterWeek roster={roster} today={today} />
    </main>
  );
}

// Per-client view of the next 7 program days — "what's on each client's week."
function RosterWeek({ roster, today }) {
  const cols = Array.from({ length: 7 }, (_, i) => { const d = new Date(today); d.setDate(today.getDate() + i); return d; });
  if (roster.length === 0) return null;
  return (
    <section className="mt-6">
      <h2 className="display text-lg">Next 7 days</h2>
      <div className="glass mt-2 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-ink/10 text-xs opacity-60">
              <th className="px-3 py-2 text-left font-medium">Client</th>
              {cols.map((d, i) => (
                <th key={i} className={`px-2 py-2 text-center font-medium ${i === 0 ? "text-brand-fg" : ""}`}>
                  {WEEKDAYS[d.getDay()]}<br /><span className="opacity-60">{d.getDate()}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roster.map((r) => {
              const week = projectDays(r.days, r.programDays, r.currentDayIndex, today, 7);
              return (
                <tr key={r.assignmentId} className="border-b border-ink/5 last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.displayName}</div>
                    <div className="text-xs opacity-50">{r.programName}</div>
                  </td>
                  {week.map(({ day }, i) => {
                    const training = day?.kind === "training";
                    return (
                      <td key={i} className={`px-2 py-2 text-center ${i === 0 ? "bg-brand/5" : ""}`}>
                        {training
                          ? <span className="inline-block max-w-[84px] truncate rounded-md bg-brand/10 px-1.5 py-0.5 text-[11px] text-brand-fg" title={day?.label}>{day?.label ?? "Training"}</span>
                          : <span className="text-[11px] opacity-40">Rest</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}


