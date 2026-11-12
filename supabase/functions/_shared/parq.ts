// The pre-pay health screen for the self-serve plan. Same keys the intake generator gates on
// (intake-submit/mealMacros.ts PARQ_FIELDS) plus free-text medications. Rules:
//   * every key must be a real boolean — null/undefined/"false" is MISSING, not "no";
//   * any true, or any medications text, is a FLAG; a flagged buyer is not charged and
//     is pointed to coaching (spec §2.1 item 1) — this module never softens that.
export const PARQ_KEYS = [
  "parq_heart_condition", "parq_chest_pain", "parq_dizziness", "parq_bone_joint",
  "parq_bp_meds", "parq_other_reason", "pregnant", "eating_disorder_history",
] as const;
export const MEDICATIONS_KEY = "medications";
export const MEDICATIONS_MAX = 400;

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
  const meds = typeof a?.[MEDICATIONS_KEY] === "string" ? (a[MEDICATIONS_KEY] as string).trim() : "";
  if (meds.length > 0) flags.push("medication_disclosed");
  if (missing.length === 0 && flags.length === 0) return { ok: true, flags: [] };
  return { ok: false, missing, flags };
}

// The answers as stored for the record (same keys as the intake), medications capped.
export function screenAnswersForIntake(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PARQ_KEYS) out[k] = a[k];
  const meds = typeof a?.[MEDICATIONS_KEY] === "string" ? (a[MEDICATIONS_KEY] as string).trim().slice(0, MEDICATIONS_MAX) : "";
  if (meds) out[MEDICATIONS_KEY] = meds;
  return out;
}
