// Client-side workout execution data layer. Sessions and set logs are written directly
// under the client's own RLS (sess_client_all / logs_client_all); day advancement goes
// through the workout-close edge function because clients are SELECT-only on assignments.
import { supabase } from "./supabase";

// The existing session for a program day, if the client already started it.
export async function getSession({ assignmentId, dayId }) {
  const { data, error } = await supabase
    .from("workout_sessions")
    .select("id, status, session_date, completed_at")
    .eq("assignment_id", assignmentId).eq("day_id", dayId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Start (or resume) the session for a program day. The unique index on
// (assignment_id, day_id) makes this idempotent: re-starting returns the existing row.
export async function startSession({ assignment, dayId, clientId, tenantId }) {
  const { data, error } = await supabase
    .from("workout_sessions")
    .upsert(
      { tenant_id: tenantId, client_id: clientId, assignment_id: assignment.id, day_id: dayId },
      { onConflict: "assignment_id,day_id" },
    )
    .select("id, status, session_date, completed_at")
    .single();
  if (error) throw error;
  return data;
}

export async function listSessionLogs(sessionId) {
  const { data, error } = await supabase
    .from("workout_logs")
    .select("exercise_id, set_index, weight, reps, duration_seconds, distance_meters, rpe, done")
    .eq("session_id", sessionId);
  if (error) throw error;
  return data ?? [];
}

// Upsert one set's actuals on the verified (session_id, exercise_id, set_index) key.
// A strength set passes weight/reps; a cardio step passes durationSeconds/distanceMeters/rpe instead.
export async function logSet({
  sessionId, clientId, tenantId, exerciseId, setIndex, weight, reps, durationSeconds, distanceMeters, rpe, done,
}) {
  const { error } = await supabase.from("workout_logs").upsert(
    {
      tenant_id: tenantId, client_id: clientId, session_id: sessionId,
      exercise_id: exerciseId, set_index: setIndex,
      weight: weight === "" || weight == null ? null : Number(weight),
      reps: reps === "" || reps == null ? null : Number(reps),
      duration_seconds: durationSeconds === "" || durationSeconds == null ? null : Number(durationSeconds),
      distance_meters: distanceMeters === "" || distanceMeters == null ? null : Number(distanceMeters),
      rpe: rpe === "" || rpe == null ? null : Number(rpe),
      done: !!done, updated_at: new Date().toISOString(),
    },
    { onConflict: "session_id,exercise_id,set_index" },
  );
  if (error) throw error;
}

// Close the current day (training: after finishing sets; rest: acknowledge).
// Advances the day, and on the final day cycles into a fresh assignment.
export async function closeDay({ assignmentId, dayId }) {
  const { data, error } = await supabase.functions.invoke("workout-close", {
    body: { assignment_id: assignmentId, day_id: dayId },
  });
  if (error) {
    // Surface the function's own error message when it returned a JSON body.
    let detail = error.message;
    try { detail = (await error.context?.json())?.error ?? detail; } catch { /* keep default */ }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// The client's most recent completed set for one exercise, across ALL past sessions —
// "last time: 135×12" ghost text. Scoped to done=true only: an unfinished/abandoned set
// is not a number worth showing back to the client as what they lifted. exercise_id is
// program-generated (fresh per regeneration), so this naturally returns nothing across a
// program change rather than matching the wrong exercise by name.
export async function getLastPerformance({ clientId, exerciseId }) {
  const { data, error } = await supabase
    .from("workout_logs")
    .select("weight, reps, duration_seconds, distance_meters, rpe, logged_at")
    .eq("client_id", clientId)
    .eq("exercise_id", exerciseId)
    .eq("done", true)
    .order("logged_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Past sessions with their set logs, across ALL assignments (each program cycle is its
// own assignment, so history must not be scoped to the active one).
export async function listHistory(limit = 15) {
  const { data, error } = await supabase
    .from("workout_sessions")
    .select("id, day_id, session_date, status, completed_at, assignment_id, workout_logs(exercise_id, set_index, weight, reps, duration_seconds, distance_meters, rpe, done)")
    .order("session_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}
