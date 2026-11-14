// Run: deno test --allow-read supabase/functions/intake-submit/healthOutcome.test.ts
import { blockedBody, coachedHeldBody, COACHED_HELD_MESSAGE, needsClearanceBody, selfServeHealthOutcome, W9_TEXT } from "./healthOutcome.ts";

const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)}`); };

Deno.test("coached flagged response is byte-for-byte what it was before P33 (golden)", () => {
  // The string intake-submit returned on 172cfb9 for a coached held_medical draft.
  const golden = '{"status":"held_medical","draft_id":"d-1","health_flags":["parq_chest_pain"],"mode":"coached","message":"Health-screen flag raised — held for coach review. No plan auto-generated."}';
  eq(JSON.stringify({ ...coachedHeldBody("d-1", ["parq_chest_pain"]), mode: "coached" }), golden, "golden");
  eq(COACHED_HELD_MESSAGE, "Health-screen flag raised — held for coach review. No plan auto-generated.", "message");
});
Deno.test("self-serve doctor-first → needs_clearance, nothing published", () => {
  eq(selfServeHealthOutcome(["parq_chest_pain"]), { status: "needs_clearance" }, "chest pain");
  eq(selfServeHealthOutcome(["medication_disclosed"]), { status: "needs_clearance" }, "medication");
  const b = needsClearanceBody("i-1", "d-1", ["parq_chest_pain"]);
  eq(b.status, "needs_clearance", "status");
  eq("program_id" in b, false, "no program");
});
Deno.test("self-serve pregnancy / eating-disorder history → blocked_health, no draft id", () => {
  eq(selfServeHealthOutcome(["pregnancy"]), { status: "blocked_health", reason: "pregnancy" }, "pregnancy");
  eq(selfServeHealthOutcome(["eating_disorder_history"]), { status: "blocked_health", reason: "eating_disorder_history" }, "ed");
  eq(selfServeHealthOutcome(["parq_dizziness", "pregnancy"]), { status: "blocked_health", reason: "pregnancy" }, "mixed: blocking wins");
  eq(selfServeHealthOutcome(["mystery"]), { status: "blocked_health", reason: "other" }, "unknown fails closed");
  const b = blockedBody("i-1", "pregnancy");
  eq("draft_id" in b, false, "no draft");
});
Deno.test("no flags → build as normal", () => eq(selfServeHealthOutcome([]), null, "none"));
Deno.test("W9 is the approved text and both self-serve bodies carry it", () => {
  eq(W9_TEXT, "Health screen flagged. No plan was built. The person must open the app, read the hold screen, and confirm their doctor's clearance themselves. An assistant cannot answer the health screen or confirm clearance for them.", "W9");
  eq(blockedBody("i", "other").message, W9_TEXT, "blocked");
  eq(needsClearanceBody("i", "d", ["x"]).message, W9_TEXT, "needs_clearance");
});
Deno.test("no self-serve outcome text mentions coaching, a charge or a receipt", () => {
  const text = JSON.stringify([blockedBody("i", "pregnancy"), needsClearanceBody("i", "d", ["parq_chest_pain"])]);
  if (/coach|charged|receipt/i.test(text)) throw new Error("banned word in a self-serve outcome");
});
