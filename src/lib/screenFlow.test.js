import test from "node:test";
import assert from "node:assert/strict";
import {
  answerParq, anyYes, buildScreenAnswers, emptyProgress, firstName, loadProgress, NOTES_STEP,
  PARQ_COUNT, parqComplete, resumeStep, saveProgress, clearProgress, SIGN_STEP,
} from "./screenFlow.js";
import { PARQ_QUESTIONS } from "../content/parqQuestions.js";
import { LEGAL_DOCS, LEGAL_VERSION } from "../content/legalPack.js";
import { linkParts, isSameOrigin } from "./linkify.js";

const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const allAnswered = (v = false) => PARQ_QUESTIONS.reduce((p, _q, i) => answerParq(p, i, v), emptyProgress());

test("PAR-Q wording is unchanged (legal content lock)", () => {
  assert.deepEqual(PARQ_QUESTIONS.map((q) => q.label), [
    "Heart condition / doctor-limited activity?", "Chest pain with activity?",
    "Dizziness or loss of consciousness?", "Bone/joint problem worsened by activity?",
    "Blood pressure or heart medication?", "Any other reason not to exercise?",
    "Pregnant or could be pregnant?", "History of an eating disorder?",
  ]);
  assert.deepEqual(PARQ_QUESTIONS.map((q) => q.field), [
    "parq_heart_condition", "parq_chest_pain", "parq_dizziness", "parq_bone_joint",
    "parq_bp_meds", "parq_other_reason", "pregnant", "eating_disorder_history",
  ]);
});

test("one tap answers and advances; after the eighth, the notes screen", () => {
  let p = emptyProgress();
  p = answerParq(p, 0, false);
  assert.equal(p.step, 1);
  p = allAnswered(false);
  assert.equal(p.step, NOTES_STEP);
  assert.equal(parqComplete(p), true);
  assert.equal(anyYes(p), false);
});

test("non-boolean answers are ignored, never stored as no", () => {
  const p = answerParq(emptyProgress(), 0, "no");
  assert.deepEqual(p.parq, {});
});

test("going back and changing an answer jumps to the next unanswered question", () => {
  let p = answerParq(emptyProgress(), 0, false);
  p = answerParq(p, 1, false);
  p = { ...p, step: 0 };
  p = answerParq(p, 0, true);
  assert.equal(p.step, 2);
  assert.equal(anyYes(p), true);
});

test("resume never lands past an unanswered question", () => {
  const p = { ...answerParq(emptyProgress(), 0, false), step: SIGN_STEP };
  assert.equal(resumeStep(p), 1);
  assert.equal(resumeStep({ ...allAnswered(), step: SIGN_STEP }), SIGN_STEP);
  assert.equal(resumeStep({ ...allAnswered(), step: 99 }), SIGN_STEP);
});

test("progress saves and reloads per token; other tokens do not leak in", () => {
  const s = memStore();
  const p = answerParq(emptyProgress(), 0, true);
  saveProgress(s, "tokenAAAAAAAAAAAAAAAA", p);
  assert.deepEqual(loadProgress(s, "tokenAAAAAAAAAAAAAAAA").parq, { heart: true });
  assert.equal(loadProgress(s, "tokenAAAAAAAAAAAAAAAB"), null);
  clearProgress(s, "tokenAAAAAAAAAAAAAAAA");
  assert.equal(loadProgress(s, "tokenAAAAAAAAAAAAAAAA"), null);
});

test("payload: every PAR-Q field, all legal docs, signature trimmed", () => {
  const a = buildScreenAnswers({ ...allAnswered(false), hasMeds: false, medications: "ignored", injury_notes: " Old knee strain " }, "  Sam Rivera ");
  for (const q of PARQ_QUESTIONS) assert.equal(a[q.field], false);
  assert.equal(Object.keys(a).filter((k) => PARQ_QUESTIONS.some((q) => q.field === k)).length, PARQ_COUNT);
  assert.equal("medications" in a, false, "meds text dropped when the client said no medications");
  assert.equal(a.injury_notes, "Old knee strain");
  assert.equal(a.legal_signature, "Sam Rivera");
  assert.equal(a.legal_version, LEGAL_VERSION);
  assert.deepEqual(a.legal_docs, LEGAL_DOCS.map((d) => d.id));
});

test("medications are sent when the client said yes and wrote them", () => {
  const a = buildScreenAnswers({ ...allAnswered(false), hasMeds: true, medications: " metformin " }, "A B");
  assert.equal(a.medications, "metformin");
});

test("first name", () => {
  assert.equal(firstName("Sam Rivera"), "Sam");
  assert.equal(firstName(""), "");
  assert.equal(firstName(null), "");
});

test("links: http(s) only, trailing punctuation stays text", () => {
  assert.deepEqual(linkParts("Open https://x.app/screen?token=abc. Thanks"), [
    { type: "text", value: "Open " }, { type: "link", value: "https://x.app/screen?token=abc" }, { type: "text", value: ". Thanks" },
  ]);
  assert.deepEqual(linkParts("no links here"), [{ type: "text", value: "no links here" }]);
  assert.deepEqual(linkParts("javascript:alert(1)"), [{ type: "text", value: "javascript:alert(1)" }]);
  assert.equal(isSameOrigin("https://x.app/screen", "https://x.app"), true);
  assert.equal(isSameOrigin("https://evil.app/screen", "https://x.app"), false);
});
