// P33 — the approved wording for the self-serve health outcomes (W1-W10, approved 2026-11-14,
// "go with your picks"). Change only with the owner's approval. W4's line under the button
// names exactly the conservative knobs intake-submit/generate.ts applies (CONSERVATIVE):
// beginner progression, at most four lifting days, and the smallest calorie change the
// generator has (0.5 lb a week for fat loss; other goals keep the generator's own small
// change). Words that must never appear in these outcomes: see BANNED_OUTCOME_WORDS.

export const W1_FOOTER =
  "This is fitness structure, not medical care. It starts with a health screen. Some answers mean you check with your doctor before a plan is built. Some mean this plan is not built for you.";

export const W2_PARQ_NOTE =
  "Answer every question. A yes does not end this. It means you check with your doctor before a plan is built.";

export const W3_MEDS_LABEL = "Prescription medication";
export const W3_MEDS_HINT =
  "List anything you take. Leave it blank if you take none. Anything listed means a doctor check before your plan is built.";

export const W4 = {
  kicker: "ON HOLD",
  title: "Check with your doctor first.",
  lead: "You answered yes to:",
  body: [
    "That is not a no. It means a doctor, or another licensed health professional who knows your history, should tell you that training on your own and changing how you eat is fine for you.",
    "Nobody here reviews health answers. There is no coach on this plan, and nobody here can clear you.",
    "Your answers are saved. Come back when you have talked to them.",
  ],
  section: "After you have talked to them",
  name_label: "Type your full name",
  button: "Build my plan",
  under_button:
    "Your plan starts conservative: beginner progression, four training days at most, a small calorie change. If anything on your health screen changes, update your numbers and answer it again.",
};

export const W5 = {
  kicker: "NOT THIS PLAN",
  title: "This plan is not built for pregnancy.",
  body: [
    "The training week and calorie targets here are not designed for pregnancy, so no plan was built. Your doctor or midwife is the right person to set what training and eating look like for you right now.",
    "Your account stays. You can run the intake again later.",
  ],
};

export const W6 = {
  kicker: "NOT THIS PLAN",
  title: "This plan is not the right tool.",
  body: [
    "You told us you have a history of an eating disorder. This plan sets calorie and macro targets and asks you to track food and body weight. For some people with that history, that kind of tracking does harm. So no plan was built.",
    "A doctor, a registered dietitian, or a licensed therapist who knows your history is the right person to decide what structure fits you.",
    "If you are in crisis or feel unsafe, call your local emergency number.",
  ],
};

// A flag id the table does not know (fail closed). Not in the approved set: it reuses W5/W6's
// shape with no medical content, so no new health wording is introduced.
export const W_OTHER = {
  kicker: "NOT THIS PLAN",
  title: "This plan is not built for one of your answers.",
  body: ["No plan was built. Your account stays. You can run the intake again later."],
};

export const W7_BUILT = "Your week is built. It starts conservative. Sign in with the email you used and open Program.";

export const W8_REMINDER = "Reminder: this is not medical care. If symptoms arise, stop and contact a clinician.";

export const W10_BANNER =
  "Your latest health screen has a yes on it. This plan was built before that answer. Check with your doctor before you keep following it.";

// Approved W4 states "There is no coach on this plan" — the only allowed use of the word,
// as a plain fact. Every other self-serve health outcome must avoid these words.
export const BANNED_OUTCOME_WORDS = ["coach", "coaching", "charged", "receipt", "cleared", "safe", "approved", "diagnose"];
export const ALLOWED_COACH_SENTENCE = "There is no coach on this plan";

export function blockedCopy(reason) {
  if (reason === "pregnancy") return W5;
  if (reason === "eating_disorder_history") return W6;
  return W_OTHER;
}
