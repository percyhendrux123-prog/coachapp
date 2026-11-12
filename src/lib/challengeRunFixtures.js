// ============================================================================
// SYNTHETIC CHALLENGE SERVER — tests and fixture-preview only. Never live data.
//
// An in-memory stand-in for the three challenge edge functions, reproducing their
// rules line for line so the participant flow can be proven without Supabase:
//
//   challenge-enroll     idempotent on (challenge, participant); a new run starts
//                        active on day 1.
//   challenge-log        only the run's current day may be logged; hits are
//                        de-duplicated against the challenge's standards;
//                        all_standards_met = distinct valid hits >= num_standards;
//                        logged_at is set to "now" on every upsert.
//   challenge-day-close  the 20-hour gate is measured from the MOST RECENT log
//                        (429 "too soon" with next_allowed_at); terminal runs return
//                        already_closed; a non-final day simply advances; the final
//                        day tallies REAL logs only — perfect_week when every day is
//                        all_standards_met, incomplete when any day has no log,
//                        completed otherwise. A perfect week settles to `rewarded`
//                        the way the OWNER tenant does. No Stripe call exists here,
//                        matching the server since 2026-08-24.
//
// Errors are thrown in the shape src/lib/participant.js produces from a function's
// JSON error body (message = error, plus status / detail / next_allowed_at).
// Every id and name below is fictional.
// ============================================================================
import { functionError } from "./challengeRunFlow.js";

export const HOUR_MS = 60 * 60 * 1000;
export const GATE_MS = 20 * HOUR_MS;

export const SYNTHETIC_STANDARDS = [
  { id: "synthetic-std-1", ordinal: 1, title: "Hit your protein target", description: "Eat your assigned protein for the day." },
  { id: "synthetic-std-2", ordinal: 2, title: "Move 10,000 steps", description: "Accumulate 10k steps." },
  { id: "synthetic-std-3", ordinal: 3, title: "Complete your training", description: "Finish the day's training session (or an intentional rest day)." },
  { id: "synthetic-std-4", ordinal: 4, title: "Sleep 7+ hours", description: "Get at least seven hours." },
  { id: "synthetic-std-5", ordinal: 5, title: "Log your day", description: "Check in — mark your standards before bed." },
];

