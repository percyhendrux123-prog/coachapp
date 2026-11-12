// Pure merge for the coach Activity ledger page. The notification_log (channel in_app) is
// a ledger that training events are never written to — while the Home cockpit's
// activity block queries workout_sessions/workout_logs live. The two surfaces
// told different stories, and the page's Refresh button re-read a book the
// missing events are never written into, which made a working button look dead.
//
// Fix is read-side only: merge live training events into the page's feed. The
// ledger keeps carrying what it always carried (check-ins, messages, archives,
// program changes — written via recordActivity); training comes from the live
// tables. No write path changes: writing per-set ledger rows would double-record
// what workout_logs already is.
//
// Training events are aggregated PER SESSION, not per set — a 17-set workout is
// one line here ("completed a session — 17 sets"), matching the cockpit's
// session line, not 17 lines that would drown the rest of the ledger. A session
// still in progress with logged sets shows as "logging a workout — N sets so
// far" timestamped at its latest set.
//
// Pure and supabase-free so it's testable under plain `node --test` (activity.js
// imports supabase.js at module top-level and can't be, same constraint as
// schedule.js — see clientSchedule.js's header).

// sessionRows: [{id, status, completed_at, clients: {display_name},
//   workout_logs: [{done, logged_at}]}] — the shape listActivity's training
// query fetches. Returns rows in the ledger page's own shape.
export function trainingEventsFromSessions(sessionRows) {
  const out = [];
  for (const s of sessionRows ?? []) {
    const logs = Array.isArray(s.workout_logs) ? s.workout_logs : [];
    const doneCount = logs.filter((l) => l?.done).length;
    const name = s.clients?.display_name ?? "Client";
    if (s.status === "complete" && s.completed_at) {
      out.push({
        id: `ws-complete:${s.id}`,
        at: s.completed_at,
        clientName: name,
        // Same twin-facts split the calendar and Recent-finishes got: a finish
        // with nothing done reads differently from a real one.
        label: doneCount > 0 ? `completed a session — ${doneCount} ${doneCount === 1 ? "set" : "sets"}` : "finished a session — no sets marked done",
        detail: {},
      });
    } else if (doneCount > 0) {
      const latest = logs.reduce((m, l) => (l?.logged_at && (!m || l.logged_at > m) ? l.logged_at : m), null);
      if (latest) {
        out.push({
          id: `ws-logging:${s.id}`,
          at: latest,
          clientName: name,
          label: `logging a workout — ${doneCount} ${doneCount === 1 ? "set" : "sets"} so far`,
          detail: {},
        });
      }
    }
  }
  return out;
}

// Merge ledger rows and training rows into one feed, newest first, capped.
export function mergeActivityFeeds(ledgerRows, trainingRows, { limit = 80 } = {}) {
  return [...(ledgerRows ?? []), ...(trainingRows ?? [])]
    .filter((r) => r?.at)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}
