// Pure guard for the two agent-facing set-logging tools (log_workout_on_behalf,
// log_workout_sets). The human app only ever sets done:true from an explicit Mark
// tap on a set that already has a real value typed in — an agent call that flips
// done:true with nothing behind it would invent a performed set that never
// happened. Pure so it's testable without mocking
// Supabase; both tool bodies call this before building their upsert payload.
export type SetInput = {
  exercise_id?: string;
  set_index?: number;
  weight?: number | null;
  reps?: number | null;
  duration_seconds?: number | null;
  distance_meters?: number | null;
  done?: boolean;
};

// Returns a ready-to-throw message when the set is invalid, or null when it's fine.
// Only fires when done is explicitly true — done:false or done omitted (now
// defaulting to false, see index.ts) is always a legal, real "not yet done" record.
export function earnedDoneError(s: SetInput): string | null {
  if (s.done !== true) return null;
  const hasValue = s.weight != null || s.reps != null || s.duration_seconds != null || s.distance_meters != null;
  if (hasValue) return null;
  return `set_index ${s.set_index} for exercise ${s.exercise_id} is marked done with no weight, reps, duration, or distance — an empty "done" set is not a real record. Include an actual value, or leave done unset/false.`;
}
