// coaching-provision — redeem a paid coaching checkout: verify the session server-side,
// provision (or attach) the owner client + intake token atomically, pre-create the sign-in
// account, email the intake link. Called from /welcome via supabase.functions.invoke; the
// buyer is not signed in. Twin of system-provision; the shared routine lives in
// _shared/coachingProvision.ts so stripe-webhook (the belt) runs the exact same code.
//
// Trust boundary: the session is retrieved with the secret key; must be complete, paid or
// no_payment_required, mode=subscription, and carry a product id from COACHING_TIER_BY_PRODUCT
// (D9) — never an amount, never a price id that a per-client rate would rotate. The email comes from Stripe's customer_details, never from the request.
// Idempotent: unique session id in provision_coaching_client; account creation reports
// "existed"; Resend idempotency key = session id.
//
// POST { session_id } → { outcome, intake_path, email_sent, email_error, account, email }
// GET → health check.
import Stripe from "npm:stripe@17";
import { admin, json, CORS, STRIPE_KEY } from "../_shared/challenge.ts";
import { gateCoachingSession, provisionCoachingClient } from "../_shared/coachingProvision.ts";

import { allowedOrigins } from "../_shared/origins.ts";

const stripe = new Stripe(STRIPE_KEY || "sk_test_placeholder", { apiVersion: "2024-06-20" as Stripe.LatestApiVersion });
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("COACHING_EMAIL_FROM") || Deno.env.get("EMAIL_FROM") || "Coach App <no-reply@example.com>";
const ALLOWED_ORIGINS = allowedOrigins();

function safeOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return u.origin;
    return ALLOWED_ORIGINS.some((d) => u.hostname === d || u.hostname.endsWith("." + d)) ? u.origin : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "coaching-provision" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!STRIPE_KEY) return json({ error: "payment verification unavailable" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const sessionId = body?.session_id;
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return json({ error: "invalid session id" }, 400);
  const origin = safeOrigin(req.headers.get("origin") || "");
  if (!origin) return json({ error: "origin not allowed" }, 403);

  let session: any;
  try { session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items"] }); }
  catch { return json({ error: "session not found" }, 402); }
  const gate = gateCoachingSession(session);
  if (!gate.ok) return json({ error: gate.reason, pending: gate.pending ?? false }, 402);

  try {
    const r = await provisionCoachingClient({
      db: admin(), sessionId: session.id, email: gate.email, tier: gate.tier, origin, resendKey: RESEND_KEY, from: FROM,
    });
    if (r.outcome === "ambiguous") return json({ error: "this email matches more than one client record — the coach has to attach it by hand", detail: r.detail }, 409);
    return json(r);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
