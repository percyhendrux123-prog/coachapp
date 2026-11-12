// Deno-only. Run: deno test --allow-read supabase/functions/mcp/scheduleView.test.ts
// (`node --test` on this file throws "Deno is not defined" — a runner mismatch, not a failure.)
//
// Parity guard for the hand-maintained Deno twin (see scheduleView.ts's header). Every
// fixture here is copied from the frontend's own test files, cited above each block, and
// must produce the identical output there and here. If this file and its JS source ever
// disagree, one of them has drifted — fix the twin, not the test.
import { buildForwardSchedule, buildProgressTrends, checkinScheduleActions, computeConsistency } from "./scheduleView.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEqualJson(actual: unknown, expected: unknown, message: string) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message} — got ${JSON.stringify(actual)}`);
}

// ---- buildForwardSchedule — fixtures from src/lib/clientSchedule.test.js ----

Deno.test("buildForwardSchedule: projects planned days and merges check-in due dates by date", () => {
  const out = buildForwardSchedule({
    today: new Date("2026-08-30T00:00:00"),
    fromDate: new Date("2026-08-30T00:00:00"),
    toDate: new Date("2026-09-05T00:00:00"),
    program: { structure: { days: [
      { day_id: "a", kind: "training", label: "Push" },
      { day_id: "b", kind: "rest" },
    ] } },
    assignment: { current_day_index: 0, ends_on: "2026-09-03" },
    scheduleRows: [{ due_on: "2026-09-01", cadence: "weekly", status: "scheduled" }],
    client: { show_date: "2026-10-10", show_name: "Fall Classic" },
  });
  assert(out.planned.state === "tracked", "planned should be tracked");
  assert(out.planned.byDate["2026-08-30"].label === "Push", "Aug 30 should be Push");
  assert(out.planned.byDate["2026-08-31"].kind === "rest", "Aug 31 should be rest");
  assert(out.checkins.state === "scheduled", "checkins should be scheduled");
  assert(out.checkins.rows[0].due_on === "2026-09-01", "due date should be Sep 1");
  assert(out.blockEndsOn === "2026-09-03", "block end should be Sep 3");
  assert(out.showDate === "2026-10-10", "show date should pass through");
  assert(out.showName === "Fall Classic", "show name should pass through");
});

// Fixture mirrors clientSchedule.test.js's "projection follows assignment.day_order"
// case — confirms my_schedule/get_client_schedule (both callers of this function)
// reflect a client schedule adjustment, not just the app's own calendar.
Deno.test("buildForwardSchedule: follows assignment.day_order when a client has reordered their block", () => {
  const out = buildForwardSchedule({
    today: new Date("2026-08-30T00:00:00"),
    fromDate: new Date("2026-08-30T00:00:00"),
    toDate: new Date("2026-09-02T00:00:00"),
    program: { structure: { days: [
      { day_id: "a", kind: "training", label: "Push" },
      { day_id: "b", kind: "training", label: "Pull" },
      { day_id: "c", kind: "rest", label: "Rest" },
      { day_id: "d", kind: "training", label: "Legs" },
    ] } },
    assignment: { current_day_index: 0, day_order: ["d", "b", "c", "a"] },
    scheduleRows: [],
    client: null,
  });
  assert(out.planned.byDate["2026-08-30"].label === "Legs", "today should be the pulled-forward day");
  assert(out.planned.byDate["2026-09-02"].label === "Push", "the displaced day should land in its new slot");
});

Deno.test("buildForwardSchedule: a stale day_order falls back to program order entirely, not a partial reorder", () => {
  const out = buildForwardSchedule({
    today: new Date("2026-08-30T00:00:00"),
    fromDate: new Date("2026-08-30T00:00:00"),
    toDate: new Date("2026-08-31T00:00:00"),
    program: { structure: { days: [
      { day_id: "a", kind: "training", label: "Push" },
      { day_id: "b", kind: "training", label: "Pull" },
    ] } },
    assignment: { current_day_index: 0, day_order: ["b", "z"] },
    scheduleRows: [],
    client: null,
  });
  assert(out.planned.byDate["2026-08-30"].label === "Push", "stale override should fall back to program order");
  assert(out.planned.byDate["2026-08-31"].label === "Pull", "stale override should fall back to program order");
});

