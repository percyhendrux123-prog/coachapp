// license-provision — after a paid White-Label License checkout, provision the buyer's
// tenant: tenants row (+ license ref), coach profile, tenant_config defaults.
// (verify_jwt=false; auth self-handled.)
//
// Trust boundary (same pattern as intake-submit): the Stripe Checkout Session is verified
// SERVER-SIDE — retrieved with STRIPE_SECRET_KEY, must be status=complete, paid, and carry
// the license price ID exactly. No webhook dependency (the project's webhook endpoint lacks
// checkout events — this path doesn't need them).
//
// Ownership binding: an in-app checkout always carries metadata.user_id / client_reference_id,
// checked first. A session with neither (e.g. a Stripe Payment Link sent by hand)
// falls back to matching the session's own
// customer email against the claiming account's email. A session bound to NEITHER path is
// refused outright — an unbound session must never be claimable by whoever pastes the ID in
// first.
//
// POST { session_id, app_name?, display_name? }  (Bearer JWT required)
//   → idempotent: caller already has an ACTIVE profile → their tenant.
//   → caller has a profile on a SUSPENDED tenant + a fresh valid session_id → reattach the
//     new payment and reactivate (closes the cancel-then-resubscribe lockout — a coach who
//     cancels, then pays again, is not left permanently locked out on their old dead
//     subscription).
//   → session already consumed (tenants.license_stripe_ref UNIQUE) → that tenant.
//   → else provision atomically (public.provision_licensed_coach — single transaction, no
//     partially-built tenant possible on a mid-way failure).
// GET → health check.
import Stripe from "npm:stripe@17";
import { admin, callerUserId, json, CORS, STRIPE_KEY } from "../_shared/challenge.ts";
import { WHITE_LABEL_LICENSE_PRICE } from "../_shared/pricing.ts";

const stripe = new Stripe(STRIPE_KEY || "sk_test_placeholder", { apiVersion: "2024-06-20" });

async function verifyLicenseSession(sessionId: unknown, userId: string) {
  if (!WHITE_LABEL_LICENSE_PRICE) return { ok: false as const, code: 503, error: "STRIPE_PRICE_LICENSE not configured" };
  if (!STRIPE_KEY) return { ok: false as const, code: 500, error: "payment verification unavailable" };
  if (typeof sessionId !== "string" || !sessionId.startsWith("cs_"))
    return { ok: false as const, code: 400, error: "invalid session id" };
  let session: any;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items", "customer"] });
  } catch {
    return { ok: false as const, code: 402, error: "session not found" };
  }
  const paid = session.status === "complete" &&
    (session.payment_status === "paid" || session.payment_status === "no_payment_required");
  if (!paid) return { ok: false as const, code: 402, error: "payment not completed for this session" };

  // Price ID only — no amount fallback: unrelated coaching purchases can have
  // the same amount. Redeeming a license requires the configured license price.
  const items = session.line_items?.data || [];
  const priceMatch = items.some((it: any) => it?.price?.id === WHITE_LABEL_LICENSE_PRICE);
  if (!priceMatch)
    return { ok: false as const, code: 402, error: "session is not a white-label license purchase" };

  const boundUser = session.metadata?.user_id || session.client_reference_id;
  if (boundUser) {
    if (boundUser !== userId)
      return { ok: false as const, code: 403, error: "license was purchased by a different account" };
    return { ok: true as const, session };
  }

  // No purchaser tag on the session (a hand-sent Payment Link, not the in-app Buy button) —
  // bind by email instead of accepting it unconditionally.
  const sessionEmail = (session.customer_details?.email || session.customer_email || "").toLowerCase().trim();
  if (!sessionEmail)
    return { ok: false as const, code: 403, error: "this payment cannot be tied to any account automatically — contact support to redeem it by hand" };

  const { data: caller } = await admin().auth.admin.getUserById(userId);
  const callerEmail = (caller?.user?.email || "").toLowerCase().trim();
  if (!callerEmail || callerEmail !== sessionEmail)
    return { ok: false as const, code: 403, error: "this license was purchased under a different email — sign in with that email to redeem it" };

  return { ok: true as const, session };
}

