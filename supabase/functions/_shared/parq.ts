// The health screen for the self-serve plan. Same keys the intake generator gates on
// (intake-submit/mealMacros.ts PARQ_FIELDS) plus free-text medications. Rules:
//   * every key must be a real boolean — null/undefined/"false" is MISSING, not "no";
//   * any true, or any medications text that is not a plain "none", is a FLAG.
//
// P33 (2026-11-14): the self-serve plan has no coach, so nobody here reviews a flag. A fixed
// table decides what a flag means on the self-serve plan:
//   * doctor first — no plan until the signed-in person confirms their own doctor (or another
//     licensed health professional) told them unsupervised training and a diet change are
//     fine; then a conservative plan is built (intake-submit/generate.ts);
//   * blocking — no self-serve plan is ever built (pregnancy, eating-disorder history);
//   * any flag id this table does not know is blocking (fail closed).
// The SQL twin is self_serve_doctor_first_flags() / self_serve_blocking_flags() in
// migrations/20261114120000_health_screen_attestations.sql; the browser twin is
// src/lib/healthHold.js. healthHold.parity.test.ts pins the TS and JS twins together and
// supabase/tests/health_screen_attestation.test.sql pins the SQL twin to the same lists.
export const PARQ_KEYS = [
  "parq_heart_condition", "parq_chest_pain", "parq_dizziness", "parq_bone_joint",
  "parq_bp_meds", "parq_other_reason", "pregnant", "eating_disorder_history",
] as const;
export const MEDICATIONS_KEY = "medications";
export const MEDICATIONS_MAX = 400;

// Stored flag ids, exactly as computeHealthFlags (intake-submit/mealMacros.ts) writes them.
export const DOCTOR_FIRST_FLAGS = [
  "parq_heart_condition", "parq_chest_pain", "parq_dizziness",
  "parq_bone_joint_worsened_by_activity", "parq_bp_or_heart_medication",
  "parq_other_reason_not_to_exercise", "medication_disclosed",
] as const;
export const BLOCKING_FLAGS = ["pregnancy", "eating_disorder_history"] as const;

export type FlagClasses = { blocking: string[]; doctor_first: string[] };

// Splits stored flags into the two groups. Anything not in DOCTOR_FIRST_FLAGS — a known
// blocking flag or an id this table has never seen — is blocking.
export function classifyFlags(flags: unknown): FlagClasses {
  const out: FlagClasses = { blocking: [], doctor_first: [] };
  for (const f of Array.isArray(flags) ? flags : []) {
    const id = String(f);
    if ((DOCTOR_FIRST_FLAGS as readonly string[]).includes(id)) out.doctor_first.push(id);
    else out.blocking.push(id);
  }
  return out;
}

// Which message a blocked screen shows. One message only; both mean "no self-serve plan".
export function blockedReason(flags: unknown): "pregnancy" | "eating_disorder_history" | "other" | null {
  const { blocking } = classifyFlags(flags);
  if (blocking.length === 0) return null;
  if (blocking.includes("eating_disorder_history")) return "eating_disorder_history";
  if (blocking.includes("pregnancy")) return "pregnancy";
  return "other";
}

// "Leave it blank if you take none" — but people type "none". Only a plain "none" word
// (after trim, lowercase, spaces and punctuation removed) counts as blank; anything else is
// kept exactly as written and flags. "none, just lisinopril" is kept.
export const MEDICATIONS_NONE_WORDS = ["none", "no", "n/a", "na", "nil", "nothing", "-"] as const;
export function normalizeMedications(text: unknown): string {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return "";
  const key = t.toLowerCase().replace(/[\s.,;:!?'"()]+/g, "");
  if ((MEDICATIONS_NONE_WORDS as readonly string[]).includes(key)) return "";
  return t;
}

// The statement a person confirms on the doctor-first hold screen. The version is stored with
// every attestation and the SQL function refuses any other version. Change the text, bump the
// version, in all three twins.
export const HEALTH_STATEMENT_VERSION = "2026-11-14.1";
export const HEALTH_STATEMENT_LINES = [
  "I talked to a doctor or licensed health professional about each item above.",
  "They told me I can train without supervision and change how I eat.",
  "I understand this plan is general fitness and nutrition education. It is not medical advice, and nobody reviewed my answers.",
] as const;

export type ScreenOutcome =
  | { ok: true; flags: [] }
  | { ok: false; missing: string[]; flags: string[] };

export function screenOutcome(a: Record<string, unknown>): ScreenOutcome {
  const missing: string[] = [];
  const flags: string[] = [];
  for (const k of PARQ_KEYS) {
    const v = a?.[k];
    if (v !== true && v !== false) { missing.push(k); continue; }
    if (v === true) flags.push(k);
  }
  if (normalizeMedications(a?.[MEDICATIONS_KEY]).length > 0) flags.push("medication_disclosed");
  if (missing.length === 0 && flags.length === 0) return { ok: true, flags: [] };
  return { ok: false, missing, flags };
}

// The answers as stored for the record (same keys as the intake), medications capped.
export function screenAnswersForIntake(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PARQ_KEYS) out[k] = a[k];
  const meds = normalizeMedications(a?.[MEDICATIONS_KEY]).slice(0, MEDICATIONS_MAX);
  if (meds) out[MEDICATIONS_KEY] = meds;
  return out;
}
