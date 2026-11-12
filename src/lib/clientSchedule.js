// Client-side forward schedule — the client twin of src/lib/schedule.js's coach view.
// Same projection primitive (projectDays), plus the two date sources only the client
// calendar cares about: check-in due dates (client_checkin_schedule — written at
// onboarding since intake automation shipped, read by NOTHING until this file) and
// the prep show date. Twin-facts rule: "no program" and "no scheduled check-ins" are
// SYSTEM states (not_tracked / not_scheduled), returned as tagged states so the UI
// can never render them like an empty-but-tracked schedule.
//
// buildForwardSchedule() has no static imports of ./schedule, ./client, or ./supabase
// on purpose: both schedule.js and client.js import supabase.js, which calls
// createClient(import.meta.env.VITE_SUPABASE_URL, ...) at module top-level — that
// throws under plain `node --test` (no Vite env injection), which would make this
// pure function un-unit-testable by import chain alone. startOfDay/ymd come from
// ./dateOnly.js, a zero-dependency twin of schedule.js's own versions (see that
// file's header). projectDays itself now lives in ./projectDays.js, shared with
// schedule.js's coach roster calendar (one algorithm, not two hand-copies) — its
// Deno twin is supabase/functions/mcp/scheduleView.ts's own projectDays, kept in
// sync by hand and guarded by scheduleView.test.ts's parity tests. getMyForwardSchedule
// loads the supabase-dependent modules via dynamic import, deferring that chain to
// call time, same pattern already used for lazy fixture loading in Client.jsx and
// CoachCockpit.jsx.
import { startOfDay, ymd } from "./dateOnly.js";
import { resolveEffectiveDays } from "./effectiveDays.js";
import { projectDays } from "./projectDays.js";

// Pure merge, exported for tests. All inputs are plain data.
export function buildForwardSchedule({ today, fromDate, toDate, program, assignment, scheduleRows, client }) {
  // Reordered per assignment.day_order (client schedule adjustments) when set, else
  // the program's own order — see effectiveDays.js. Both the forward projection below
  // and any "today" read must agree on this same order.
  const { days } = resolveEffectiveDays(program, assignment);
  const programDays = Array.isArray(program?.structure?.days) ? program.structure.days : [];
  const count = Math.round((startOfDay(toDate) - startOfDay(fromDate)) / 86400000) + 1;

  let planned = { state: "not_tracked", byDate: {} };
  if (assignment && days.length > 0) {
    const offset = Math.round((startOfDay(fromDate) - startOfDay(today)) / 86400000);
    const byDate = {};
    for (const { date, day, offset: o } of projectDays(days, programDays, assignment.current_day_index ?? 0, fromDate, count)) {
      // Projection only holds from today forward — the past is workout_sessions' job.
      if (offset + o < 0) continue;
      byDate[ymd(date)] = { kind: day?.kind ?? "training", label: day?.label ?? null };
    }
    planned = { state: "tracked", byDate };
  }

  const rows = (scheduleRows ?? []).filter((r) => r.status === "scheduled");
  const checkins = rows.length > 0
    ? { state: "scheduled", rows }
    : { state: "not_scheduled", rows: [] }; // system gap OR pre-automation client — never "nothing due"

  return {
    planned,
    checkins,
    showDate: client?.show_date ?? null,
    showName: client?.show_name ?? null,
    blockEndsOn: assignment?.ends_on ?? null,
  };
}

// Fetch + merge. RLS: ccs_client_read already lets a client read their own schedule rows.
// Dynamic imports here (see file header) — this function is never exercised by the
// node --test unit tests, only by the browser at runtime, where Vite resolves them
// exactly like any other import.
export async function getMyForwardSchedule({ fromDate, toDate }) {
  const [{ supabase }, { getMyProgram, getMyClient }] = await Promise.all([
    import("./supabase"),
    import("./client"),
  ]);
  const [prog, client, sched] = await Promise.all([
    getMyProgram(),
    getMyClient(),
    supabase.from("client_checkin_schedule")
      .select("due_on, cadence, status")
      .gte("due_on", ymd(fromDate)).lte("due_on", ymd(toDate))
      .order("due_on"),
  ]);
  if (sched.error) throw sched.error;
  return buildForwardSchedule({
    today: startOfDay(),
    fromDate, toDate,
    program: prog?.program ?? null,
    assignment: prog?.assignment ?? null,
    scheduleRows: sched.data ?? [],
    client,
  });
}