Deno.test("buildForwardSchedule: no program -> planned not_tracked, never an empty tracked map", () => {
  const out = buildForwardSchedule({
    today: new Date("2026-08-30T00:00:00"),
    fromDate: new Date("2026-08-30T00:00:00"),
    toDate: new Date("2026-09-05T00:00:00"),
    program: null, assignment: null, scheduleRows: [], client: null,
  });
  assert(out.planned.state === "not_tracked", "no program -> not_tracked");
  assert(out.checkins.state === "not_scheduled", "no rows -> not_scheduled");
});

Deno.test("buildForwardSchedule: cancelled/missed rows are excluded, not counted as scheduled", () => {
  const out = buildForwardSchedule({
    today: new Date("2026-08-30T00:00:00"),
    fromDate: new Date("2026-08-30T00:00:00"),
    toDate: new Date("2026-09-05T00:00:00"),
    program: null, assignment: null,
    scheduleRows: [
      { due_on: "2026-09-01", cadence: "weekly", status: "cancelled" },
      { due_on: "2026-09-02", cadence: "weekly", status: "missed" },
    ],
    client: null,
  });
  assert(out.checkins.state === "not_scheduled", "only scheduled rows count");
  assert(out.checkins.rows.length === 0, "cancelled/missed rows must not appear");
});

Deno.test("buildForwardSchedule: projection never leaks a day before today", () => {
  const out = buildForwardSchedule({
    today: new Date("2026-08-30T00:00:00"),
    fromDate: new Date("2026-08-28T00:00:00"),
    toDate: new Date("2026-09-01T00:00:00"),
    program: { structure: { days: [{ day_id: "a", kind: "training", label: "Push" }] } },
    assignment: { current_day_index: 0 },
    scheduleRows: [], client: null,
  });
  assert(out.planned.byDate["2026-08-28"] === undefined, "Aug 28 (before today) must not appear");
  assert(out.planned.byDate["2026-08-29"] === undefined, "Aug 29 (before today) must not appear");
  assert(Boolean(out.planned.byDate["2026-08-30"]), "today must appear");
  assert(Boolean(out.planned.byDate["2026-09-01"]), "a future day must appear");
});

// ---- computeConsistency — fixtures from src/lib/consistency.test.js ----

function sessionsFor(dates: string[]) {
  return dates.map((session_date) => ({ session_date, status: "complete", workout_logs: [{ done: true }] }));
}

Deno.test("computeConsistency: no training days -> not_tracked, never a fake zero", () => {
  const out = computeConsistency({
    today: new Date("2026-08-30T12:00:00"), sessions: [], programDays: [], assignedAt: null,
  });
  assert(out.state === "not_tracked", "empty program -> not_tracked");
});

Deno.test("computeConsistency: 3 straight weeks at standard, current partial week already at target extends it", () => {
  const programDays = [
    { kind: "training" }, { kind: "training" }, { kind: "rest" },
    { kind: "training" }, { kind: "training" }, { kind: "rest" }, { kind: "rest" },
  ];
  const sessions = sessionsFor([
    "2026-08-10", "2026-08-11", "2026-08-13", "2026-08-14",
    "2026-08-17", "2026-08-18", "2026-08-20", "2026-08-21",
    "2026-08-24", "2026-08-25", "2026-08-27", "2026-08-28",
    "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02",
  ]);
  const out = computeConsistency({
    today: new Date("2026-09-02T12:00:00"), sessions, programDays, assignedAt: "2026-08-01",
  });
  assert(out.state === "tracked", "should be tracked");
  assert("weeklyTarget" in out && out.weeklyTarget === 4, "weekly target should be 4");
  assert("weekStreak" in out && out.weekStreak === 4, "streak should be 4");
});

