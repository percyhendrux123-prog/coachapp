// Client progress trends: weight over time, and best-set strength over time per
// current-program exercise. The code that saves a check-in's weight into
// progress_weights (src/lib/client.js) already calls it "your trend chart" in a
// comment — this is that chart, finally built. See dateOnly.js's header for why
// this file avoids statically importing schedule.js/client.js/supabase.js.
import { ymd } from "./dateOnly.js";

// Pure, exported for tests.
// weightRows: [{date, weight}] from progress_weights (canonical, kg).
// checkinWeightRows: [{submitted_at, weight}] from checkins — legacy fallback for a
//   weigh-in that predates progress_weights being written, or a same-day insert that
//   failed (client.js's submitCheckin logs that failure but doesn't retry it).
// workoutLogRows: [{session_id, exercise_id, weight, reps, done}] from workout_logs.
// sessionDateById: {session_id: session_date} from workout_sessions.
// programExerciseNameById: {exercise_id: label} from the CURRENT program's structure
//   only — an exercise_id logged under a since-changed or since-retired program has
//   no entry here, and is deliberately excluded from series (not misattributed to a
//   label it no longer has), while still being counted in omittedEarlierExercises.
export function buildProgressTrends({ weightRows, checkinWeightRows, workoutLogRows, sessionDateById, programExerciseNameById }) {
  // --- Weight ---
  const byDate = new Map();
  for (const r of checkinWeightRows ?? []) {
    if (r.weight == null) continue;
    byDate.set(ymd(new Date(r.submitted_at)), r.weight);
  }
  for (const r of weightRows ?? []) {
    if (r.weight == null) continue;
    byDate.set(r.date, r.weight); // progress_weights always wins on a shared date
  }
  const weightPoints = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, value]) => ({ date, value }));

  // --- Lifts ---
  // exercise_id -> Map(session_date -> best {weight, reps} seen for that date)
  const bestByExerciseDate = new Map();
  const omittedIds = new Set();
  for (const log of workoutLogRows ?? []) {
    if (!log.done || log.weight == null) continue; // not done, or a cardio-shaped row
    const sessionDate = sessionDateById?.[log.session_id];
    if (!sessionDate) continue; // orphaned log with no matching session — cannot date-stamp it
    if (!(log.exercise_id in (programExerciseNameById ?? {}))) {
      omittedIds.add(log.exercise_id);
      continue;
    }
    if (!bestByExerciseDate.has(log.exercise_id)) bestByExerciseDate.set(log.exercise_id, new Map());
    const perDate = bestByExerciseDate.get(log.exercise_id);
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
    .filter((s) => s.points.length > 0) // e.g. an exercise whose only logs were all cardio-shaped
    .sort((a, b) => b.points.length - a.points.length); // most-logged first, so the UI can slice(0, 6)

  return {
    weight: { state: weightPoints.length > 0 ? "tracked" : "not_tracked", points: weightPoints },
    lifts: {
      state: series.length > 0 || omittedIds.size > 0 ? "tracked" : "not_tracked",
      series,
      omittedEarlierExercises: omittedIds.size,
    },
  };
}

// Fetch + compute. Dynamic imports (see dateOnly.js header) keep this importable
// under plain node --test without pulling in supabase.js's Vite-only env access.
export async function getMyProgressTrends() {
  const [{ supabase }, { getMyProgram }] = await Promise.all([import("./supabase.js"), import("./client.js")]);

  const [weightRes, checkinRes, logRes, prog] = await Promise.all([
    supabase.from("progress_weights").select("date, weight").order("date", { ascending: true }),
    supabase.from("checkins").select("submitted_at, weight").not("weight", "is", null),
    supabase.from("workout_logs").select("session_id, exercise_id, weight, reps, done"),
    getMyProgram(),
  ]);
  if (weightRes.error) throw weightRes.error;
  if (checkinRes.error) throw checkinRes.error;
  if (logRes.error) throw logRes.error;

  const sessionIds = [...new Set((logRes.data ?? []).map((l) => l.session_id))];
  let sessionDateById = {};
  if (sessionIds.length > 0) {
    const { data: sessions, error: sessErr } = await supabase
      .from("workout_sessions").select("id, session_date").in("id", sessionIds);
    if (sessErr) throw sessErr;
    sessionDateById = Object.fromEntries((sessions ?? []).map((s) => [s.id, s.session_date]));
  }

  const days = Array.isArray(prog?.program?.structure?.days) ? prog.program.structure.days : [];
  const programExerciseNameById = Object.fromEntries(
    days.flatMap((d) => (d.groups ?? []).flatMap((g) => (g.exercises ?? []).map((ex) => [ex.exercise_id, ex.name]))),
  );

  return buildProgressTrends({
    weightRows: weightRes.data ?? [],
    checkinWeightRows: checkinRes.data ?? [],
    workoutLogRows: logRes.data ?? [],
    sessionDateById,
    programExerciseNameById,
  });
}
