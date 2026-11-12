// license-portal — create a Stripe Billing Portal session for the signed-in coach, so they can
// update their card / resume their hosting subscription after suspension.
// (verify_jwt=false; auth self-handled.)
//
// POST { return_url? }  (Bearer JWT required; caller must be the tenant's coach)
//   → { portal_url }
// GET → health check.
import Stripe from "npm:stripe@17";
import { admin, callerUserId, json, CORS, STRIPE_KEY } from "../_shared/challenge.ts";

import { allowedOrigins } from "../_shared/origins.ts";

const stripe = new Stripe(STRIPE_KEY || "sk_test_placeholder", { apiVersion: "2024-06-20" });

// Same allowlist license-checkout already applies to its redirect URLs — this endpoint took
// body.return_url unchecked, letting a crafted request send the coach's billing-portal
// session back to an attacker's page.
const ALLOWED_REDIRECT_DOMAINS = allowedOrigins();

function isSafeRedirect(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return ALLOWED_REDIRECT_DOMAINS.some((d) => u.hostname === d || u.hostname.endsWith("." + d));
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "license-portal" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "authentication required" }, 401);
  if (!STRIPE_KEY) return json({ error: "payments unavailable" }, 500);

  const db = admin();
  const { data: prof } = await db.from("profiles").select("tenant_id, role").eq("user_id", userId).maybeSingle();
  if (!prof || prof.role !== "coach") return json({ error: "coach only" }, 403);
  const { data: tenant } = await db.from("tenants").select("stripe_customer_id").eq("id", prof.tenant_id).maybeSingle();
  if (!tenant?.stripe_customer_id) return json({ error: "no billing account on file for this tenant" }, 400);

  let body: any = {};
  try { body = await req.json(); } catch { /* optional */ }
  const origin = req.headers.get("origin") || "";
  const requestedReturn = typeof body?.return_url === "string" ? body.return_url : "";
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: tenant.stripe_customer_id,
      return_url: isSafeRedirect(requestedReturn) ? requestedReturn : `${origin}/coach`,
    });
    return json({ portal_url: portal.url });
  } catch (e) {
    return json({ error: "portal: " + (e as Error).message }, 502);
  }
});
