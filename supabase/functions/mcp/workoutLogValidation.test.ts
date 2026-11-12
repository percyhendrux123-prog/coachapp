// Deno-only. Run: deno test --allow-read supabase/functions/mcp/workoutLogValidation.test.ts
import { earnedDoneError } from "./workoutLogValidation.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("done omitted -> always fine, regardless of data", () => {
  assert(earnedDoneError({ exercise_id: "e", set_index: 0 }) === null, "done omitted should never error");
});

Deno.test("done:false -> always fine, regardless of data", () => {
  assert(earnedDoneError({ exercise_id: "e", set_index: 0, done: false }) === null, "done:false should never error");
});

Deno.test("done:true with a real weight -> fine", () => {
  assert(earnedDoneError({ exercise_id: "e", set_index: 0, done: true, weight: 135 }) === null, "weight alone should be enough");
});

Deno.test("done:true with a real reps count -> fine", () => {
  assert(earnedDoneError({ exercise_id: "e", set_index: 0, done: true, reps: 10 }) === null, "reps alone should be enough");
});

Deno.test("done:true with cardio duration -> fine", () => {
  assert(earnedDoneError({ exercise_id: "e", set_index: 0, done: true, duration_seconds: 600 }) === null, "duration alone should be enough");
});

Deno.test("done:true with cardio distance -> fine", () => {
  assert(earnedDoneError({ exercise_id: "e", set_index: 0, done: true, distance_meters: 1600 }) === null, "distance alone should be enough");
});

Deno.test("done:true with nothing behind it is refused", () => {
  const err = earnedDoneError({ exercise_id: "bench", set_index: 2, done: true });
  assert(err !== null, "an empty done:true set must be refused");
  assert(err!.includes("bench"), "error should name the exercise");
  assert(err!.includes("2"), "error should name the set index");
});

Deno.test("done:true with all-null values is refused, same as omitted fields", () => {
  const err = earnedDoneError({
    exercise_id: "bench", set_index: 0, done: true,
    weight: null, reps: null, duration_seconds: null, distance_meters: null,
  });
  assert(err !== null, "explicit nulls carry no more data than omission — must still refuse");
});

Deno.test("zero is a real value, not treated as empty", () => {
  // reps: 0 is a legitimate (if unusual) logged value — must not be treated the
  // same as null/undefined by a loose falsy check.
  assert(earnedDoneError({ exercise_id: "e", set_index: 0, done: true, reps: 0 }) === null, "reps:0 should count as a real value");
});
