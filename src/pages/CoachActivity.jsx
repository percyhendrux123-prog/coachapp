import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { CoachTabs } from "../components/CoachTabs";
import AppGate from "../components/AppGate";
import { listActivityWithTraining } from "../lib/activity";

export default function CoachActivity() {
  const { user, role } = useAuth();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [trainingGap, setTrainingGap] = useState(false);

  const load = useCallback(() => {
    listActivityWithTraining({ limit: 80 })
      .then(({ rows: r, trainingFeedError }) => { setRows(r); setTrainingGap(trainingFeedError); setErr(null); })
      .catch((e) => { setErr(e.message); setRows(null); });
  }, []);
  useEffect(() => { if (role === "coach") load(); }, [role, load]);

  // Refetch when the tab comes back into view — found 2026-08-31: this ledger
  // only loaded on mount, so a coach returning to an already-open tab read a
  // feed frozen at whenever they first opened it. The Refresh button stays as
  // the explicit control; this just stops the page from silently going stale.
  useEffect(() => {
    if (role !== "coach") return undefined;
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [role, load]);

  if (!user) {
    return (
      <AppGate title="Sign in to view activity" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
        The in-app activity ledger lives here for coaches.
      </AppGate>
    );
  }
  if (role !== "coach") {
    return (
      <AppGate title="Coach area only" actionTo="/client" actionLabel="Client home" secondaryTo="/" secondaryLabel="Home">
        Activity is for coaches.
      </AppGate>
    );
  }

  return (
    // Shell width follows the same list-page tier as Inbox/Calendar (max-w-5xl) --
    // Activity is a scanning ledger, not a narrow form like Settings/About.
    <main className="mx-auto max-w-5xl px-5 py-10">
      <CoachTabs active="activity" />
      <header className="mt-6 flex items-end justify-between gap-3">
        <div>
          <span className="kicker">In-app ledger</span>
          <h1 className="display mt-1 text-3xl">Activity</h1>
          <p className="mt-2 max-w-[54ch] text-sm opacity-60">
            Things the app recorded. No email, SMS, or push is sent from this feed.
          </p>
        </div>
        <button type="button" onClick={load} className="btn-ghost">Refresh</button>
      </header>
      {err && <p className="mt-3 rounded-xl border border-danger/25 bg-danger/5 p-3 text-sm text-danger">{err}</p>}
      {trainingGap && (
        <p className="mt-3 rounded-xl border border-dashed border-danger/30 bg-danger/5 p-3 text-sm">
          Training events could not be loaded — this list is missing them, not empty of them.
        </p>
      )}
      <ActivityList rows={rows} coach error={err} />
    </main>
  );
}

export function ActivityList({ rows, coach = false, error = null }) {
  // Three states, matching CoachHome.jsx Decisions (line 509-510):
  //   undefined/null = still loading, null + error = read failed, [] = genuinely empty.
  if (rows == null && !error) return <p className="mt-6 text-sm opacity-60">Reading activity...</p>;
  if (error && rows == null) {
    return (
      <div className="mt-6 rounded-xl border border-dashed border-danger/30 bg-danger/5 p-6 text-center text-sm">
        <p className="text-danger">Could not read activity.</p>
        <p className="mt-1 opacity-60">The feed may be unavailable — try refreshing. This is not a count of zero.</p>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="mt-6 rounded-xl border border-dashed border-ink/15 p-6 text-center text-sm opacity-60">
        No in-app activity has been recorded yet.
      </div>
    );
  }
  return (
    <ul className="glass mt-6 divide-y divide-ink/10 overflow-hidden">
      {rows.map((row) => (
        <li key={row.id} className="flex gap-3 p-4 text-sm">
          <time className="w-24 shrink-0 text-xs opacity-50">{timeLabel(row.at)}</time>
          <div className="min-w-0">
            <div>
              {coach && <b>{row.clientName} </b>}
              <span className="opacity-75">{row.label}</span>
            </div>
            {row.detail?.summary && <p className="mt-1 text-xs opacity-55">{row.detail.summary}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function timeLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}


