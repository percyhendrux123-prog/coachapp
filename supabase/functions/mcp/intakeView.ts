// Pure read-side views over an intake_forms.answers blob, and the write-side validation for
// coach-keyed intake. No I/O, so the rules are testable.
//
// The Onboarding tab a coach sees in the app is intake_forms (src/pages/CoachClients.jsx ->
// getClientIntakes -> intake_forms where status='submitted'). The answers a coach could not
// read from an AI tool call — experience, equipment, availability, goals — are keys inside
// that jsonb. This file names them explicitly so nothing gets read by guessing.
//
// THE RULE: a question that was never answered reads as null and is listed as unanswered.
// It is never coerced to false, never defaulted, never rounded to "no". On a PAR-Q that
// distinction is the difference between "they said they have no heart condition" and
// "nobody asked".

// ---------- vocabularies (mirror src/pages/Intake.jsx) ----------
export const GOALS = ["fat_loss", "muscle_gain", "recomp", "maintain"] as const;
export const EQUIPMENT = ["full_gym", "home_basic", "bodyweight"] as const;
export const EXPERIENCE = ["beginner", "intermediate", "advanced"] as const;
export const INJURIES = ["none", "knee", "shoulder", "lower_back", "elbow", "wrist"] as const;
export const DAYS_PER_WEEK_MIN = 3;
export const DAYS_PER_WEEK_MAX = 6;

// The eight health-screen questions. Same list and same order as
// supabase/functions/intake-submit/mealMacros.ts PARQ_FIELDS — kept in step deliberately so
// the coach-facing read and the generator's hard gate can never disagree about what was asked.
export const PARQ_FIELDS = [
  "parq_heart_condition", "parq_chest_pain", "parq_dizziness", "parq_bone_joint",
  "parq_bp_meds", "parq_other_reason", "pregnant", "eating_disorder_history",
] as const;

export const PARQ_QUESTIONS: Record<string, string> = {
  parq_heart_condition: "Heart condition diagnosed by a doctor",
  parq_chest_pain: "Chest pain during physical activity",
  parq_dizziness: "Loses balance from dizziness / has lost consciousness",
  parq_bone_joint: "Bone or joint problem made worse by activity",
  parq_bp_meds: "Currently on blood-pressure or heart medication",
  parq_other_reason: "Any other reason not to do physical activity",
  pregnant: "Pregnant, or pregnant in the last 6 months",
  eating_disorder_history: "History of disordered eating",
};

// Keys the training/nutrition generator will refuse without. Coaching cannot be
// programmed around a guess at any of these.
export const REQUIRED_PROGRAMMING_KEYS = ["goal", "equipment", "experience", "days_per_week"] as const;
export const REQUIRED_BODY_KEYS = ["sex", "age", "height_cm", "weight_kg"] as const;

// Free-text / optional context the coach reads but nothing computes on.
export const CONTEXT_KEYS = [
  "injuries", "allergies", "medications", "meals_per_day", "cardio_regimen",
  "competition_history", "diet_notes", "dietary_style", "goal_weight_kg", "unit_pref",
] as const;

type Answers = Record<string, unknown>;

const present = (v: unknown) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0);

// ---------- PAR-Q ----------
export type ParqView = {
  answered: number;
  total: number;
  complete: boolean;
  responses: Array<{ key: string; question: string; answer: boolean | null }>;
  flagged: string[];
  unanswered: string[];
  medications: string | null;
  medications_state: "disclosed" | "none_stated" | "not_asked";
};

export function parqView(answers: Answers | null | undefined): ParqView {
  const a = answers ?? {};
  const responses = PARQ_FIELDS.map((key) => ({
    key,
    question: PARQ_QUESTIONS[key],
    // Explicitly three-valued. `null` means the question was never answered — it is NOT "no".
    answer: typeof a[key] === "boolean" ? (a[key] as boolean) : null,
  }));
  const meds = typeof a.medications === "string" ? a.medications.trim() : "";
  return {
    answered: responses.filter((r) => r.answer !== null).length,
    total: PARQ_FIELDS.length,
    complete: responses.every((r) => r.answer !== null),
    responses,
    flagged: responses.filter((r) => r.answer === true).map((r) => r.key),
    unanswered: responses.filter((r) => r.answer === null).map((r) => r.key),
    medications: meds || null,
    medications_state: meds ? "disclosed" : ("medications" in a ? "none_stated" : "not_asked"),
  };
}

// ---------- completeness ----------
export type IntakeCompleteness = {
  missing_programming: string[];
  missing_body_metrics: string[];
  missing_parq: string[];
  programmable: boolean;
};

/**
 * What is absent, named. Body metrics fall back to the client's profile row, because
 * generate_program_draft reads them from there too — a metric on file is not missing just
 * because this particular intake did not restate it.
 */
