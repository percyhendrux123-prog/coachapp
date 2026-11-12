// Health screen + waiver only ("screen" kind) — the short path for clients who are already
// training and only need the PAR-Q and the signed legal pack on file (most came over from
// Trainerize, where neither was ever asked for in this app).
//
// Rules this module keeps:
//   * PAR-Q answers must be real booleans. null / "no" / undefined is MISSING, not "no".
//   * Any yes, or any medications text, is a health flag. Flags never block the submission
//     (the client did their part); they route the file to coach review instead.
//   * The waiver is the client's own legal act: a signature, a version, the accepted doc ids.
//   * No program draft is ever generated from a screen. The client already has a program.
//   * The new row is the client's latest intake, so it carries forward any earlier answers
//     (body metrics, goal, injuries) — a screen must never make the coach's intake view or
//     the compliance read look emptier than it was.
import { MEDICATIONS_MAX, PARQ_KEYS } from "../_shared/parq.ts";
import { computeHealthFlags } from "./mealMacros.ts";

export const SCREEN_KIND = "screen";
export const INJURY_NOTES_MAX = 400;
export const SIGNATURE_MAX = 120;

type Answers = Record<string, unknown>;

export function screenProblems(a: Answers): { missing_parq: string[]; legal: string[] } {
  const missing_parq = PARQ_KEYS.filter((k) => a?.[k] !== true && a?.[k] !== false);
  const legal: string[] = [];
  const sig = typeof a?.legal_signature === "string" ? a.legal_signature.trim() : "";
  if (!sig) legal.push("legal_signature");
  if (typeof a?.legal_version !== "string" || !a.legal_version) legal.push("legal_version");
  if (!Array.isArray(a?.legal_docs) || a.legal_docs.length === 0) legal.push("legal_docs");
  return { missing_parq, legal };
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Only the keys a screen may set. Anything else the browser sends is dropped, so a screen
// link can never be used to overwrite goal, metrics, or other programming answers.
export function screenAnswers(a: Answers, nowIso: string): Answers {
  const out: Answers = {};
  for (const k of PARQ_KEYS) out[k] = a[k];
  const meds = text(a.medications, MEDICATIONS_MAX);
  if (meds) out.medications = meds;
  const inj = text(a.injury_notes, INJURY_NOTES_MAX);
  if (inj) out.injury_notes = inj;
  out.legal_version = a.legal_version;
  out.legal_signature = text(a.legal_signature, SIGNATURE_MAX);
  out.legal_docs = (a.legal_docs as unknown[]).filter((d) => typeof d === "string");
  out.legal_accepted_at = nowIso; // server time, not the phone's clock
  out.legal_sign_method = "tap_to_sign_confirmed_name";
  out.intake_kind = SCREEN_KIND;
  return out;
}

// Carry earlier answers forward, then lay the fresh screen on top. A previous medications
// note is dropped when this screen has none: the client just answered that question again.
export function mergeScreen(previous: Answers | null | undefined, screen: Answers): Answers {
  const base: Answers = { ...(previous ?? {}) };
  if (!("medications" in screen)) delete base.medications;
  return { ...base, ...screen };
}

export function buildScreenRecord(previous: Answers | null | undefined, raw: Answers, nowIso: string) {
  const answers = mergeScreen(previous, screenAnswers(raw, nowIso));
  const health_flags = computeHealthFlags(answers);
  return { answers, health_flags, needs_review: health_flags.length > 0 };
}
