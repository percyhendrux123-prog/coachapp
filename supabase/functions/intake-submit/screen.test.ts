// deno test supabase/functions/intake-submit/screen.test.ts
import { buildScreenRecord, screenAnswers, screenProblems, SCREEN_KIND } from "./screen.ts";
import { PARQ_KEYS } from "../_shared/parq.ts";

const eq = (a: unknown, b: unknown, m: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(m + ` got ${JSON.stringify(a)}`);
};
const allNo = Object.fromEntries(PARQ_KEYS.map((k) => [k, false]));
const legal = { legal_version: "2026-08-06", legal_signature: "Test Client", legal_docs: ["medical_disclaimer", "parq"] };
const NOW = "2026-10-15T12:00:00.000Z";

Deno.test("complete screen has no problems", () => {
  eq(screenProblems({ ...allNo, ...legal }), { missing_parq: [], legal: [] }, "clean");
});

Deno.test("unanswered or string answers are missing, never defaulted to no", () => {
  const { pregnant: _p, ...rest } = allNo;
  const r = screenProblems({ ...rest, parq_bp_meds: "false", ...legal });
  eq(r.missing_parq, ["parq_bp_meds", "pregnant"], "named");
});

Deno.test("no signature, version, or docs = refused", () => {
  eq(screenProblems({ ...allNo, legal_signature: "  " }).legal, ["legal_signature", "legal_version", "legal_docs"], "legal");
});

Deno.test("all no + no meds → clear, no review", () => {
  const r = buildScreenRecord(null, { ...allNo, ...legal }, NOW);
  eq(r.health_flags, [], "no flags"); eq(r.needs_review, false, "no review");
  eq(r.answers.intake_kind, SCREEN_KIND, "kind");
  eq(r.answers.legal_accepted_at, NOW, "server time");
});

Deno.test("any yes routes to coach review", () => {
  const r = buildScreenRecord(null, { ...allNo, parq_bone_joint: true, ...legal }, NOW);
  eq(r.needs_review, true, "review"); eq(r.health_flags, ["parq_bone_joint_worsened_by_activity"], "flag");
});

Deno.test("medication text alone routes to coach review", () => {
  const r = buildScreenRecord(null, { ...allNo, medications: "  lisinopril ", ...legal }, NOW);
  eq(r.health_flags, ["medication_disclosed"], "meds flag"); eq(r.answers.medications, "lisinopril", "trimmed");
});

Deno.test("injury notes are stored but are not a health flag on their own", () => {
  const r = buildScreenRecord(null, { ...allNo, injury_notes: "Patella repair, 2025", ...legal }, NOW);
  eq(r.answers.injury_notes, "Patella repair, 2025", "stored"); eq(r.needs_review, false, "no flag");
});

Deno.test("a screen link cannot overwrite programming answers", () => {
  const out = screenAnswers({ ...allNo, ...legal, goal: "fat_loss", weight_kg: 1, email: "x@y.z" }, NOW);
  eq(["goal", "weight_kg", "email"].some((k) => k in out), false, "dropped");
});

Deno.test("earlier answers carry forward; fresh screen wins; stale meds note dropped", () => {
  const prev = { goal: "recomp", weight_kg: 90, medications: "old note", parq_chest_pain: true };
  const r = buildScreenRecord(prev, { ...allNo, ...legal }, NOW);
  eq(r.answers.goal, "recomp", "goal kept"); eq(r.answers.weight_kg, 90, "metric kept");
  eq(r.answers.parq_chest_pain, false, "new answer wins"); eq("medications" in r.answers, false, "stale meds dropped");
  eq(r.needs_review, false, "clear");
});
