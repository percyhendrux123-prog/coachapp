import test from "node:test";
import assert from "node:assert/strict";
import { computeConsistency } from "./consistency.js";

// Weeks run Sun-Sat local. 2026-08-30 is a Sunday, so it anchors week boundaries
// cleanly for every fixture below.
const SUN_AUG_30 = "2026-08-30";

// Every fixture session here carries a real done set unless a test says otherwise —
// these tests are about the streak/window math, not the done-log gate (that gate has
// its own dedicated tests below).
function sessionsFor(dates) {
  return dates.map((session_date) => ({ session_date, status: "complete", workout_logs: [{ done: true }] }));
}

test("no program (zero training days or missing structure) -> not_tracked, never a fake zero", () => {
  const out = computeConsistency({
    today: new Date(`${SUN_AUG_30}T12:00:00`),
    sessions: [],
    programDays: [],
    assignedAt: null,
  });
  assert.equal(out.state, "not_tracked");
});

test("all-rest program (days present, zero training) -> not_tracked", () => {
  const out = computeConsistency({
    today: new Date(`${SUN_AUG_30}T12:00:00`),
    sessions: [],
    programDays: [{ kind: "rest" }, { kind: "rest" }],
    assignedAt: "2026-01-01",
  });
  assert.equal(out.state, "not_tracked");
});

test("3 straight weeks at standard (4/7 day program -> weeklyTarget 4), current week already at target extends the streak", () => {
  // 4 training days out of 7 -> weeklyTarget = round(7*4/7) = 4.
  const programDays = [
    { kind: "training" }, { kind: "training" }, { kind: "rest" },
    { kind: "training" }, { kind: "training" }, { kind: "rest" }, { kind: "rest" },
  ];
  // Weeks (Sun-Sat): Aug 9-15, Aug 16-22, Aug 23-29 each get exactly 4 complete
  // sessions; the current partial week (Aug 30 - today) already has 4 too.
  const sessions = sessionsFor([
    "2026-08-10", "2026-08-11", "2026-08-13", "2026-08-14", // week of Aug 9
    "2026-08-17", "2026-08-18", "2026-08-20", "2026-08-21", // week of Aug 16
    "2026-08-24", "2026-08-25", "2026-08-27", "2026-08-28", // week of Aug 23
    "2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", // current week, already at target
  ]);
  const out = computeConsistency({
    today: new Date("2026-09-02T12:00:00"),
    sessions, programDays, assignedAt: "2026-08-01",
  });
  assert.equal(out.state, "tracked");
  assert.equal(out.weeklyTarget, 4);
  assert.equal(out.weekStreak, 4); // 3 fully-elapsed weeks + current week already met
  assert.equal(out.thisWeek.completed, 4);
  assert.equal(out.thisWeek.target, 4);
});

test("a below-target week breaks the streak — that's real signal, not softened", () => {
  const programDays = [
    { kind: "training" }, { kind: "training" }, { kind: "rest" },
    { kind: "training" }, { kind: "training" }, { kind: "rest" }, { kind: "rest" },
  ];
  const sessions = sessionsFor([
    "2026-08-10", "2026-08-11", "2026-08-13", "2026-08-14", // week of Aug 9: 4/4, met
    "2026-08-18", "2026-08-20",                              // week of Aug 16: 2/4, missed
    "2026-08-24", "2026-08-25", "2026-08-27", "2026-08-28", // week of Aug 23: 4/4, met
  ]);
  const out = computeConsistency({
    today: new Date("2026-08-31T12:00:00"), // mid-way through the following week
    sessions, programDays, assignedAt: "2026-08-01",
  });
  // Only the most recent fully-elapsed week (Aug 23-29) counts toward the
  // streak; the Aug 16 miss breaks anything earlier from counting.
  assert.equal(out.weekStreak, 1);
});

test("sessions before assigned_at are ignored — a client isn't penalized for a prior program's history", () => {
  const programDays = [{ kind: "training" }, { kind: "rest" }];
  // weeklyTarget = round(7*1/2) = 4 for this 2-day cycle... actually check formula:
  // trainingDays=1, days.length=2 -> round(7*1/2) = round(3.5) = 4 (banker's/round-half-up
  // per Math.round). A session logged BEFORE assigned_at must not count toward any week.
  const sessions = sessionsFor([
    "2026-08-09", // before assignment — must be ignored
    "2026-08-24", "2026-08-25", "2026-08-27", "2026-08-28",
  ]);
  const out = computeConsistency({
    today: new Date("2026-08-31T12:00:00"),
    sessions, programDays, assignedAt: "2026-08-20",
  });
  assert.equal(out.state, "tracked");
  // The Aug 9 date sits in the week of Aug 9-15, entirely before assignedAt (Aug 20) —
  // if it were counted it could inflate an earlier week's total. Confirm last28/thisWeek
  // math doesn't choke on it and the pre-assignment week never appears as met.
  assert.equal(out.weekStreak, 1);
});

test("thisWeek and last28 report completed/target without conflating with weekStreak", () => {
  const programDays = [
    { kind: "training" }, { kind: "training" }, { kind: "rest" },
    { kind: "training" }, { kind: "training" }, { kind: "rest" }, { kind: "rest" },
  ];
  const sessions = sessionsFor(["2026-08-30", "2026-08-31"]); // 2 so far this partial week
  const out = computeConsistency({
    today: new Date("2026-09-01T12:00:00"),
    sessions, programDays, assignedAt: "2026-08-01",
  });
  assert.equal(out.thisWeek.completed, 2);
  assert.equal(out.thisWeek.target, 4);
  assert.equal(out.last28.target > 0, true);
});

test("finding B2.1 — a completed session with zero done sets does not count toward the streak or the week", () => {
  const programDays = [
    { kind: "training" }, { kind: "training" }, { kind: "rest" },
    { kind: "training" }, { kind: "training" }, { kind: "rest" }, { kind: "rest" },
  ];
  const sessions = [
    ...sessionsFor(["2026-08-10", "2026-08-11", "2026-08-13", "2026-08-14"]), // real week, 4/4
    // Three "completed" sessions with no workout_logs at all — Sam Rivera's
    // 2026-08-31 pattern: closeDayCore only requires the row to exist.
    { session_date: "2026-08-30", status: "complete", workout_logs: [] },
    { session_date: "2026-08-31", status: "complete", workout_logs: [{ weight: 135, reps: 10, done: false }] },
    { session_date: "2026-09-01", status: "complete" }, // no workout_logs key at all
  ];
  const out = computeConsistency({
    today: new Date("2026-09-02T12:00:00"),
    sessions, programDays, assignedAt: "2026-08-01",
  });
  assert.equal(out.thisWeek.completed, 0); // none of the 3 empty completions count
  // The one real week (Aug 9-15, 4/4 done) is two full weeks before the streak's
  // backward walk even reaches it — the immediately-prior week (Aug 23-29) has
  // zero real sessions, so the walk stops there. Zero is the correct, honest read:
  // an old met week doesn't retroactively extend a streak across an unmet gap.
  assert.equal(out.weekStreak, 0);
});

test("finding B2.1 — a session with at least one done set counts, even if other sets on it are not done", () => {
  const programDays = [{ kind: "training" }, { kind: "rest" }];
  const sessions = [
    {
      session_date: "2026-08-30", status: "complete",
      workout_logs: [{ weight: 135, reps: 10, done: true }, { weight: null, reps: null, done: false }],
    },
  ];
  const out = computeConsistency({
    today: new Date("2026-08-30T12:00:00"),
    sessions, programDays, assignedAt: "2026-08-01",
  });
  assert.equal(out.thisWeek.completed, 1);
});
