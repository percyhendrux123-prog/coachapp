import { useEffect, useState, useRef } from "react";
import { participantApi } from "../lib/participant";
import { currentDayLog, formatUnlock, runIsDone, saveDay, tryAdvance } from "../lib/challengeRunFlow";

// A participant's live run. Two separate moments, because the server's 20-hour gate is
// measured from the most recent log (see challengeRunFlow.js):
//   • "Save Day N"  → writes today's log; the day stays open-but-locked until the gate
//                     passes, and the unlock time comes from the server's reply.
//   • next visit    → if today has a log, the client asks the server to close it, and
//                     the run moves on. An unlogged day is never closed from here.
// The server alone sets status / perfect_week / rewarded; this view only reads them.
export default function ChallengeRun({ challenge, standards, run, onRunChange, api = participantApi }) {
  const [logs, setLogs] = useState(null);          // null = loading
  const [logsFailed, setLogsFailed] = useState(false);
  const [checked, setChecked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [lockedUntil, setLockedUntil] = useState(null);
  const [reload, setReload] = useState(0);
  const advancing = useRef(null);                  // one close attempt in flight per run+day

  const day = run.current_day_index;
  const done = runIsDone(run);
  const isFinal = day >= challenge.duration_days;

  useEffect(() => {
    let active = true;
    (async () => {
      setLogsFailed(false); setLogs(null); setErr(null); setLockedUntil(null);
      let l;
      try { l = await api.getDayLogs(run.id); } catch { if (active) setLogsFailed(true); return; }
      if (!active) return;
      setLogs(l);
      setChecked(new Set(currentDayLog(l, day)?.standards_hit ?? []));
      if (done) return;
      // React StrictMode runs this effect twice in development: both instances share
      // one server call so a day can never be closed twice.
      if (!advancing.current) {
        advancing.current = tryAdvance({ api, runId: run.id, day, logs: l })
          .finally(() => { advancing.current = null; });
      }
      try {
        const out = await advancing.current;
        if (!active) return;
        if (out.advanced) await onRunChange();
        else setLockedUntil(out.lockedUntil);
      } catch (e) { if (active) setErr(e.message); }
    })();
    return () => { active = false; };
  }, [api, run.id, day, done, reload, onRunChange]);

  if (logsFailed) {
    return (
      <div className="mt-6 rounded-xl border border-dashed border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">
        <p>Could not load your week — failed read, not an empty week.</p>
        <button type="button" onClick={() => setReload((n) => n + 1)} className="btn-ghost mt-3 min-h-[44px] px-4">Try again</button>
      </div>
    );
  }
  if (logs === null) return <p className="mt-6 text-sm opacity-60">Loading your week…</p>;
  if (done) return <Result challenge={challenge} run={run} logs={logs} />;

  const todayLog = currentDayLog(logs, day);
  const metByDay = new Map(logs.map((l) => [l.day_index, l.all_standards_met]));
  const unlock = formatUnlock(lockedUntil);

  function toggle(id) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function save() {
    setErr(null); setBusy(true);
    try {
      const out = await saveDay({ api, runId: run.id, day, standardsHit: [...checked] });
      if (out.advanced) { await onRunChange(); return; }
      const row = out.saved?.day_log;
      if (row) setLogs((prev) => [...(prev || []).filter((l) => l.day_index !== row.day_index), row].sort((a, b) => a.day_index - b.day_index));
      setLockedUntil(out.lockedUntil);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <Progress duration={challenge.duration_days} current={day} metByDay={metByDay} />
      <h2 className="mt-6 text-xl font-semibold">Day {day} of {challenge.duration_days}</h2>
      <p className="mt-1 text-sm opacity-60">Check off every standard you hit today. All {challenge.num_standards} = a perfect day.</p>

      {todayLog && (
        <div className="glass mt-4 border border-success/25 p-4 text-sm">
          <p className="font-semibold text-success">Day {day} is logged.</p>
          <p className="mt-1 opacity-80">
            {isFinal ? "Your result is ready" : `Day ${day + 1} opens`}
            {unlock ? ` at ${unlock}.` : " once 20 hours have passed since this log."}
            {" "}Open the app then.
          </p>
          <p className="mt-1 text-xs opacity-60">Changed your mind about today? Update below — that restarts the 20 hours.</p>
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {standards.map((s) => (
          <li key={s.id}>
            <label className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border border-ink/10 p-3">
              <input type="checkbox" checked={checked.has(s.id)} onChange={() => toggle(s.id)} className="mt-1 h-5 w-5" />
              <span>
                <span className="font-medium">{s.title}</span>
                {s.description && <span className="block text-xs opacity-60">{s.description}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>

      {err && <p className="mt-3 text-sm text-danger">{err}</p>}
      <button
        type="button"
        onClick={save}
        disabled={busy}
        className="btn-primary mt-5 min-h-[44px] w-full py-3 disabled:opacity-50"
      >
        {busy ? "Saving…" : todayLog ? `Update Day ${day}` : `Save Day ${day}`}
      </button>
      <p className="mt-2 text-center text-xs opacity-50">{checked.size} of {challenge.num_standards} standards checked</p>
    </div>
  );
}

// One bar per day. Four truths, four looks: met (solid success), missed (solid danger —
// a real zero), unlogged past day (dashed outline — unmeasured, not a miss), and future.
function Progress({ duration, current, metByDay }) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: duration }, (_, i) => i + 1).map((d) => {
        const state = metByDay.has(d) ? (metByDay.get(d) ? "met" : "miss")
          : d === current ? "current" : d < current ? "unlogged" : "future";
        const cls = {
          met: "bg-success", miss: "bg-danger", current: "bg-ink",
          unlogged: "border border-dashed border-ink/40", future: "bg-ink/10",
        }[state];
        const label = { met: "met", miss: "missed", current: "today", unlogged: "not logged", future: "upcoming" }[state];
        return <div key={d} className={`h-2 flex-1 rounded-full ${cls}`} title={`Day ${d}: ${label}`} />;
      })}
    </div>
  );
}

function Result({ challenge, run, logs }) {
  const daysMet = logs.filter((l) => l.all_standards_met).length;
  const daysLogged = logs.length;
  const daysUnlogged = challenge.duration_days - daysLogged;

  if (run.perfect_week) {
    const rewarded = run.status === "rewarded";
    return (
      <div className="text-center">
        <p className="kicker">Result</p>
        <h2 className="display mt-2 text-3xl sm:text-4xl">{rewarded ? "Perfect week." : "Perfect week recorded."}</h2>
        <p className="mt-3 text-sm opacity-70">
          You hit all {challenge.num_standards} standards, all {challenge.duration_days} days.
        </p>
        {rewarded ? (
          <div className="glass mt-6 border border-success/25 p-5 text-left">
            <p className="font-semibold text-success">You&apos;ve earned a free month of Standard coaching.</p>
            <p className="mt-1 text-sm text-success/80">We&apos;ll set you up — your reward is unlocked.</p>
          </div>
        ) : (
          <p className="mt-4 text-sm opacity-60">Your coach has your completed result.</p>
        )}
      </div>
    );
  }

  if (run.status === "incomplete") {
    return (
      <div className="text-center">
        <p className="kicker">Result</p>
        <h2 className="display mt-2 text-3xl">Challenge incomplete.</h2>
        <p className="mt-3 text-sm opacity-70">
          You logged {daysLogged} of {challenge.duration_days} days.
          {daysUnlogged > 0 && ` ${daysUnlogged} day${daysUnlogged === 1 ? "" : "s"} went unlogged — not a failure, just unmeasured.`}
        </p>
        <p className="mt-4 text-sm opacity-60">A missing log isn&apos;t evidence you didn&apos;t do the work. The door is still open.</p>
      </div>
    );
  }

  return (
    <div className="text-center">
      <p className="kicker">Result</p>
      <h2 className="display mt-2 text-3xl">Challenge complete.</h2>
      <p className="mt-3 text-sm opacity-70">
        You logged all {daysLogged} days — hit every standard on {daysMet} of them.
      </p>
      <p className="mt-4 text-sm opacity-60">Not a perfect week this time — the door to coaching is still open.</p>
    </div>
  );
}
