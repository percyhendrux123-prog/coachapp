// challenge-log — a participant logs which standards they hit on the current day.
// Writes via service role (RLS-bypassing) so all_standards_met is computed server-side,
// never trusted from the client. (verify_jwt=false; auth self-handled.)
//
// POST { run_id, day_index, standards_hit: [standard_id, ...] }  (Bearer JWT required)
//   → upserts challenge_day_logs(run_id, day_index); recomputes all_standards_met
//   → gated: entry must be paid; day_index must be the run's current day and within duration
// GET → health check.
import { admin, callerUserId, loadOwnedRun, json, CORS } from "../_shared/challenge.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "challenge-log" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "authentication required" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { run_id, day_index } = body || {};
  const standardsHit: unknown = body?.standards_hit;
  if (!run_id || !Number.isInteger(day_index)) return json({ error: "run_id and integer day_index required" }, 400);
  if (!Array.isArray(standardsHit)) return json({ error: "standards_hit must be an array" }, 400);

  const owned = await loadOwnedRun(run_id, userId);
  if ("error" in owned) return owned.error;
  const { run, challenge } = owned;

  // Gates (challenge is free — no payment gate).
  if (day_index < 1 || day_index > challenge.duration_days)
    return json({ error: `day_index out of range 1..${challenge.duration_days}` }, 400);
  if (day_index !== run.current_day_index)
    return json({ error: `can only log the current day (${run.current_day_index})` }, 409);

  const db = admin();

  // Validate standards belong to this challenge; count DISTINCT valid hits.
  const { data: validStds } = await db.from("challenge_standards").select("id").eq("challenge_id", challenge.id);
  const validIds = new Set((validStds || []).map((s: any) => s.id));
  const cleanHits = [...new Set(standardsHit.filter((id) => validIds.has(id)))];
  const allMet = cleanHits.length >= challenge.num_standards;

  const up = await db.from("challenge_day_logs").upsert({
    tenant_id: challenge.tenant_id, run_id, day_index,
    standards_hit: cleanHits, all_standards_met: allMet, logged_at: new Date().toISOString(),
  }, { onConflict: "run_id,day_index" }).select("*").single();
  if (up.error) return json({ error: "day log upsert: " + up.error.message }, 500);

  // Runs start active on enroll; flip any legacy 'enrolled' run to active defensively.
  if (run.status === "enrolled")
    await db.from("challenge_runs").update({ status: "active", started_at: run.started_at ?? new Date().toISOString() }).eq("id", run_id);

  return json({ day_log: up.data, all_standards_met: allMet, standards_required: challenge.num_standards });
});
