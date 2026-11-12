// Wave 2 #2 — Training calendar data layer.
//
// Training is sequence-based, not date-scheduled: a program is an ordered list of
// days (structure.days), and an assignment walks it via current_day_index (0-based).
// workout_sessions.session_date is the ACTUAL date a client trained a day. So the
// calendar is a view over existing data — no new tables:
//   • past/present  -> real workout_sessions (truth)
//   • today/future  -> a projection of the day-sequence, one program-day per calendar
//                      day (rest days are days in the sequence, so they land naturally)
//
// Every read here is authorized by existing coach RLS (assign_coach_all,
// programs_coach_all, sess_coach_read). Program linkage is loose-uuid (no FK), so we
// fetch programs/clients separately and join in JS rather than relying on embeds.
import { supabase } from "./supabase";
import { resolveEffectiveDays } from "./effectiveDays.js";
import { projectDays } from "./projectDays.js";

// Re-exported for existing callers (CoachCalendar.jsx imports it from here) — the
// implementation itself now lives in projectDays.js so it can be unit-tested without
// pulling in this file's supabase.js import (see that file's header).
export { projectDays };

// Local midnight for `date` (or today), so day math ignores time-of-day.
export function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// "YYYY-MM-DD" in local time — matches the `date`-typed session_date for comparisons.
export function ymd(date) {
  const d = new Date(date);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

// Roster schedule for the coach: every active assignment (client + program day
// sequence + current position) plus actual sessions within [fromDate, toDate].
export async function getCoachSchedule({ fromDate, toDate }) {
  const [{ data: assigns, error: ae }, { data: sessions, error: se }] = await Promise.all([
    supabase.from("assignments")
      .select("id, client_id, current_day_index, program_id, day_order")
      .eq("active", true),
    supabase.from("workout_sessions")
      .select("id, client_id, day_id, session_date, status")
      .gte("session_date", ymd(fromDate)).lte("session_date", ymd(toDate))
      .order("session_date"),
  ]);
  if (ae) throw ae;
  if (se) throw se;

  const programIds = [...new Set((assigns ?? []).map((a) => a.program_id).filter(Boolean))];
  const clientIds = [...new Set([
    ...(assigns ?? []).map((a) => a.client_id),
    ...(sessions ?? []).map((s) => s.client_id),
  ].filter(Boolean))];

  const [{ data: progs }, { data: clients }] = await Promise.all([
    programIds.length
      ? supabase.from("programs").select("id, name, structure").in("id", programIds)
      : Promise.resolve({ data: [] }),
    clientIds.length
      ? supabase.from("clients").select("id, display_name").in("id", clientIds)
      : Promise.resolve({ data: [] }),
  ]);

  const progById = Object.fromEntries((progs ?? []).map((p) => [p.id, p]));
  const nameById = Object.fromEntries((clients ?? []).map((c) => [c.id, c.display_name]));

  const roster = (assigns ?? []).map((a) => {
    const p = progById[a.program_id];
    // Reordered per assignment.day_order (client schedule adjustments) when set, else
    // the program's own order — see effectiveDays.js. The coach's roster projection
    // must show the same order the client actually walks, not the coach's authored
    // program order if the client has swapped a day.
    const { days } = resolveEffectiveDays(p, a);
    return {
      assignmentId: a.id,
      clientId: a.client_id,
      displayName: nameById[a.client_id] ?? "Client",
      programName: p?.name ?? "Program",
      days,
      // The program's own unswapped order — projectDays needs this for anything it
      // projects past the current block's boundary (finding B2.3).
      programDays: Array.isArray(p?.structure?.days) ? p.structure.days : [],
      currentDayIndex: a.current_day_index ?? 0,
    };
  });

  const acts = (sessions ?? []).map((s) => ({
    id: s.id,
    clientId: s.client_id,
    displayName: nameById[s.client_id] ?? "Client",
    dayId: s.day_id,
    date: s.session_date,
    status: s.status,
  }));

  return { roster, sessions: acts };
}
