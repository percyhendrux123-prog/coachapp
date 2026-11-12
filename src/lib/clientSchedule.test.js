import test from "node:test";
import assert from "node:assert/strict";
import { buildForwardSchedule } from "./clientSchedule.js";

test("projects planned days and merges check-in due dates by date", () => {
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
  assert.equal(out.planned.state, "tracked");
  assert.equal(out.planned.byDate["2026-08-30"].label, "Push");
  assert.equal(out.planned.byDate["2026-08-31"].kind, "rest");
  assert.equal(out.checkins.state, "scheduled");
  assert.equal(out.checkins.rows[0].due_on, "2026-09-01");
  assert.equal(out.blockEndsOn, "2026-09-03");
  assert.equal(out.showDate, "2026-10-10");
  assert.equal(out.showName, "Fall Classic");
});

test("no program → planned not_tracked, never an empty tracked map", () => {
  const out = buildForwardSchedule({
    today: new Date("2026-08-30T00:00:00"),
    fromDate: new Date("2026-08-30T00:00:00"),
    toDate: new Date("2026-09-05T00:00:00"),
    program: null, assignment: null, scheduleRows: [], client: {},
  });
  assert.equal(out.planned.state, "not_tracked");
  assert.equal(out.checkins.state, "not_scheduled");
});

test("cancelled/missed schedule rows are excluded, not counted as scheduled", () => {
  const out = buildForwardSchedule({
    today: new Date("2026-08-30T00:00:00"),
    fromDate: new Date("2026-08-30T00:00:00"),
    toDate: new Date("2026-09-05T00:00:00"),
    program: null, assignment: null,
    scheduleRows: [
      { due_on: "2026-09-01", cadence: "weekly", status: "cancelled" },
      { due_on: "2026-09-02", cadence: "weekly", status: "missed" },
    ],
    client: {},
  });
  assert.equal(out.checkins.state, "not_scheduled");
  assert.equal(out.checkins.rows.length, 0);
});

test("projection follows assignment.day_order when a client has reordered their block", () => {
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
    // Client pulled Legs forward to today, pushing Push back to where Legs was.
    assignment: { current_day_index: 0, day_order: ["d", "b", "c", "a"] },
    scheduleRows: [],
    client: {},
  });
  assert.equal(out.planned.byDate["2026-08-30"].label, "Legs");
  assert.equal(out.planned.byDate["2026-08-31"].label, "Pull");
  assert.equal(out.planned.byDate["2026-09-01"].kind, "rest");
  assert.equal(out.planned.byDate["2026-09-02"].label, "Push");
});

test("a stale day_order (program edited since) falls back to program order in the projection, not a partial reorder", () => {
  const out = buildForwardSchedule({
    today: new Date("2026-08-30T00:00:00"),
    fromDate: new Date("2026-08-30T00:00:00"),
    toDate: new Date("2026-08-31T00:00:00"),
    program: { structure: { days: [
      { day_id: "a", kind: "training", label: "Push" },
      { day_id: "b", kind: "training", label: "Pull" },
    ] } },
    // References a day_id ("z") that no longer exists in the program.
    assignment: { current_day_index: 0, day_order: ["b", "z"] },
    scheduleRows: [],
    client: {},
  });
  assert.equal(out.planned.byDate["2026-08-30"].label, "Push");
  assert.equal(out.planned.byDate["2026-08-31"].label, "Pull");
});

test("finding B2.3 — a swap does not carry past the current block's boundary", () => {
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
    // Legs pulled to today; current_day_index 0 -> 4 slots remain in this block
    // (today through Sep 2). Sep 3 is the first day of the NEXT cycle, and
    // closeDayCore resets day_order to null when that cycle starts.
    assignment: { current_day_index: 0, day_order: ["d", "b", "c", "a"] },
    scheduleRows: [],
    client: {},
  });
  assert.equal(out.planned.byDate["2026-08-30"].label, "Legs"); // in-block: swap applies
  assert.equal(out.planned.byDate["2026-08-31"].label, "Pull");
  assert.equal(out.planned.byDate["2026-09-01"].kind, "rest");
  assert.equal(out.planned.byDate["2026-09-02"].label, "Push"); // last in-block day
  assert.equal(out.planned.byDate["2026-09-03"].label, "Push"); // next cycle: program's OWN order (day 0), not the swap
});

test("projection from today never leaks a day before today, even mid-range", () => {
  const out = buildForwardSchedule({
    today: new Date("2026-08-30T00:00:00"),
    fromDate: new Date("2026-08-28T00:00:00"),
    toDate: new Date("2026-09-01T00:00:00"),
    program: { structure: { days: [{ day_id: "a", kind: "training", label: "Push" }] } },
    assignment: { current_day_index: 0 },
    scheduleRows: [],
    client: {},
  });
  assert.equal(out.planned.byDate["2026-08-28"], undefined);
  assert.equal(out.planned.byDate["2026-08-29"], undefined);
  assert.ok(out.planned.byDate["2026-08-30"]);
  assert.ok(out.planned.byDate["2026-09-01"]);
});