export function intakeCompleteness(answers: Answers | null | undefined, profile: Answers | null | undefined = null): IntakeCompleteness {
  const a = answers ?? {};
  const p = profile ?? {};
  const missing_programming = REQUIRED_PROGRAMMING_KEYS.filter((k) => !present(a[k]));
  const missing_body_metrics = REQUIRED_BODY_KEYS.filter((k) => !present(a[k]) && !present(p[k]));
  const missing_parq = parqView(a).unanswered;
  return {
    missing_programming,
    missing_body_metrics,
    missing_parq,
    programmable: missing_programming.length === 0 && missing_body_metrics.length === 0 && missing_parq.length === 0,
  };
}

// ---------- waiver / legal ----------
export type WaiverView = {
  state: "signed" | "not_signed";
  version: string | null;
  signed_at: string | null;
  signature_on_file: boolean;
  documents: string[];
};

export function waiverView(answers: Answers | null | undefined): WaiverView {
  const a = answers ?? {};
  const sig = typeof a.legal_signature === "string" ? a.legal_signature.trim() : "";
  const signed = Boolean(sig) && Boolean(a.legal_accepted_at);
  return {
    state: signed ? "signed" : "not_signed",
    version: typeof a.legal_version === "string" ? a.legal_version : null,
    signed_at: typeof a.legal_accepted_at === "string" ? a.legal_accepted_at : null,
    // The signature itself is a person's name typed as a legal act. Report that one exists;
    // do not serialize it into an AI transcript.
    signature_on_file: Boolean(sig),
    documents: Array.isArray(a.legal_docs) ? (a.legal_docs as string[]) : [],
  };
}

// A typed legal signature is a person's name given as a legal act. The coach needs to know one
// exists (waiverView.signature_on_file); nothing needs the characters, least of all a model
// transcript on a third-party service. Same for the raw acceptance record.
const REDACTED_ANSWER_KEYS = new Set(["legal_signature"]);

/** The answers blob minus anything that should never leave the database as text. */
export function redactAnswers(answers: Answers | null | undefined): Answers {
  const out: Answers = {};
  for (const [k, v] of Object.entries(answers ?? {})) {
    if (!REDACTED_ANSWER_KEYS.has(k)) out[k] = v;
  }
  return out;
}

// ---------- coach-keyed intake validation ----------
/**
 * Validates answers a coach is keying in on a client's behalf. Returns an error string, or
 * null. Refuses unknown enum values rather than storing them — a stored "fatloss" would read
 * as a real answer to every downstream consumer and quietly generate nothing.
 */
export function validateIntakeAnswers(answers: Answers): string | null {
  // A waiver signature is the client's own legal act. A coach keying in intake on someone's
  // behalf must never be able to write one — that is forgery with a tool name on it.
  const legal = Object.keys(answers).filter((k) => k.startsWith("legal_"));
  if (legal.length) {
    return `legal/waiver fields cannot be set on a client's behalf (${legal.join(", ")}). ` +
      "The client signs the waiver themselves through the intake form.";
  }
  const enums: Array<[string, readonly string[]]> = [
    ["goal", GOALS], ["equipment", EQUIPMENT], ["experience", EXPERIENCE],
  ];
  for (const [key, allowed] of enums) {
    if (key in answers && answers[key] != null && !allowed.includes(String(answers[key]))) {
      return `${key} must be one of: ${allowed.join(", ")} (got "${String(answers[key])}")`;
    }
  }
  if ("days_per_week" in answers && answers.days_per_week != null) {
    const n = Number(answers.days_per_week);
    if (!Number.isInteger(n) || n < DAYS_PER_WEEK_MIN || n > DAYS_PER_WEEK_MAX) {
      return `days_per_week must be an integer ${DAYS_PER_WEEK_MIN}–${DAYS_PER_WEEK_MAX}`;
    }
  }
  if ("injuries" in answers && answers.injuries != null) {
    if (!Array.isArray(answers.injuries)) return "injuries must be an array";
    const bad = (answers.injuries as unknown[]).map(String).filter((i) => !INJURIES.includes(i as never));
    if (bad.length) return `unknown injury value(s): ${bad.join(", ")}. Allowed: ${INJURIES.join(", ")}`;
  }
  for (const key of PARQ_FIELDS) {
    if (key in answers && answers[key] != null && typeof answers[key] !== "boolean") {
      return `${key} must be true or false — omit it entirely if it was not asked, but never send a placeholder`;
    }
  }
  return null;
}

/**
 * Merge, never replace. Keying in three fields must not erase the five already on file.
 * An explicit null clears a key; an absent key leaves it alone.
 */
export function mergeIntakeAnswers(existing: Answers | null | undefined, incoming: Answers): Answers {
  const out: Answers = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}
