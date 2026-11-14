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

// ---------- P33: the self-serve flag table and "none" in the medications field ----------
import { BLOCKING_FLAGS, blockedReason, classifyFlags, DOCTOR_FIRST_FLAGS, normalizeMedications } from "./parq.ts";

Deno.test("each known flag lands in the right group", () => {
  for (const f of DOCTOR_FIRST_FLAGS) eq(classifyFlags([f]), { blocking: [], doctor_first: [f] }, f);
  for (const f of BLOCKING_FLAGS) eq(classifyFlags([f]), { blocking: [f], doctor_first: [] }, f);
});
Deno.test("a mixed screen keeps both groups; the blocking reason wins", () => {
  const c = classifyFlags(["parq_chest_pain", "pregnancy", "medication_disclosed"]);
  eq(c, { blocking: ["pregnancy"], doctor_first: ["parq_chest_pain", "medication_disclosed"] }, "mixed");
  eq(blockedReason(["parq_chest_pain", "pregnancy"]), "pregnancy", "pregnancy reason");
  eq(blockedReason(["pregnancy", "eating_disorder_history"]), "eating_disorder_history", "one message: eating-disorder text");
  eq(blockedReason(["parq_chest_pain"]), null, "doctor-first only is not blocked");
});
Deno.test("an unknown flag id is blocking (fail closed)", () => {
  eq(classifyFlags(["parq_something_new"]), { blocking: ["parq_something_new"], doctor_first: [] }, "unknown");
  eq(blockedReason(["parq_something_new"]), "other", "reason other");
  // The raw answer keys are not stored flag ids: they are unknown here, so they block.
  eq(classifyFlags(["parq_bone_joint"]).blocking, ["parq_bone_joint"], "raw key is not a stored id");
});
Deno.test("normalizeMedications: plain none words are blank", () => {
  for (const t of ["none", " N/A ", "No.", "na", "nil", "Nothing", "-", "  ", ""]) eq(normalizeMedications(t), "", JSON.stringify(t));
});
Deno.test("normalizeMedications: anything else is kept as written", () => {
  eq(normalizeMedications("none, just lisinopril"), "none, just lisinopril", "kept");
  eq(normalizeMedications("0.5mg x"), "0.5mg x", "kept");
  eq(normalizeMedications(" metformin "), "metformin", "trimmed only");
  eq(normalizeMedications(null), "", "null");
});
Deno.test("screenOutcome: 'none' in medications is not a flag", () => {
  eq(screenOutcome({ ...allNo, medications: "None." }), { ok: true, flags: [] }, "clear");
});

Deno.test("normalizeMedications: a non-string value is never dropped (fail closed)", () => {
  for (const v of [["lisinopril"], 5, { n: "x" }, true, false, []]) {
    if (normalizeMedications(v) === "") throw new Error("dropped " + JSON.stringify(v));
    eq(screenOutcome({ ...allNo, medications: v } as any).ok, false, "flags " + JSON.stringify(v));
  }
  eq(normalizeMedications(undefined), "", "undefined is blank");
});
