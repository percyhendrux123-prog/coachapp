// Client history calendar data: workouts (existing sessions) + meal adherence.
// Past only — forward-projected planned days, check-in due dates, and the show-day
// countdown live in src/lib/clientSchedule.js, merged into the same Calendar tab
// (src/pages/Client.jsx's HistoryTab) rather than in a separate component.
import { supabase } from "./supabase";
import { listMealAdherenceRange, groupAdherenceByDate } from "./mealAdherence";
import { startOfDay, ymd } from "./schedule";

/**
 * Workout sessions for the signed-in client in [fromDate, toDate].
 * Includes all statuses so the UI can show started-but-not-finished.
 */
export async function listWorkoutSessionsRange({ fromDate, toDate }) {
  const { data, error } = await supabase
    .from("workout_sessions")
    .select(
      "id, day_id, session_date, status, completed_at, assignment_id, workout_logs(exercise_id, set_index, weight, reps, duration_seconds, distance_meters, rpe, done)"
    )
    .gte("session_date", fromDate)
    .lte("session_date", toDate)
    .order("session_date", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** All completed sessions (paginated) for the list under the calendar. */
export async function listWorkoutHistory({ limit = 60 } = {}) {
  const { data, error } = await supabase
    .from("workout_sessions")
    .select(
      "id, day_id, session_date, status, completed_at, assignment_id, workout_logs(exercise_id, set_index, weight, reps, duration_seconds, distance_meters, rpe, done)"
    )
    .order("session_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/**
 * Month pack for the client History tab.
 * fromDate/toDate are Date objects (grid range).
 */
export async function getClientMonthHistory({ fromDate, toDate }) {
  const from = ymd(fromDate);
  const to = ymd(toDate);
  const [sessions, meals] = await Promise.all([
    listWorkoutSessionsRange({ fromDate: from, toDate: to }),
    listMealAdherenceRange({ fromDate: from, toDate: to }).catch((e) => {
      // Table may not be migrated yet — surface empty meals, not a dead page.
      if (String(e?.message || e).includes("meal_adherence_logs") || e?.code === "42P01") return [];
      throw e;
    }),
  ]);

  const sessionsByDate = {};
  for (const s of sessions) {
    (sessionsByDate[s.session_date] ??= []).push(s);
  }
  const mealsByDate = groupAdherenceByDate(meals);

  return { sessions, meals, sessionsByDate, mealsByDate, from, to };
}

export function monthGrid(monthDate) {
  const month = startOfDay(monthDate);
  month.setDate(1);
  const gridStart = new Date(month);
  gridStart.setDate(1 - month.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return startOfDay(d);
  });
  return { month, cells };
}

export { ymd, startOfDay };
