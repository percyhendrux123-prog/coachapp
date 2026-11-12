// Deno-only. Run: deno test supabase/functions/mcp/intakeView.test.ts
import {
  intakeCompleteness,
  mergeIntakeAnswers,
  PARQ_FIELDS,
  parqView,
  redactAnswers,
  validateIntakeAnswers,
  waiverView,
} from "./intakeView.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const eq = (actual: unknown, expected: unknown, message: string) =>
  assert(Object.is(actual, expected), `${message} — expected ${String(expected)}, got ${String(actual)}`);

const cleanParq = Object.fromEntries(PARQ_FIELDS.map((k) => [k, false]));

Deno.test("an unanswered PAR-Q question is null, never 'no'", () => {
  const partial = { ...cleanParq };
  delete (partial as Record<string, unknown>).parq_chest_pain;
  const view = parqView(partial);
  eq(view.answered, 7, "seven of eight answered");
  eq(view.complete, false, "an incomplete screen is not complete");
  eq(view.unanswered[0], "parq_chest_pain", "the missing question is named");
  const chest = view.responses.find((r) => r.key === "parq_chest_pain");
  eq(chest?.answer, null, "a question nobody asked reads null, not false");
});

Deno.test("a flagged PAR-Q answer is surfaced, not summarised away", () => {
  const view = parqView({ ...cleanParq, parq_heart_condition: true, medications: "  lisinopril " });
  eq(view.complete, true, "all eight answered");
  eq(view.flagged.length, 1, "one flag");
  eq(view.flagged[0], "parq_heart_condition", "and it is named");
  eq(view.medications, "lisinopril", "medications are trimmed but not paraphrased");
  eq(view.medications_state, "disclosed", "disclosed medications are their own state");
});

Deno.test("medications: never asked and answered-none are different facts", () => {
  eq(parqView({ ...cleanParq }).medications_state, "not_asked", "absent key means nobody asked");
  eq(parqView({ ...cleanParq, medications: "" }).medications_state, "none_stated", "an empty answer is a real answer");
});

Deno.test("no intake at all is not a clean screen", () => {
  const view = parqView(null);
  eq(view.answered, 0, "nothing answered");
  eq(view.complete, false, "and it must not read as complete");
  eq(view.flagged.length, 0, "no flags, because no answers — not because they are clear");
});

Deno.test("completeness names what is absent and falls back to the profile for body metrics", () => {
  const answers = { goal: "fat_loss", equipment: "full_gym", ...cleanParq };
  const bare = intakeCompleteness(answers, null);
  assert(bare.missing_programming.includes("experience"), "missing experience is named");
  assert(bare.missing_programming.includes("days_per_week"), "missing days_per_week is named");
  assert(bare.missing_body_metrics.includes("weight_kg"), "missing body metric is named");
  eq(bare.programmable, false, "not programmable");

  const withProfile = intakeCompleteness(
    { ...answers, experience: "beginner", days_per_week: 4 },
    { sex: "male", age: 34, height_cm: 180, weight_kg: 88 },
  );
  eq(withProfile.missing_body_metrics.length, 0, "metrics already on the profile are not missing");
  eq(withProfile.programmable, true, "now programmable");
});

Deno.test("coach-keyed intake refuses invented enum values instead of storing them", () => {
  assert(validateIntakeAnswers({ goal: "fatloss" })?.includes("goal must be one of"), "a near-miss goal is rejected");
  assert(validateIntakeAnswers({ days_per_week: 9 })?.includes("days_per_week"), "out-of-range days rejected");
  assert(validateIntakeAnswers({ injuries: ["ankle"] })?.includes("unknown injury"), "unknown injury rejected");
  assert(validateIntakeAnswers({ parq_chest_pain: "no" })?.includes("must be true or false"), "a string PAR-Q answer is rejected");
  eq(validateIntakeAnswers({ goal: "recomp", days_per_week: 4, injuries: ["knee"] }), null, "valid answers pass");
});

Deno.test("a coach can never sign a client's waiver", () => {
  const err = validateIntakeAnswers({ legal_signature: "Sam Rivera", legal_accepted_at: "2026-08-26T00:00:00Z" });
  assert(err?.includes("cannot be set on a client's behalf"), "waiver fields must be refused outright");
});

Deno.test("merging never erases answers that were already on file", () => {
  const existing = { goal: "fat_loss", equipment: "full_gym", experience: "beginner", allergies: "peanuts" };
  const merged = mergeIntakeAnswers(existing, { experience: "intermediate", days_per_week: 4 });
  eq(merged.goal, "fat_loss", "untouched keys survive");
  eq(merged.allergies, "peanuts", "including free text");
  eq(merged.experience, "intermediate", "supplied keys are overwritten");
  eq(merged.days_per_week, 4, "new keys are added");
  const cleared = mergeIntakeAnswers(existing, { allergies: null });
  assert(!("allergies" in cleared), "an explicit null clears the key");
});

Deno.test("the waiver is reported without serialising the signature itself", () => {
  const signed = waiverView({
    legal_signature: "A Real Person", legal_accepted_at: "2026-08-01T00:00:00Z",
    legal_version: "v3", legal_docs: ["waiver", "terms"],
  });
  eq(signed.state, "signed", "a signed waiver reads signed");
  eq(signed.signature_on_file, true, "the coach learns one exists");
  assert(!("signature" in signed), "but the characters are never returned");
  eq(waiverView({}).state, "not_signed", "no signature means not signed");
});

Deno.test("the answers blob returned to an AI has the signature stripped", () => {
  const out = redactAnswers({ goal: "recomp", legal_signature: "A Real Person" });
  eq(out.goal, "recomp", "real answers survive");
  assert(!("legal_signature" in out), "the typed legal signature does not");
});
