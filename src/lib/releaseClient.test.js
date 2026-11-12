import test from "node:test";
import assert from "node:assert/strict";
import { checklistLines, isReadyToRelease, offerNoNutrition, releaseOutcomeLine, refusalText, runRelease } from "./releaseChecklist.js";

const chk = (o = {}) => ({
  program: { ok: true, state: "draft", detail: "Program draft (5 days)" },
  nutrition: { ok: true, state: "draft", detail: "Nutrition (21 meals)" },
  email: { ok: true, state: "valid", detail: "Email client@example.com" },
  health: { ok: true, state: "clear", detail: "Health screen clear" },
  ...o,
});

test("lines render the four items in order with the database's own wording", () => {
  const lines = checklistLines(chk());
  assert.deepEqual(lines.map((l) => l.ok), [true, true, true, true]);
  assert.deepEqual(lines.map((l) => l.label), ["Program draft (5 days)", "Nutrition (21 meals)", "Email client@example.com", "Health screen clear"]);
});

test("a failed checklist read is never four green ticks", () => {
  const lines = checklistLines(null);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ok, null);
  assert.equal(isReadyToRelease(null), false);
});

test("ready only when every item is ok; health is fail-closed when absent", () => {
  assert.equal(isReadyToRelease(chk()), true);
  assert.equal(isReadyToRelease(chk({ email: { ok: false, state: "invalid", detail: "Email looks invalid: nope" } })), false);
  assert.equal(isReadyToRelease(chk({ program: { ok: false, state: "held_medical", detail: "Program draft held for medical review" } })), false);
  assert.equal(isReadyToRelease(chk({ health: { ok: false, state: "flagged", detail: "Health screen flagged (parq_chest_pain)" } })), false);
  assert.equal(isReadyToRelease(chk({ health: { ok: false, state: "no_screen", detail: "No health screen on record" } })), false);
  const noHealthKey = chk(); delete noHealthKey.health;
  assert.equal(isReadyToRelease(noHealthKey), false);
  assert.equal(checklistLines(noHealthKey)[3].label, "Health screen: not readable");
});

test("D6: the no-nutrition tick satisfies nutrition only when nothing exists, and is only offered then", () => {
  const none = chk({ nutrition: { ok: false, state: "none", detail: "No nutrition plan" } });
  assert.equal(offerNoNutrition(none), true);
  assert.equal(isReadyToRelease(none), false);
  assert.equal(isReadyToRelease(none, { noNutrition: true }), true);
  assert.equal(checklistLines(none, { noNutrition: true })[1].label, "No nutrition plan for this client (your choice)");
  const empty = chk({ nutrition: { ok: false, state: "empty_draft", detail: "Nutrition draft has no meals" } });
  assert.equal(offerNoNutrition(empty), false);
  assert.equal(isReadyToRelease(empty, { noNutrition: true }), false);
  assert.equal(offerNoNutrition(chk()), false);
});

test("outcome line names what happened", () => {
  assert.equal(releaseOutcomeLine({ status: "released", program: { action: "published" }, nutrition: { action: "assigned" }, invite: { already_claimed: false } }),
    "Released: program published, nutrition assigned, invite ready.");
  assert.equal(releaseOutcomeLine({ status: "released", program: { action: "already_live" }, nutrition: { action: "declined" }, invite: { already_claimed: true } }),
    "Released: program already live, no nutrition, recorded, client already has the app.");
  assert.equal(releaseOutcomeLine(null), "Not released.");
});

test("refusal text strips the RPC prefix and keeps the named item", () => {
  assert.equal(refusalText(new Error("release refused: Email missing")), "Email missing");
  assert.equal(refusalText(new Error("network down")), "network down");
});

// ---- the Release sequence: never silently partial ----
function harness(over = {}) {
  const calls = [];
  const deps = {
    prepareAccount: async (id) => { calls.push(["account", id]); if (over.accountFails) throw new Error("edge down"); return "created"; },
    release: async (id, opts) => {
      calls.push(["release", id, opts]);
      if (over.refuse) throw new Error("release refused: Health screen flagged (parq_chest_pain)");
      if (over.releaseFails) throw new Error("connection reset");
      return { status: "released", program: { action: "published" }, nutrition: { action: "assigned" }, invite: { already_claimed: !!over.claimed, claim_path: "/claim?token=abc" } };
    },
    openInvite: async (m) => { calls.push(["mail", m.to, m.link]); if (over.mailFails) throw new Error("no mail client"); },
  };
  return { deps, calls };
}
const ctx = { clientId: "c1", email: "client@example.com", displayName: "A", buildLink: (p) => "https://app" + p };

test("sequence: account first, then release, then mail — in that order", async () => {
  const { deps, calls } = harness();
  const r = await runRelease(deps, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c[0]), ["account", "release", "mail"]);
  assert.equal(calls[2][2], "https://app/claim?token=abc");
  assert.equal(r.claimLink, "https://app/claim?token=abc");
  assert.match(r.message, /^Released: program published, nutrition assigned, invite ready\. Your mail app is opening/);
});

test("account step fails → the RPC is never called, nothing released", async () => {
  const { deps, calls } = harness({ accountFails: true });
  const r = await runRelease(deps, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "account");
  assert.deepEqual(calls.map((c) => c[0]), ["account"]);
  assert.match(r.message, /Nothing was changed/);
});

test("no email → stops before the account step", async () => {
  const { deps, calls } = harness();
  const r = await runRelease(deps, { ...ctx, email: "" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "account");
  assert.deepEqual(calls, []);
});

test("refusal → named item, nothing released, no mail", async () => {
  const { deps, calls } = harness({ refuse: true });
  const r = await runRelease(deps, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "refused");
  assert.equal(r.message, "Not released — Health screen flagged (parq_chest_pain). Nothing was changed.");
  assert.deepEqual(calls.map((c) => c[0]), ["account", "release"]);
});

test("release failure (not a refusal) → reported as failure, no mail", async () => {
  const { deps, calls } = harness({ releaseFails: true });
  const r = await runRelease(deps, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.stage, "release");
  assert.deepEqual(calls.map((c) => c[0]), ["account", "release"]);
});

test("mail failure after a committed release is reported with the link, never hidden", async () => {
  const { deps } = harness({ mailFails: true });
  const r = await runRelease(deps, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.stage, "done");
  assert.equal(r.claimLink, "https://app/claim?token=abc");
  assert.match(r.message, /did not open — copy the invite link/);
});

test("already-claimed client skips the account step and the mail", async () => {
  const { deps, calls } = harness({ claimed: true });
  const r = await runRelease(deps, { ...ctx, alreadyClaimed: true });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c[0]), ["release"]);
  assert.equal(r.account, "not_needed");
});