Deno.test("computeConsistency: a below-target week breaks the streak", () => {
  const programDays = [
    { kind: "training" }, { kind: "training" }, { kind: "rest" },
    { kind: "training" }, { kind: "training" }, { kind: "rest" }, { kind: "rest" },
  ];
  const sessions = sessionsFor([
    "2026-08-10", "2026-08-11", "2026-08-13", "2026-08-14",
    "2026-08-18", "2026-08-20",
    "2026-08-24", "2026-08-25", "2026-08-27", "2026-08-28",
  ]);
  const out = computeConsistency({
    today: new Date("2026-08-31T12:00:00"), sessions, programDays, assignedAt: "2026-08-01",
  });
  assert("weekStreak" in out && out.weekStreak === 1, "the earlier miss must cap the streak at 1");
});

// Fixture mirrors consistency.test.js — a "complete" session with no
// done sets must not count toward the
// coach-facing get_client_progress number either.
Deno.test("computeConsistency: a completed session with zero done sets does not count", () => {
  const programDays = [
    { kind: "training" }, { kind: "training" }, { kind: "rest" },
    { kind: "training" }, { kind: "training" }, { kind: "rest" }, { kind: "rest" },
  ];
  const sessions = [
    ...sessionsFor(["2026-08-10", "2026-08-11", "2026-08-13", "2026-08-14"]),
    { session_date: "2026-08-30", status: "complete", workout_logs: [] },
    { session_date: "2026-08-31", status: "complete", workout_logs: [{ done: false }] },
    { session_date: "2026-09-01", status: "complete" },
  ];
  const out = computeConsistency({
    today: new Date("2026-09-02T12:00:00"), sessions, programDays, assignedAt: "2026-08-01",
  });
  assert("thisWeek" in out && out.thisWeek!.completed === 0, "none of the 3 empty completions should count");
  assert("weekStreak" in out && out.weekStreak === 0, "an old met week two weeks back must not bridge an unmet gap");
});

// ---- buildForwardSchedule block-boundary projection ----

// Fixture mirrors clientSchedule.test.js. closeDayCore resets
// assignment.day_order to null on every new block — a swap lasts exactly one
// block, so projecting PAST the current block's end must fall back to the
// program's own unswapped order, not carry the swap into the next cycle.
Deno.test("buildForwardSchedule: a swap does not carry past the current block's boundary", () => {
  const out = buildForwardSchedule({
    today: new Date("2026-08-30T00:00:00"),
    fromDate: new Date("2026-08-30T00:00:00"),
    toDate: new Date("2026-09-03T00:00:00"), // 5 days: block (4) + 1 into the next cycle
    program: { structure: { days: [
      { day_id: "a", kind: "training", label: "Push" },
      { day_id: "b", kind: "training", label: "Pull" },
      { day_id: "c", kind: "rest", label: "Rest" },
      { day_id: "d", kind: "training", label: "Legs" },
    ] } },
    // Legs pulled to today; current_day_index 0 means 4 slots remain in this block
    // (today through Sep 2). Sep 3 is the first day of the NEXT cycle.
    assignment: { current_day_index: 0, day_order: ["d", "b", "c", "a"] },
    scheduleRows: [],
    client: null,
  });
  assert(out.planned.byDate["2026-08-30"].label === "Legs", "today (in-block) follows the swap");
  assert(out.planned.byDate["2026-08-31"].label === "Pull", "in-block follows the swap");
  assert(out.planned.byDate["2026-09-01"].kind === "rest", "in-block follows the swap");
  assert(out.planned.byDate["2026-09-02"].label === "Push", "last in-block day follows the swap");
  assert(out.planned.byDate["2026-09-03"].label === "Push", "next cycle uses the program's OWN order (day 0), not the swap");
});

// ---- buildProgressTrends — fixtures from src/lib/progressTrends.test.js ----

