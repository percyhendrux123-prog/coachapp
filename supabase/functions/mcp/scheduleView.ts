// Byte-for-byte-equivalent Deno twin of three frontend pure functions:
//   src/lib/clientSchedule.js  -> buildForwardSchedule
//   src/lib/consistency.js    -> computeConsistency
//   src/lib/progressTrends.js -> buildProgressTrends
// Edge functions run in a separate bundler and can't import from src/lib
// directly (same reason intake-submit/mealMacros.ts exists as a hand-maintained
// twin of src/lib/mealMacros.js), so this file is kept in sync by hand.
// scheduleView.test.ts replays the identical fixtures the three *.test.js files
// use and asserts identical outputs — that parity test is the drift guard. If
// you change the algorithm in one place, change it the same way in the other.
//
// buildForwardSchedule resolves day order through resolveEffectiveDays
// (_shared/effectiveDays.ts) rather than reading program.structure.days directly —
// this file and clientSchedule.js are both callers of that one invariant, not two
// independent day-order implementations (unlike the rest of this file's twin
// functions, effectiveDays.ts is a real shared import here: both this module and
// _shared/effectiveDays.ts already live in the Deno edge runtime, so there is no
// cross-runtime boundary to hand-copy across for this one piece).
import { resolveEffectiveDays } from "../_shared/effectiveDays.ts";

// ---------- date-only primitives (twin of src/lib/dateOnly.js) ----------
function startOfDay(date: Date | string | number = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function ymd(date: Date | string | number): string {
  const d = new Date(date);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// ---------- forward schedule (twin of src/lib/clientSchedule.js) ----------
export type ProgramDay = { day_id?: string; kind?: string; label?: string | null };
export type ScheduleRow = { due_on: string; cadence: string; status: string };

// Projects `effectiveDays` (day_order-swapped, if the client has adjusted their
// schedule) for the REMAINING slots of the current block, then falls through to
// `programDays` (the coach's own unswapped order) for anything past that boundary.
// closeDayCore resets assignment.day_order to null on every new block — an adjustment lasts exactly
// one block, so a projection that kept applying it into the next cycle would show a
// day sequence that will never actually happen.
function projectDays(effectiveDays: ProgramDay[], programDays: ProgramDay[], currentIndex: number, startDate: Date, count: number) {
  if (!Array.isArray(effectiveDays) || effectiveDays.length === 0) return [];
  const base = startOfDay(startDate);
  const unswapped = Array.isArray(programDays) && programDays.length > 0 ? programDays : effectiveDays;
  const remaining = effectiveDays.length - currentIndex; // slots left before the block boundary
  const out: { date: Date; offset: number; day: ProgramDay }[] = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(base);
    date.setDate(base.getDate() + i);
    const day = i < remaining ? effectiveDays[currentIndex + i] : unswapped[(i - remaining) % unswapped.length];
    out.push({ date, offset: i, day });
  }
  return out;
}

export function buildForwardSchedule({ today, fromDate, toDate, program, assignment, scheduleRows, client }: {
  today: Date; fromDate: Date; toDate: Date;
  program: { structure?: { days?: ProgramDay[] } } | null;
  assignment: { current_day_index?: number; ends_on?: string | null; day_order?: string[] | null } | null;
  scheduleRows: ScheduleRow[];
  client: { show_date?: string | null; show_name?: string | null } | null;
}) {
  // Reordered per assignment.day_order (client schedule adjustments) when set, else
  // the program's own order — see effectiveDays.ts. Both the coach's get_client_schedule
  // and the client's own my_schedule MCP tools call this, so a client who has swapped a
  // day must see that swap reflected here too, not just in the app's own calendar.
  const { days } = resolveEffectiveDays(program as any, assignment as any) as { days: ProgramDay[] };
  const programDays = Array.isArray(program?.structure?.days) ? (program!.structure!.days as ProgramDay[]) : [];
  const count = Math.round((startOfDay(toDate).getTime() - startOfDay(fromDate).getTime()) / 86400000) + 1;

  let planned: { state: string; byDate: Record<string, { kind: string; label: string | null }> } = { state: "not_tracked", byDate: {} };
  if (assignment && days.length > 0) {
    const offset = Math.round((startOfDay(fromDate).getTime() - startOfDay(today).getTime()) / 86400000);
    const byDate: Record<string, { kind: string; label: string | null }> = {};
    for (const { date, day, offset: o } of projectDays(days, programDays, assignment.current_day_index ?? 0, fromDate, count)) {
      if (offset + o < 0) continue;
      byDate[ymd(date)] = { kind: day?.kind ?? "training", label: day?.label ?? null };
    }
    planned = { state: "tracked", byDate };
  }

  const rows = (scheduleRows ?? []).filter((r) => r.status === "scheduled");
  const checkins = rows.length > 0 ? { state: "scheduled", rows } : { state: "not_scheduled", rows: [] as ScheduleRow[] };

  return {
    planned,
    checkins,
    showDate: client?.show_date ?? null,
    showName: client?.show_name ?? null,
    blockEndsOn: assignment?.ends_on ?? null,
  };
}

// ---------- consistency (twin of src/lib/consistency.js) ----------
function weekStartOf(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

export type SessionRow = { session_date: string; status: string; workout_logs?: { done: boolean }[] | null };

// True only when a session actually carries ≥1 done set — see the identical
// hasDoneLog in src/lib/consistency.js for why an existing session isn't enough
// closeDayCore only requires the row to exist.
function hasDoneLog(session: SessionRow): boolean {
  return Array.isArray(session?.workout_logs) && session.workout_logs.some((l) => l?.done);
}

export function computeConsistency({ today, sessions, programDays, assignedAt }: {
  today: Date; sessions: SessionRow[]; programDays: ProgramDay[] | null | undefined; assignedAt: string | null;
}) {
  const trainingDays = Array.isArray(programDays) ? programDays.filter((d) => d?.kind === "training").length : 0;
  if (!Array.isArray(programDays) || programDays.length === 0 || trainingDays === 0) {
    return { state: "not_tracked" as const };
  }
  const weeklyTarget = Math.max(1, Math.round((7 * trainingDays) / programDays.length));

  const todayDate = startOfDay(today);
  const thisWeekStart = weekStartOf(todayDate);
  const assignedDate = assignedAt ? startOfDay(new Date(`${assignedAt}T00:00:00`)) : null;

  const completedByWeek = new Map<string, number>();
  for (const s of sessions ?? []) {
    if (s.status !== "complete" || !hasDoneLog(s)) continue;
    const d = startOfDay(new Date(`${s.session_date}T00:00:00`));
    if (assignedDate && d < assignedDate) continue;
    const key = ymd(weekStartOf(d));
    completedByWeek.set(key, (completedByWeek.get(key) ?? 0) + 1);
  }

  const thisWeekCompleted = completedByWeek.get(ymd(thisWeekStart)) ?? 0;

  const assignedWeekStart = assignedDate ? weekStartOf(assignedDate) : null;
  let streak = 0;
  const cursor = new Date(thisWeekStart);
  cursor.setDate(cursor.getDate() - 7);
  while (!assignedWeekStart || cursor.getTime() >= assignedWeekStart.getTime()) {
    const completed = completedByWeek.get(ymd(cursor)) ?? 0;
    if (completed < weeklyTarget) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 7);
  }
  if (thisWeekCompleted >= weeklyTarget) streak += 1;

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
    state: "tracked" as const,
    weeklyTarget,
    weekStreak: streak,
    thisWeek: { completed: thisWeekCompleted, target: weeklyTarget },
    last28: { completed: last28Completed, target: last28Target },
  };
}

