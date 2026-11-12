// Promises-kept consistency: consecutive weeks where a client met their program's
// training-day target. Not a daily streak — a client with a 4-day/week program isn't
// punished for the 3 rest days. Locked here so the client calendar, the coach's MCP
// twin (supabase/functions/mcp/scheduleView.ts), and get_client_progress all report
// the identical number for the identical client. See dateOnly.js's header for why
// this file doesn't statically import schedule.js or supabase.js.
import { startOfDay, ymd } from "./dateOnly.js";

function weekStartOf(date) {
  const d = startOfDay(date);
  d.setDate(d.getDate() - d.getDay()); // getDay(): 0 = Sunday
  return d;
}

// True only when a session actually carries ≥1 done set. A session can be
// status:"complete" purely because the client tapped Finish — closeDayCore only
// requires the session to exist, not that anything was logged against it (finding
// B2.1). Counting an empty completion here would inflate the accountability number
// a coach reads off get_client_progress with training that never happened — a
// silently-invented signal, not a soft one.
function hasDoneLog(session) {
  return Array.isArray(session?.workout_logs) && session.workout_logs.some((l) => l?.done);
}

// Pure, exported for tests. sessions: [{session_date, status, workout_logs}] — each
// session's workout_logs is the same nested embed the app already fetches elsewhere
// (e.g. src/lib/workouts.js listHistory), just [{done}] shaped down to what this
// function needs. programDays: the current program's structure.days array.
// assignedAt: the active assignment's assigned_at (ISO date string) or null —
// sessions before it never count toward or against the client, since they belong to
// a prior program.
export function computeConsistency({ today, sessions, programDays, assignedAt }) {
  const trainingDays = Array.isArray(programDays) ? programDays.filter((d) => d?.kind === "training").length : 0;
  if (!Array.isArray(programDays) || programDays.length === 0 || trainingDays === 0) {
    // No program, or an all-rest program (structurally has no target) — this is a
    // system "never instrumented" state, not a zero. Twin-facts rule: never render
    // this like "0 weeks at standard."
    return { state: "not_tracked" };
  }
  const weeklyTarget = Math.max(1, Math.round((7 * trainingDays) / programDays.length));

  const todayDate = startOfDay(today);
  const thisWeekStart = weekStartOf(todayDate);
  const assignedDate = assignedAt ? startOfDay(new Date(`${assignedAt}T00:00:00`)) : null;

  const completedByWeek = new Map();
  for (const s of sessions ?? []) {
    if (s.status !== "complete" || !hasDoneLog(s)) continue;
    const d = startOfDay(new Date(`${s.session_date}T00:00:00`));
    if (assignedDate && d < assignedDate) continue; // before this program — never counted
    const key = ymd(weekStartOf(d));
    completedByWeek.set(key, (completedByWeek.get(key) ?? 0) + 1);
  }

  const thisWeekCompleted = completedByWeek.get(ymd(thisWeekStart)) ?? 0;

  // Walk backward one fully-elapsed week at a time. Stop (without breaking the
  // streak) at the week the program was assigned — a week before assignment was
  // never the client's to keep or miss, so running out of history there caps the
  // streak instead of zeroing it.
  const assignedWeekStart = assignedDate ? weekStartOf(assignedDate) : null;
  let streak = 0;
  const cursor = new Date(thisWeekStart);
  cursor.setDate(cursor.getDate() - 7);
  while (!assignedWeekStart || cursor.getTime() >= assignedWeekStart.getTime()) {
    const completed = completedByWeek.get(ymd(cursor)) ?? 0;
    if (completed < weeklyTarget) break; // a real miss — breaks the streak, not softened
    streak += 1;
    cursor.setDate(cursor.getDate() - 7);
  }
  if (thisWeekCompleted >= weeklyTarget) streak += 1; // partial current week already at standard

  // Last 28 days (or fewer, if the program started more recently / more recently
  // than 28 days ago) — completed vs. a pro-rated target so a brand-new client
  // doesn't show a misleadingly low fraction against a full 28-day target.
  const windowStart = new Date(todayDate);
  windowStart.setDate(windowStart.getDate() - 27);
  const effectiveStart = assignedDate && assignedDate > windowStart ? assignedDate : windowStart;
  const daysCovered = Math.round((todayDate.getTime() - effectiveStart.getTime()) / 86400000) + 1;
  let last28Completed = 0;
  for (const s of sessions ?? []) {
    if (s.status !== "complete" || !hasDoneLog(s)) continue;
    const d = startOfDay(new Date(`${s.session_date}T00:00:00`));
    if (d < effectiveStart || d > todayDate) continue;
    last28Completed += 1;
  }
  const last28Target = Math.max(1, Math.round((weeklyTarget / 7) * daysCovered));

  return {
    state: "tracked",
    weeklyTarget,
    weekStreak: streak,
    thisWeek: { completed: thisWeekCompleted, target: weeklyTarget },
    last28: { completed: last28Completed, target: last28Target },
  };
}

// Fetch + compute. Dynamic imports (see dateOnly.js header) keep this importable
// under plain node --test without pulling in supabase.js's Vite-only env access.
export async function getMyConsistency() {
  const { getMyProgram } = await import("./client.js");
  const { supabase } = await import("./supabase.js");
  const prog = await getMyProgram();
  const programDays = Array.isArray(prog?.program?.structure?.days) ? prog.program.structure.days : [];
  const assignedAt = prog?.assignment?.assigned_at ?? null;

  const query = supabase.from("workout_sessions").select("session_date, status, workout_logs(done)");
  const { data, error } = assignedAt
    ? await query.gte("session_date", assignedAt.slice(0, 10))
    : await query;
  if (error) throw error;

  return computeConsistency({ today: startOfDay(), sessions: data ?? [], programDays, assignedAt });
}
