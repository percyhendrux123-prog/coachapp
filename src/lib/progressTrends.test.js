import test from "node:test";
import assert from "node:assert/strict";
import { buildProgressTrends } from "./progressTrends.js";

test("weight: progress_weights wins over a same-date checkin-derived point, sorted ascending", () => {
  const out = buildProgressTrends({
    weightRows: [{ date: "2026-08-20", weight: 180 }],
    checkinWeightRows: [
      { submitted_at: "2026-08-20T09:00:00Z", weight: 182 }, // same date as a real weigh-in — loses
      { submitted_at: "2026-08-13T09:00:00Z", weight: 185 }, // no progress_weights row that date — wins
    ],
    workoutLogRows: [],
    sessionDateById: {},
    programExerciseNameById: {},
  });
  assert.equal(out.weight.state, "tracked");
  assert.deepEqual(out.weight.points, [
    { date: "2026-08-13", value: 185 },
    { date: "2026-08-20", value: 180 },
  ]);
});

test("weight: nothing logged anywhere -> not_tracked, never a fabricated point", () => {
  const out = buildProgressTrends({
    weightRows: [], checkinWeightRows: [], workoutLogRows: [], sessionDateById: {}, programExerciseNameById: {},
  });
  assert.equal(out.weight.state, "not_tracked");
  assert.deepEqual(out.weight.points, []);
});

test("lifts: best done set per session date per exercise, strength only, current-program exercises only", () => {
  const out = buildProgressTrends({
    weightRows: [], checkinWeightRows: [],
    workoutLogRows: [
      { session_id: "s1", exercise_id: "bench", set_index: 0, weight: 135, reps: 8, done: true },
      { session_id: "s1", exercise_id: "bench", set_index: 1, weight: 145, reps: 6, done: true }, // best this date
      { session_id: "s1", exercise_id: "bench", set_index: 2, weight: 999, reps: 1, done: false }, // not done — excluded
      { session_id: "s1", exercise_id: "row", set_index: 0, weight: null, reps: null, done: true, duration_seconds: 600 }, // cardio-shaped — excluded (weight null)
      { session_id: "s2", exercise_id: "bench", set_index: 0, weight: 150, reps: 5, done: true },
      { session_id: "s3", exercise_id: "old_ex", set_index: 0, weight: 100, reps: 10, done: true }, // not in current program
    ],
    sessionDateById: { s1: "2026-08-10", s2: "2026-08-17", s3: "2026-08-10" },
    programExerciseNameById: { bench: "Bench Press", row: "Barbell Row" },
  });
  assert.equal(out.lifts.state, "tracked");
  assert.equal(out.lifts.omittedEarlierExercises, 1);
  const bench = out.lifts.series.find((s) => s.exerciseId === "bench");
  assert.ok(bench, "bench should appear in series");
  assert.equal(bench.label, "Bench Press");
  assert.deepEqual(bench.points, [
    { date: "2026-08-10", bestWeight: 145, reps: 6 },
    { date: "2026-08-17", bestWeight: 150, reps: 5 },
  ]);
  // row had a program label but zero valid strength points (its only log was cardio-shaped) —
  // it must not appear in series just because it's in the current program.
  assert.equal(out.lifts.series.some((s) => s.exerciseId === "row"), false);
  // old_ex must never appear in series (not in the current program), only counted.
  assert.equal(out.lifts.series.some((s) => s.exerciseId === "old_ex"), false);
});

test("lifts: no strength logs at all -> not_tracked, zero omitted", () => {
  const out = buildProgressTrends({
    weightRows: [], checkinWeightRows: [], workoutLogRows: [], sessionDateById: {}, programExerciseNameById: {},
  });
  assert.equal(out.lifts.state, "not_tracked");
  assert.deepEqual(out.lifts.series, []);
  assert.equal(out.lifts.omittedEarlierExercises, 0);
});

test("lifts: series is ordered most-logged first, so the UI can slice(0, 6) directly", () => {
  const out = buildProgressTrends({
    weightRows: [], checkinWeightRows: [],
    workoutLogRows: [
      { session_id: "s1", exercise_id: "squat", weight: 200, reps: 5, done: true },
      { session_id: "s1", exercise_id: "bench", weight: 135, reps: 8, done: true },
      { session_id: "s2", exercise_id: "bench", weight: 140, reps: 8, done: true },
      { session_id: "s3", exercise_id: "bench", weight: 145, reps: 6, done: true },
    ],
    sessionDateById: { s1: "2026-08-01", s2: "2026-08-08", s3: "2026-08-15" },
    programExerciseNameById: { squat: "Back Squat", bench: "Bench Press" },
  });
  assert.equal(out.lifts.series[0].exerciseId, "bench"); // 3 points beats squat's 1
  assert.equal(out.lifts.series[1].exerciseId, "squat");
});
