import test from "node:test";
import assert from "node:assert/strict";
import { projectDays } from "./projectDays.js";

// Shared by the coach roster calendar (schedule.js) and the client forward
// schedule (clientSchedule.js) — see clientSchedule.test.js and
// supabase/functions/mcp/scheduleView.test.ts for the same algorithm exercised
// through buildForwardSchedule's own fixtures.

test("within the current block, projection follows the effective (possibly swapped) order", () => {
  const effectiveDays = [
    { day_id: "d", kind: "training", label: "Legs" },
    { day_id: "b", kind: "training", label: "Pull" },
    { day_id: "c", kind: "rest", label: "Rest" },
    { day_id: "a", kind: "training", label: "Push" },
  ];
  const programDays = [
    { day_id: "a", kind: "training", label: "Push" },
    { day_id: "b", kind: "training", label: "Pull" },
    { day_id: "c", kind: "rest", label: "Rest" },
    { day_id: "d", kind: "training", label: "Legs" },
  ];
  const week = projectDays(effectiveDays, programDays, 0, new Date("2026-08-30T00:00:00"), 4);
  assert.deepEqual(week.map((w) => w.day.label), ["Legs", "Pull", "Rest", "Push"]);
});

test("finding B2.3 — projection past the block boundary uses the program's own unswapped order", () => {
  const effectiveDays = [
    { day_id: "d", kind: "training", label: "Legs" },
    { day_id: "b", kind: "training", label: "Pull" },
    { day_id: "c", kind: "rest", label: "Rest" },
    { day_id: "a", kind: "training", label: "Push" },
  ];
  const programDays = [
    { day_id: "a", kind: "training", label: "Push" },
    { day_id: "b", kind: "training", label: "Pull" },
    { day_id: "c", kind: "rest", label: "Rest" },
    { day_id: "d", kind: "training", label: "Legs" },
  ];
  // 7-day window, current_day_index 0 -> 4 slots left in this block, then 3 days
  // into the next cycle (which resets day_order to null per closeDayCore).
  const week = projectDays(effectiveDays, programDays, 0, new Date("2026-08-30T00:00:00"), 7);
  assert.deepEqual(
    week.map((w) => w.day.label),
    ["Legs", "Pull", "Rest", "Push", "Push", "Pull", "Rest"],
  );
});

test("mid-block start: the boundary lands wherever currentIndex actually is, not always at offset 0", () => {
  const effectiveDays = [
    { day_id: "a", label: "Push" }, { day_id: "b", label: "Pull" },
    { day_id: "c", label: "Rest" }, { day_id: "d", label: "Legs" },
  ];
  const programDays = effectiveDays; // no swap in this case
  // currentIndex 2 -> 2 slots remain (Rest, Legs), then cycle restarts at Push.
  const week = projectDays(effectiveDays, programDays, 2, new Date("2026-08-30T00:00:00"), 5);
  assert.deepEqual(week.map((w) => w.day.label), ["Rest", "Legs", "Push", "Pull", "Rest"]);
});

test("no programDays passed (defensive) falls back to effectiveDays itself, not a crash", () => {
  const effectiveDays = [{ day_id: "a", kind: "training", label: "Push" }];
  const week = projectDays(effectiveDays, [], 0, new Date("2026-08-30T00:00:00"), 3);
  assert.deepEqual(week.map((w) => w.day.label), ["Push", "Push", "Push"]);
});

test("empty effectiveDays returns an empty projection", () => {
  assert.deepEqual(projectDays([], [], 0, new Date("2026-08-30T00:00:00"), 5), []);
});
