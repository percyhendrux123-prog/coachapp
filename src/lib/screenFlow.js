// Pure logic for the short health-screen + waiver page (/screen?token=…). No React, no
// network, so it runs under `node --test`.
//
// Flow: eight yes/no questions, one per screen (a tap answers and moves on), one optional
// notes screen, then one tap to sign. Progress is saved on the phone after every tap so a
// client who gets interrupted lands back on the question they were on.
import { PARQ_QUESTIONS } from "../content/parqQuestions.js";
import { LEGAL_DOCS, LEGAL_VERSION } from "../content/legalPack.js";

export const PARQ_COUNT = PARQ_QUESTIONS.length;
export const NOTES_STEP = PARQ_COUNT; // after the last question
export const SIGN_STEP = PARQ_COUNT + 1;
export const TOTAL_STEPS = PARQ_COUNT + 2;

export const emptyProgress = () => ({ step: 0, parq: {}, medications: "", injury_notes: "", hasMeds: null });

export function firstName(displayName) {
  const s = String(displayName ?? "").trim();
  return s ? s.split(/\s+/)[0] : "";
}

// Answer question `index` and move to the next unanswered screen.
export function answerParq(p, index, value) {
  const q = PARQ_QUESTIONS[index];
  if (!q || typeof value !== "boolean") return p;
  const parq = { ...p.parq, [q.key]: value };
  return { ...p, parq, step: nextStep({ ...p, parq }, index) };
}

function nextStep(p, fromIndex) {
  for (let i = fromIndex + 1; i < PARQ_COUNT; i++) if (typeof p.parq[PARQ_QUESTIONS[i].key] !== "boolean") return i;
  for (let i = 0; i <= fromIndex; i++) if (typeof p.parq[PARQ_QUESTIONS[i].key] !== "boolean") return i;
  return NOTES_STEP;
}

export const parqAnswered = (p) => PARQ_QUESTIONS.filter((q) => typeof p.parq?.[q.key] === "boolean").length;
export const parqComplete = (p) => parqAnswered(p) === PARQ_COUNT;
export const anyYes = (p) => PARQ_QUESTIONS.some((q) => p.parq?.[q.key] === true);

// Where a returning client should land. Never past the questions while one is unanswered.
export function resumeStep(p) {
  const step = Number.isInteger(p?.step) ? p.step : 0;
  if (!parqComplete(p)) {
    const first = PARQ_QUESTIONS.findIndex((q) => typeof p.parq?.[q.key] !== "boolean");
    return Math.min(step, first);
  }
  return Math.max(0, Math.min(step, SIGN_STEP));
}

// The answers the server's screen kind accepts. Every legal doc is accepted in one act.
export function buildScreenAnswers(p, signature) {
  const answers = {};
  for (const q of PARQ_QUESTIONS) answers[q.field] = p.parq[q.key];
  const meds = p.hasMeds ? String(p.medications ?? "").trim() : "";
  if (meds) answers.medications = meds;
  const inj = String(p.injury_notes ?? "").trim();
  if (inj) answers.injury_notes = inj;
  answers.legal_version = LEGAL_VERSION;
  answers.legal_signature = String(signature ?? "").trim();
  answers.legal_docs = LEGAL_DOCS.map((d) => d.id);
  return answers;
}

// ── Saved progress (localStorage on the client's own phone) ──
const keyFor = (token) => `coachapp.screen.v1.${String(token).slice(0, 16)}`;

export function loadProgress(storage, token) {
  try {
    const raw = storage?.getItem(keyFor(token));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v?.token !== token || typeof v.progress !== "object") return null;
    return { ...emptyProgress(), ...v.progress };
  } catch { return null; }
}

export function saveProgress(storage, token, progress) {
  try { storage?.setItem(keyFor(token), JSON.stringify({ token, progress, saved_at: Date.now() })); } catch { /* private mode: no resume, still works */ }
}

export function clearProgress(storage, token) {
  try { storage?.removeItem(keyFor(token)); } catch { /* ignore */ }
}
