// checkin-assess — generate a checkin_assessments row for one check-in. Fire-and-
// forget, called by the client app right after a check-in submits successfully
// (never blocks or fails the check-in itself — see src/pages/Client.jsx submit()).
// Core logic lives in _shared/checkinAssess.ts, shared with its own tests.
// No config.toml — deploys with the platform default (gateway-verified JWT),
// same as workout-close. callerUserId() below additionally resolves WHO the
// caller is, and ownership is checked against the checkin's own client — the
// gateway check and this one answer different questions.
//
// POST { checkin_id }  (Bearer JWT required; caller must be the client who owns it)
// GET → health check.
import { admin, callerUserId, json, CORS } from "../_shared/challenge.ts";
import { assessCheckin, assessmentSkipReason } from "../_shared/checkinAssess.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "checkin-assess" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "authentication required" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { checkin_id } = body || {};
  if (!checkin_id) return json({ error: "checkin_id required" }, 400);

  const db = admin();
  const { data: checkin } = await db.from("checkins").select("id, client_id").eq("id", checkin_id).maybeSingle();
  if (!checkin) return json({ error: "checkin not found" }, 404);
  const { data: client } = await db.from("clients").select("client_user_id").eq("id", checkin.client_id).maybeSingle();
  if (!client || client.client_user_id !== userId) return json({ error: "not your checkin" }, 403);

  // Optional feature. Without an Anthropic key there is nothing to generate: answer
  // plainly instead of a 500 on every check-in a client submits.
  const skip = assessmentSkipReason();
  if (skip) return json({ ok: true, skipped: skip });

  try {
    const result = await assessCheckin(db, checkin_id);
    return json(result);
  } catch (e: any) {
    // Best-effort by design — the caller (submitCheckin's fire-and-forget) already
    // treats this as non-blocking, but a 500 here still shows up in function logs
    // so a persistently failing generator (bad key, provider outage) is visible to
    // whoever's watching, not just silently absent forever.
    console.error("checkin-assess failed", checkin_id, e?.message || e);
    return json({ error: String(e?.message || e) }, 500);
  }
});
