// ============================================================================
// Participant daily flow for a challenge run — pure logic, no React, no Supabase.
//
// The server contract (challenge-log + challenge-day-close) is: a day is logged with
// challenge-log, and challenge-day-close advances the run only when 20 hours have
// passed since the MOST RECENT log. So "log, then close" in one press can never
// succeed — the close is always measured against the log that was just written.
// The flow therefore has two separate moments:
//
//   saveDay     writes today's log, then asks the server to close. The expected
//               answer right after a log is 429 "too soon", which is not an error
//               for the participant: the day is saved and locked until
//               next_allowed_at. Any other failure is surfaced.
//   tryAdvance  on the next visit: if the current day has a log, ask the server to
//               close it. Never closes an unlogged day — whether a skipped day ends
//               a run `incomplete` is the server's decision (G4), never the client's.
//
// The server remains the only writer of status / perfect_week / rewarded.
// ============================================================================

export const DONE_STATUSES = ["completed", "perfect_week", "rewarded", "incomplete", "abandoned"];

export function runIsDone(run) {
  return DONE_STATUSES.includes(run?.status);
}

// Error shape for a function's JSON error body: message = body.error, plus the
// body's other fields (status, detail, next_allowed_at, last_log_at).
export function functionError(message, extra = {}) {
  const err = new Error(message);
  Object.assign(err, extra);
  return err;
}

export function isTooSoon(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  return /^too soon$/i.test(String(err.message || "").trim());
}

export function currentDayLog(logs, day) {
  return (logs || []).find((l) => l.day_index === day) ?? null;
}

// Ask the server to close the current day. A 429 is a lock, not a failure.
export async function attemptClose(api, runId) {
  try {
    const close = await api.closeDay(runId);
    return { advanced: true, lockedUntil: null, close };
  } catch (e) {
    if (isTooSoon(e)) return { advanced: false, lockedUntil: e.next_allowed_at ?? null, close: null };
    throw e;
  }
}

export async function saveDay({ api, runId, day, standardsHit }) {
  const saved = await api.logDay(runId, day, standardsHit);
  const closed = await attemptClose(api, runId);
  return { saved, ...closed };
}

export async function tryAdvance({ api, runId, day, logs }) {
  if (!currentDayLog(logs, day)) return { advanced: false, lockedUntil: null, skipped: "unlogged" };
  return attemptClose(api, runId);
}

// "5:42 PM today" / "5:42 PM tomorrow" / "5:42 PM Tue 22 Sep" — for the lock line.
export function formatUnlock(iso, now = Date.now()) {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dayOf = (d) => new Date(d).toDateString();
  if (dayOf(at) === dayOf(now)) return `${time} today`;
  if (dayOf(at) === dayOf(now + 24 * 60 * 60 * 1000)) return `${time} tomorrow`;
  return `${time} ${at.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`;
}