export function createSyntheticChallenge({ startAt = Date.now(), participantId = "synthetic-participant" } = {}) {
  let now = startAt;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const challenge = {
    id: "synthetic-challenge", slug: "standard-7",
    title: "7-Day Challenge",
    subtitle: "Five standards. Seven days. Prove it to yourself.",
    description: "Hit all five daily standards for seven straight days. A perfect week earns a free month of Standard coaching.",
    duration_days: 7, num_standards: 5, reward_type: "free_month_standard", status: "published",
  };
  const standards = SYNTHETIC_STANDARDS.map((s) => ({ ...s }));
  const state = { run: null, logs: [], stripeCalls: 0, notifications: [] };
  const calls = { enroll: 0, logDay: 0, closeDay: 0, getDayLogs: 0, getMyRun: 0 };
  const iso = () => new Date(now).toISOString();
  const validIds = new Set(standards.map((s) => s.id));

  function ownedRun(runId) {
    if (!state.run || state.run.id !== runId) throw functionError("run not found", { status: 404 });
    return state.run;
  }

  const api = {
    async enroll(challengeId) {
      calls.enroll++;
      if (challengeId !== challenge.id) throw functionError("challenge not found", { status: 404 });
      if (challenge.status !== "published") throw functionError("challenge is not open for enrollment", { status: 409 });
      if (state.run) return { run_id: state.run.id, status: state.run.status, already_enrolled: true };
      state.run = {
        id: "synthetic-run", participant_user_id: participantId, status: "active", current_day_index: 1,
        perfect_week: false, reward_granted_at: null, started_at: iso(), completed_at: null,
      };
      return { run_id: state.run.id, status: "active" };
    },
    async getMyRun(challengeId) {
      calls.getMyRun++;
      if (challengeId !== challenge.id || !state.run) return null;
      return { ...state.run };
    },
    async getDayLogs(runId) {
      calls.getDayLogs++;
      return state.logs.filter((l) => l.run_id === runId).map(({ day_index, standards_hit, all_standards_met }) =>
        ({ day_index, standards_hit: [...standards_hit], all_standards_met })).sort((a, b) => a.day_index - b.day_index);
    },
    async logDay(runId, dayIndex, standardsHit) {
      calls.logDay++;
      const run = ownedRun(runId);
      if (!Number.isInteger(dayIndex)) throw functionError("run_id and integer day_index required", { status: 400 });
      if (!Array.isArray(standardsHit)) throw functionError("standards_hit must be an array", { status: 400 });
      if (dayIndex < 1 || dayIndex > challenge.duration_days)
        throw functionError(`day_index out of range 1..${challenge.duration_days}`, { status: 400 });
      if (dayIndex !== run.current_day_index)
        throw functionError(`can only log the current day (${run.current_day_index})`, { status: 409 });
      const clean = [...new Set(standardsHit.filter((id) => validIds.has(id)))];
      const allMet = clean.length >= challenge.num_standards;
      const row = { run_id: runId, day_index: dayIndex, standards_hit: clean, all_standards_met: allMet, logged_at: iso() };
      const at = state.logs.findIndex((l) => l.run_id === runId && l.day_index === dayIndex);
      if (at >= 0) state.logs[at] = row; else state.logs.push(row);
      return { day_log: { ...row }, all_standards_met: allMet, standards_required: challenge.num_standards };
    },
    async closeDay(runId) {
      calls.closeDay++;
      const run = ownedRun(runId);
      const last = state.logs.filter((l) => l.run_id === runId)
        .sort((a, b) => Date.parse(b.logged_at) - Date.parse(a.logged_at))[0];
      if (last) {
        const elapsed = now - Date.parse(last.logged_at);
        if (elapsed < GATE_MS) {
          const waitMinutes = Math.ceil((GATE_MS - elapsed) / 60000);
          throw functionError("too soon", {
            status: 429,
            detail: `20 hours must pass between day advances. ${waitMinutes} minute(s) remaining.`,
            last_log_at: last.logged_at,
            next_allowed_at: new Date(Date.parse(last.logged_at) + GATE_MS).toISOString(),
          });
        }
      }
      if (["completed", "rewarded", "incomplete"].includes(run.status))
        return { run_id: runId, status: run.status, already_closed: true };
      const day = run.current_day_index;
      if (day < challenge.duration_days) {
        run.current_day_index = day + 1; run.status = "active";
        return { run_id: runId, closed_day: day, next_day: day + 1, completed: false };
      }
      const logs = state.logs.filter((l) => l.run_id === runId);
      const loggedDays = new Set(logs.map((l) => l.day_index));
      const metDays = new Set(logs.filter((l) => l.all_standards_met).map((l) => l.day_index));
      const unlogged = challenge.duration_days - loggedDays.size;
      const perfect = metDays.size >= challenge.duration_days;
      const finalStatus = perfect ? "perfect_week" : unlogged > 0 ? "incomplete" : "completed";
      Object.assign(run, { current_day_index: day + 1, completed_at: iso(), status: finalStatus, perfect_week: perfect });
      if (perfect) {
        run.reward_granted_at = iso();
        // settleReward for the OWNER tenant: roster link + a recorded notification. No Stripe.
        run.status = "rewarded"; run.client_id = "synthetic-client";
        state.notifications.push({ template: "challenge_reward_earned", status: "recorded", run_id: runId });
      }
      return {
        run_id: runId, closed_day: day, completed: true, perfect_week: perfect, status: run.status,
        days_met: metDays.size, days_logged: loggedDays.size, days_required: challenge.duration_days,
        ...(unlogged > 0 ? { days_unlogged: unlogged } : {}),
        reward: perfect ? challenge.reward_type : null,
      };
    },
  };

  return { challenge, standards, state, calls, clock, api };
}
