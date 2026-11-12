import test from "node:test";
import assert from "node:assert/strict";
import { nextAction, statusLine, isStuck, actionOwner, indexFacts, ACTION_ORDER } from "./onboardingFacts.js";

const base = {
  program_live: false, intake_state: "none", draft_state: "none", nutrition_state: "none",
  invite_state: "none", opened_app: false, first_set_logged: false, stalled_days: 0, client_status: "active",
};
const f = (over) => ({ ...base, ...over });

test("precedence: intake first, in order none → expired → pending, only while no program is live", () => {
  assert.equal(nextAction(f({})), "send_intake");
  assert.equal(nextAction(f({ intake_state: "expired" })), "intake_expired_resend");
  assert.equal(nextAction(f({ intake_state: "pending" })), "awaiting_client_intake");
  assert.equal(nextAction(f({ intake_state: "submitted", draft_state: "draft" })), "review_draft");
  assert.equal(nextAction(f({ intake_state: "submitted", draft_state: "held_medical" })), "review_draft");
});

test("a live program is never sent back to intake — an old expired form is not the blocker", () => {
  const live = f({ program_live: true, intake_state: "expired", nutrition_state: "assigned", invite_state: "claimed", opened_app: true });
  assert.equal(nextAction(live), "awaiting_first_set");
  assert.equal(nextAction(f({ ...live, first_set_logged: true })), "onboarded");
});

test("precedence after the program is live: nutrition → invite → open → first set → onboarded", () => {
  const live = { program_live: true, intake_state: "submitted" };
  assert.equal(nextAction(f({ ...live })), "assemble_nutrition");
  assert.equal(nextAction(f({ ...live, nutrition_state: "draft" })), "release");
  assert.equal(nextAction(f({ ...live, nutrition_state: "assigned" })), "send_invite");
  assert.equal(nextAction(f({ ...live, nutrition_state: "declined" })), "send_invite"); // D6
  assert.equal(nextAction(f({ ...live, nutrition_state: "assigned", invite_state: "expired" })), "invite_expired_resend");
  assert.equal(nextAction(f({ ...live, nutrition_state: "assigned", invite_state: "pending" })), "awaiting_client_claim");
  assert.equal(nextAction(f({ ...live, nutrition_state: "assigned", invite_state: "claimed" })), "awaiting_first_open");
  assert.equal(nextAction(f({ ...live, nutrition_state: "assigned", invite_state: "claimed", opened_app: true })), "awaiting_first_set");
  assert.equal(nextAction(f({ ...live, nutrition_state: "assigned", invite_state: "claimed", opened_app: true, first_set_logged: true })), "onboarded");
});

test("no program, intake submitted, no draft → unclassified, never a guess", () => {
  assert.equal(nextAction(f({ intake_state: "submitted" })), "unclassified");
  assert.equal(statusLine({ next_action: "unclassified" }), "Position unclear — read the row");
});

test("every action in ACTION_ORDER has an owner and a status line", () => {
  for (const a of ACTION_ORDER) {
    assert.notEqual(actionOwner(a), "unknown", a);
    assert.notEqual(statusLine({ next_action: a, stalled_days: 2 }), "Status unknown", a);
  }
});

test("status line says how long, and says 'today' for 0 days", () => {
  assert.equal(statusLine({ next_action: "awaiting_client_intake", stalled_days: 5 }), "Intake sent 5 days ago, not submitted");
  assert.equal(statusLine({ next_action: "awaiting_client_intake", stalled_days: 1 }), "Intake sent 1 day ago, not submitted");
  assert.equal(statusLine({ next_action: "release", stalled_days: 0 }), "Nutrition drafted today, not released");
  assert.equal(statusLine(null), "Status not loaded");
});

test("stuck = not onboarded, not paused, 3+ days unchanged", () => {
  assert.equal(isStuck({ next_action: "awaiting_first_set", stalled_days: 3, client_status: "active" }), true);
  assert.equal(isStuck({ next_action: "awaiting_first_set", stalled_days: 2, client_status: "active" }), false);
  assert.equal(isStuck({ next_action: "onboarded", stalled_days: 40, client_status: "active" }), false);
  assert.equal(isStuck({ next_action: "awaiting_first_set", stalled_days: 40, client_status: "paused" }), false);
  assert.equal(isStuck(null), false);
});

test("indexFacts: a failed read is null, never an empty map", () => {
  assert.equal(indexFacts(null), null);
  assert.equal(indexFacts(undefined), null);
  const m = indexFacts([{ client_id: "a", next_action: "onboarded" }]);
  assert.equal(m.get("a").next_action, "onboarded");
  assert.equal(indexFacts([]).size, 0);
});
