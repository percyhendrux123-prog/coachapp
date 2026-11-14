// P33 — what a flagged health screen means on the self-serve plan. Browser twin of
// supabase/functions/_shared/parq.ts (classifyFlags, normalizeMedications' table and the
// statement version). healthHold.parity.test.ts keeps the two in step; the SQL twin is
// self_serve_doctor_first_flags() in migrations/20261114120000_health_screen_attestations.sql.
//
// The browser never decides anything: my_health_hold() and attest_my_health_screen() do.
// This file only turns stored flag ids into the words the person reads.
import { PARQ_QUESTIONS } from "../content/parqQuestions.js";

export const DOCTOR_FIRST_FLAGS = [
  "parq_heart_condition", "parq_chest_pain", "parq_dizziness",
  "parq_bone_joint_worsened_by_activity", "parq_bp_or_heart_medication",
  "parq_other_reason_not_to_exercise", "medication_disclosed",
];
export const BLOCKING_FLAGS = ["pregnancy", "eating_disorder_history"];

export function classifyFlags(flags) {
  const out = { blocking: [], doctor_first: [] };
  for (const f of Array.isArray(flags) ? flags : []) {
    const id = String(f);
    if (DOCTOR_FIRST_FLAGS.includes(id)) out.doctor_first.push(id);
    else out.blocking.push(id);
  }
  return out;
}

export const HEALTH_STATEMENT_VERSION = "2026-11-14.1";
export const HEALTH_STATEMENT_LINES = [
  "I talked to a doctor or licensed health professional about each item above.",
  "They told me I can train without supervision and change how I eat.",
  "I understand this plan is general fitness and nutrition education. It is not medical advice, and nobody reviewed my answers.",
];

// Stored flag id → the question field it came from (intake-submit/mealMacros.ts computeHealthFlags).
const FLAG_FIELD = {
  parq_heart_condition: "parq_heart_condition",
  parq_chest_pain: "parq_chest_pain",
  parq_dizziness: "parq_dizziness",
  parq_bone_joint_worsened_by_activity: "parq_bone_joint",
  parq_bp_or_heart_medication: "parq_bp_meds",
  parq_other_reason_not_to_exercise: "parq_other_reason",
  pregnancy: "pregnant",
  eating_disorder_history: "eating_disorder_history",
};
export const MEDICATION_ITEM = "You listed a medication";

// {items} in W4: the question text the person said yes to. Flag ids never appear on screen;
// an id this table does not know shows as a plain "Another answer on your health screen".
export function flagItems(flags) {
  const items = [];
  for (const f of Array.isArray(flags) ? flags : []) {
    if (f === "medication_disclosed") { items.push(MEDICATION_ITEM); continue; }
    const q = PARQ_QUESTIONS.find((p) => p.field === FLAG_FIELD[f]);
    items.push(q ? q.label.replace(/\?\s*$/, "") : "Another answer on your health screen");
  }
  return [...new Set(items)];
}

// The doctor-first form may submit only with all three boxes ticked and a name typed
// (same 2-120 rule the database enforces after trimming).
export function canConfirm({ checks, name }) {
  const n = String(name ?? "").trim();
  return Array.isArray(checks) && checks.length === HEALTH_STATEMENT_LINES.length && checks.every(Boolean)
    && n.length >= 2 && n.length <= 120;
}
