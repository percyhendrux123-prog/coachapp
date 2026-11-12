// challenge-enroll — enroll an authenticated participant into a challenge.
// Enrollment starts the run immediately without payment.
// (verify_jwt=false; auth self-handled.)
//
// POST { challenge_id }  (Bearer JWT required)
//   → the challenge must be PUBLISHED. A draft or archived challenge refuses (409), so a
//     coach unpublishing is a real stop for the API, not only for the page.
//   → creates/returns the participant's run (idempotent on unique(challenge_id, participant_user_id),
//     including under a concurrent double-submit: a unique violation resolves to the existing run)
//   → a new run starts active (started_at set) so the participant can log day 1 right away
// GET → health check.
import { admin, callerUserId, json, CORS } from "../_shared/challenge.ts";
import { enrollDecision, hasCurrentCoachingRelationship, isChallengeFull, isUniqueViolation } from "../_shared/challengeEnroll.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "challenge-enroll" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "authentication required" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const challengeId = body?.challenge_id;
  if (!challengeId) return json({ error: "challenge_id required" }, 400);

  const db = admin();
  const { data: challenge } = await db.from("challenges").select("*").eq("id", challengeId).maybeSingle();
  if (!challenge) return json({ error: "challenge not found" }, 404);

  // Enrollable at all? (published — not draft, not archived)
  const pre = enrollDecision({ challenge, isClient: undefined });
  if (pre.ok === false) return json({ error: pre.error }, pre.status);

  // Idempotent: reuse an existing run.
  const findExisting = () => db.from("challenge_runs").select("*")
    .eq("challenge_id", challengeId).eq("participant_user_id", userId).maybeSingle();
  const { data: existing } = await findExisting();
  if (existing) return json({ run_id: existing.id, status: existing.status, already_enrolled: true });

  // Audience gate — only applies to a NEW enrollment. Someone already in a run keeps it
  // even if a coach narrows the setting afterward.
  // "Client" means a CURRENT coaching relationship (active/paused, or live billing) — an
  // archived former client or an intake that never started is not a client here.
  let isClient = false;
  if (pre.needsClientLookup) {
    const { data: clientRow } = await db.from("clients").select("id, status, subscription_status")
      .eq("tenant_id", challenge.tenant_id).eq("client_user_id", userId).maybeSingle();
    isClient = hasCurrentCoachingRelationship(clientRow);
  }
  const decision = enrollDecision({ challenge, isClient });
  if (decision.ok !== true) return json({ error: decision.error ?? "not eligible" }, decision.status ?? 403);

  const ins = await db.from("challenge_runs").insert({
    tenant_id: challenge.tenant_id, challenge_id: challengeId, participant_user_id: userId,
    status: "active", started_at: new Date().toISOString(),
  }).select("*").single();
  if (ins.error) {
    // Capacity is enforced by the database (trg_challenge_runs_capacity, row-locked, so two
    // concurrent enrolls cannot both pass). Read as "full", never as a server error.
    if (isChallengeFull(ins.error)) return json({ error: "this challenge is full" }, 409);
    if (isUniqueViolation(ins.error)) {
      // Two enrolls raced; the unique index kept one. Return that one.
      const { data: raced } = await findExisting();
      if (raced) return json({ run_id: raced.id, status: raced.status, already_enrolled: true });
    }
    return json({ error: "enroll insert: " + ins.error.message }, 500);
  }
  return json({ run_id: ins.data.id, status: "active" });
});