// Single-transaction insert via public.provision_licensed_coach — see that migration for why
// (a mid-way failure across three separate inserts used to burn the payment and leave an
// unrecoverable half-built account).
async function provision(
  db: any, userId: string, appName: string, displayName: string,
  sessionId: string, customerId: string | null, subscriptionId: string | null,
) {
  const { data, error } = await db.rpc("provision_licensed_coach", {
    p_user_id: userId, p_app_name: appName, p_display_name: displayName,
    p_session_id: sessionId, p_customer_id: customerId, p_subscription_id: subscriptionId,
  });
  if (error) throw new Error("provision: " + error.message);
  return data as { id: string; slug: string };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "license-provision" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "authentication required" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const db = admin();

  // Idempotency 1: caller already belongs to a tenant.
  const { data: prof } = await db.from("profiles").select("tenant_id, role").eq("user_id", userId).maybeSingle();
  if (prof) {
    const { data: t } = await db.from("tenants").select("id, slug, status").eq("id", prof.tenant_id).maybeSingle();

    // Active (or no fresh session offered): the ordinary idempotent return.
    if (t?.status !== "suspended" || typeof body?.session_id !== "string") {
      return json({ tenant_id: prof.tenant_id, slug: t?.slug ?? null, already_provisioned: true });
    }

    // Suspended tenant + a session the caller just paid for: a canceled Stripe subscription
    // never reappears in the Billing Portal, so without this branch a coach who cancels and
    // then buys again stays locked out forever on their old, dead subscription_id. Verify the
    // new payment, then reattach and reactivate in place — same tenant, new subscription.
    const v2 = await verifyLicenseSession(body.session_id, userId);
    if (!v2.ok) {
      return json({ tenant_id: prof.tenant_id, slug: t?.slug ?? null, already_provisioned: true, reactivation_error: v2.error });
    }
    const { data: dupe } = await db.from("tenants").select("id").eq("license_stripe_ref", v2.session.id).neq("id", t!.id).maybeSingle();
    if (dupe) {
      return json({ tenant_id: prof.tenant_id, slug: t?.slug ?? null, already_provisioned: true, reactivation_error: "this session was already used to provision a different tenant" });
    }
    const custId2 = typeof v2.session.customer === "string" ? v2.session.customer : v2.session.customer?.id ?? null;
    const subId2 = typeof v2.session.subscription === "string" ? v2.session.subscription : v2.session.subscription?.id ?? null;
    const { error: reErr } = await db.from("tenants").update({
      status: "active", subscription_status: "active",
      stripe_customer_id: custId2, subscription_id: subId2,
      license_stripe_ref: v2.session.id, licensed_at: new Date().toISOString(),
    }).eq("id", t!.id);
    if (reErr) return json({ error: reErr.message }, 500);
    return json({ tenant_id: t!.id, slug: t!.slug, reactivated: true, subscription_id: subId2 });
  }

  const v = await verifyLicenseSession(body?.session_id, userId);
  if (!v.ok) return json({ error: v.error }, v.code);

  // Idempotency 2: this payment already produced a tenant (unique license_stripe_ref).
  const { data: existing } = await db.from("tenants").select("id, slug").eq("license_stripe_ref", v.session.id).maybeSingle();
  if (existing) return json({ tenant_id: existing.id, slug: existing.slug, already_provisioned: true });

  const appName = typeof body?.app_name === "string" ? body.app_name.trim().slice(0, 60) : "";
  const displayName = typeof body?.display_name === "string" ? body.display_name.trim().slice(0, 60) : "";
  const customerId = typeof v.session.customer === "string" ? v.session.customer : v.session.customer?.id ?? null;
  const subscriptionId = typeof v.session.subscription === "string" ? v.session.subscription : v.session.subscription?.id ?? null;
  try {
    const tenant = await provision(db, userId, appName, displayName, v.session.id, customerId, subscriptionId);
    return json({ tenant_id: tenant.id, slug: tenant.slug, provisioned: true, subscription_id: subscriptionId });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
