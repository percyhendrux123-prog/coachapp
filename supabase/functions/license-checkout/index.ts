// license-checkout — a one-time coach license plus recurring hosting in a single
// SUBSCRIPTION-mode session. The license rides the first invoice.
// Auth is self-handled: the signed-in buyer owns the provisioned subscription.
//
// Attribution (2026-09-08): the browser sends where the buyer came from — src, med, camp, cnt,
// landing, first_touch_at — re-sanitized here and merged onto the session. This function's
// client_reference_id is already load-bearing (license-provision binds ownership through it),
// so it is left alone and the source string rides in metadata.attribution_ref instead.
//
// POST { success_url?, cancel_url?, coupon?, src?, med?, camp?, cnt?, landing?, first_touch_at? }
//   (Bearer JWT required)  → { checkout_url, session_id }
// GET → health check.
import Stripe from "npm:stripe@17";
import { callerUserId, json, CORS, STRIPE_KEY } from "../_shared/challenge.ts";
import { WHITE_LABEL_LICENSE_PRICE, HOSTING_MONTHLY_PRICE } from "../_shared/pricing.ts";
import { sanitizeAttribution, withAttribution } from "../_shared/attribution.ts";

import { allowedOrigins } from "../_shared/origins.ts";

const stripe = new Stripe(STRIPE_KEY || "sk_test_placeholder", { apiVersion: "2024-06-20" });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "license-checkout" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "authentication required" }, 401);
  if (!STRIPE_KEY) return json({ error: "payments unavailable (no STRIPE_SECRET_KEY)" }, 500);
  if (!WHITE_LABEL_LICENSE_PRICE) return json({ error: "STRIPE_PRICE_LICENSE not set" }, 503);
  if (!HOSTING_MONTHLY_PRICE) return json({ error: "STRIPE_PRICE_HOSTING not set" }, 503);

  let body: any = {};
  try { body = await req.json(); } catch { /* optional body */ }
  const origin = req.headers.get("origin") || "";

  try {
    const ALLOWED_REDIRECT_DOMAINS = allowedOrigins();

  function isSafeRedirect(url: string): boolean {
    if (!url) return false;
    try {
      const u = new URL(url);
      return ALLOWED_REDIRECT_DOMAINS.some((d) => u.hostname === d || u.hostname.endsWith("." + d));
    } catch { return false; }
  }

  const defaults = {
    success_url: `${origin}/license?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/license?canceled=1`,
  };
  const success = body?.success_url;
  const cancel = body?.cancel_url;
  const success_url = success && isSafeRedirect(success) ? success : defaults.success_url;
  const cancel_url = cancel && isSafeRedirect(cancel) ? cancel : defaults.cancel_url;

    const couponCode = typeof body?.coupon === "string" ? body.coupon.trim() : "";
    let promotionCodeId = null;
    if (couponCode) {
      const found = await stripe.promotionCodes.list({ code: couponCode, active: true, limit: 1 });
      promotionCodeId = found.data[0]?.id ?? null;
      if (!promotionCodeId) return json({ error: "That coupon is not valid." }, 400);
    }

    // Where this buyer came from. Complete and defaulted — never blank, never trusted as sent.
    const attribution = sanitizeAttribution(body);

    // Built and typed as Stripe's own parameters first, then handed to withAttribution, which
    // merges the source in without disturbing anything here. This session's client_reference_id
    // is already taken by the user id (license-provision binds ownership through it), so it is
    // left alone and the source string lands in metadata.attribution_ref. Subscription mode →
    // the four campaign fields ride subscription_data, not a PaymentIntent.
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      line_items: [
        { price: HOSTING_MONTHLY_PRICE, quantity: 1 },     // recurring hosting
        { price: WHITE_LABEL_LICENSE_PRICE, quantity: 1 }, // one-time license on first invoice
      ],
      ...(promotionCodeId
        ? { discounts: [{ promotion_code: promotionCodeId }] }
        : { allow_promotion_codes: true }), // Stripe's own coupon box when none was typed
      success_url,
      cancel_url,
      client_reference_id: userId,
      metadata: { kind: "white_label_license", user_id: userId },
      subscription_data: { metadata: { kind: "white_label_hosting", user_id: userId } },
    };
    const session = await stripe.checkout.sessions.create(withAttribution(params, attribution));
    return json({ checkout_url: session.url, session_id: session.id });
  } catch (e) {
    return json({ error: "stripe checkout: " + (e as Error).message }, 502);
  }
});