// ---------- progress trends (twin of src/lib/progressTrends.js) ----------
export type WeightRow = { date: string; weight: number | null };
export type CheckinWeightRow = { submitted_at: string; weight: number | null };
export type WorkoutLogRow = { session_id: string; exercise_id: string; weight: number | null; reps: number | null; done: boolean };

export function buildProgressTrends({ weightRows, checkinWeightRows, workoutLogRows, sessionDateById, programExerciseNameById }: {
  weightRows: WeightRow[]; checkinWeightRows: CheckinWeightRow[]; workoutLogRows: WorkoutLogRow[];
  sessionDateById: Record<string, string>; programExerciseNameById: Record<string, string>;
}) {
  const byDate = new Map<string, number>();
  for (const r of checkinWeightRows ?? []) {
    if (r.weight == null) continue;
    byDate.set(ymd(new Date(r.submitted_at)), r.weight);
  }
  for (const r of weightRows ?? []) {
    if (r.weight == null) continue;
    byDate.set(r.date, r.weight);
  }
  const weightPoints = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, value]) => ({ date, value }));

  const bestByExerciseDate = new Map<string, Map<string, { bestWeight: number; reps: number | null }>>();
  const omittedIds = new Set<string>();
  for (const log of workoutLogRows ?? []) {
    if (!log.done || log.weight == null) continue;
    const sessionDate = sessionDateById?.[log.session_id];
    if (!sessionDate) continue;
    if (!(log.exercise_id in (programExerciseNameById ?? {}))) {
      omittedIds.add(log.exercise_id);
      continue;
    }
    if (!bestByExerciseDate.has(log.exercise_id)) bestByExerciseDate.set(log.exercise_id, new Map());
    const perDate = bestByExerciseDate.get(log.exercise_id)!;
    const prev = perDate.get(sessionDate);
    if (!prev || log.weight > prev.bestWeight) {
      perDate.set(sessionDate, { bestWeight: log.weight, reps: log.reps ?? null });
    }
  }

  const series = [...bestByExerciseDate.entries()]
    .map(([exerciseId, perDate]) => {
      const points = [...perDate.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, v]) => ({ date, bestWeight: v.bestWeight, reps: v.reps }));
      return { exerciseId, label: programExerciseNameById[exerciseId], points };
    })
    .filter((s) => s.points.length > 0)
    .sort((a, b) => b.points.length - a.points.length);

  return {
    weight: { state: weightPoints.length > 0 ? "tracked" : "not_tracked", points: weightPoints },
    lifts: {
      state: series.length > 0 || omittedIds.size > 0 ? "tracked" : "not_tracked",
      series,
      omittedEarlierExercises: omittedIds.size,
    },
  };
}

// ---------- checkin schedule regeneration decision (update_client_prep_info) ----------
// Pure decision only — no DB calls here, so it's unit-testable without mocking supabase.
// index.ts's tool body executes the actual cancel + RPC when this returns
// "cancel_and_regenerate". schedule_client_checkins() only INSERTs (ON CONFLICT DO
// NOTHING), so a cadence change without first cancelling the old future rows would
// leave the old and new rhythms interleaved — the cancel step is not optional.
export type CheckinScheduleAction =
  | { kind: "none" }
  | { kind: "cancel_and_regenerate"; clientId: string; todayYmd: string };

export function checkinScheduleActions(patch: Record<string, unknown>, clientId: string, todayYmd: string): CheckinScheduleAction {
  if ("checkin_cadence" in patch || "checkin_day_of_week" in patch) {
    return { kind: "cancel_and_regenerate", clientId, todayYmd };
  }
  return { kind: "none" };
}
