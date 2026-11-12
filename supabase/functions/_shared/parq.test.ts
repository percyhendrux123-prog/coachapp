// deno test supabase/functions/_shared/parq.test.ts
import { screenOutcome, screenAnswersForIntake, PARQ_KEYS } from "./parq.ts";
const allNo = Object.fromEntries(PARQ_KEYS.map((k) => [k, false]));
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m + ` got ${JSON.stringify(a)}`); };

Deno.test("all no → clear", () => eq(screenOutcome({ ...allNo, medications: "" }), { ok: true, flags: [] }, "clear"));
Deno.test("a single yes → flagged, named", () => {
  const r = screenOutcome({ ...allNo, parq_chest_pain: true });
  eq(r.ok, false, "not ok"); eq((r as any).flags, ["parq_chest_pain"], "flag named");
});
Deno.test("null is not no — missing keys are named, never defaulted", () => {
  const { parq_dizziness: _drop, ...partial } = allNo;
  const r = screenOutcome(partial);
  eq(r.ok, false, "not ok"); eq((r as any).missing, ["parq_dizziness"], "missing named");
});
Deno.test("medications text is a flag, not a refusal reason by itself", () => {
  const r = screenOutcome({ ...allNo, medications: "lisinopril" });
  eq(r.ok, false, "flagged"); eq((r as any).flags, ["medication_disclosed"], "flag");
});
Deno.test("string 'false' is not a boolean no", () => {
  const r = screenOutcome({ ...allNo, pregnant: "false" });
  eq(r.ok, false, "refused"); eq((r as any).missing, ["pregnant"], "typed wrong");
});
Deno.test("stored answers carry only the screen keys, medications capped, never extra fields", () => {
  const out = screenAnswersForIntake({ ...allNo, medications: "x".repeat(500), email: "leak@example.com" });
  eq(Object.keys(out).length, PARQ_KEYS.length + 1, "keys");
  eq((out.medications as string).length, 400, "capped");
  eq("email" in out, false, "no stray fields");
});