Deno.test("buildProgressTrends: progress_weights wins over a same-date checkin point, sorted ascending", () => {
  const out = buildProgressTrends({
    weightRows: [{ date: "2026-08-20", weight: 180 }],
    checkinWeightRows: [
      { submitted_at: "2026-08-20T09:00:00Z", weight: 182 },
      { submitted_at: "2026-08-13T09:00:00Z", weight: 185 },
    ],
    workoutLogRows: [], sessionDateById: {}, programExerciseNameById: {},
  });
  assert(out.weight.state === "tracked", "should be tracked");
  assertEqualJson(out.weight.points, [
    { date: "2026-08-13", value: 185 },
    { date: "2026-08-20", value: 180 },
  ], "weight points should match, progress_weights winning on Aug 20");
});

Deno.test("buildProgressTrends: best done set per session date per exercise, current-program-only, cardio excluded", () => {
  const out = buildProgressTrends({
    weightRows: [], checkinWeightRows: [],
    workoutLogRows: [
      { session_id: "s1", exercise_id: "bench", weight: 135, reps: 8, done: true },
      { session_id: "s1", exercise_id: "bench", weight: 145, reps: 6, done: true },
      { session_id: "s1", exercise_id: "bench", weight: 999, reps: 1, done: false },
      { session_id: "s1", exercise_id: "row", weight: null, reps: null, done: true },
      { session_id: "s2", exercise_id: "bench", weight: 150, reps: 5, done: true },
      { session_id: "s3", exercise_id: "old_ex", weight: 100, reps: 10, done: true },
    ],
    sessionDateById: { s1: "2026-08-10", s2: "2026-08-17", s3: "2026-08-10" },
    programExerciseNameById: { bench: "Bench Press", row: "Barbell Row" },
  });
  assert(out.lifts.state === "tracked", "should be tracked");
  assert(out.lifts.omittedEarlierExercises === 1, "old_ex should be counted as omitted");
  const bench = out.lifts.series.find((s) => s.exerciseId === "bench");
  assert(Boolean(bench), "bench should be in series");
  assertEqualJson(bench!.points, [
    { date: "2026-08-10", bestWeight: 145, reps: 6 },
    { date: "2026-08-17", bestWeight: 150, reps: 5 },
  ], "bench points should match");
  assert(!out.lifts.series.some((s) => s.exerciseId === "old_ex"), "old_ex must never appear in series");
});

Deno.test("buildProgressTrends: no strength logs at all -> not_tracked, zero omitted", () => {
  const out = buildProgressTrends({
    weightRows: [], checkinWeightRows: [], workoutLogRows: [], sessionDateById: {}, programExerciseNameById: {},
  });
  assert(out.lifts.state === "not_tracked", "no logs -> not_tracked");
  assert(out.lifts.omittedEarlierExercises === 0, "no omissions when nothing was logged");
});

// ---- checkinScheduleActions — new for update_client_prep_info's regeneration path ----

Deno.test("checkinScheduleActions: a cadence change triggers cancel + regenerate", () => {
  const out = checkinScheduleActions({ checkin_cadence: "biweekly" }, "client-1", "2026-08-30");
  assertEqualJson(out, { kind: "cancel_and_regenerate", clientId: "client-1", todayYmd: "2026-08-30" }, "cadence change should trigger regeneration");
});

Deno.test("checkinScheduleActions: a day-of-week-only change also triggers cancel + regenerate", () => {
  const out = checkinScheduleActions({ checkin_day_of_week: 3 }, "client-1", "2026-08-30");
  assert(out.kind === "cancel_and_regenerate", "day-of-week alone should also trigger regeneration");
});

Deno.test("checkinScheduleActions: a show_date-only patch (no cadence fields) does nothing", () => {
  const out = checkinScheduleActions({ show_date: "2026-10-10" }, "client-1", "2026-08-30");
  assertEqualJson(out, { kind: "none" }, "unrelated fields must not trigger a regeneration");
});

Deno.test("checkinScheduleActions: an empty patch does nothing", () => {
  const out = checkinScheduleActions({}, "client-1", "2026-08-30");
  assertEqualJson(out, { kind: "none" }, "empty patch must not trigger a regeneration");
});
