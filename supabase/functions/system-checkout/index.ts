// system-checkout — Self-serve plan pre-pay screen → Stripe Checkout.
// Called from the SPA via supabase.functions.invoke (anon key passes the gateway; there is
// no signed-in user — the buyer is a stranger). Same posture as license-checkout.
//
// Trust boundary: the SERVER decides clear/flagged from the answers, never the browser. A
// flagged screen is stored (it is a launch metric) and NO checkout session is created — the
// buyer is not charged and is pointed to coaching by the page. A clear screen is stored,
// then a session is created with the screen id in metadata so system-provision can record
// the screen against the buyer without trusting anything the browser sends later.
//
// Promo codes: Stripe's open box is OFF. An optional `promo` string is honoured only when
// its coupon is tagged SYSTEM_PROMO_ALLOW_KEY="true" in Stripe metadata; anything else is
// refused before a screen row or a session exists. Unrestricted coupons could otherwise
// unlock the product without the intended product-specific permission.
//
// Attribution (2026-09-08): the browser sends where the buyer came from — src, med, camp, cnt,
// landing, first_touch_at. Untrusted like everything else in this body, so it is re-sanitized
// here, then merged onto the session (never replacing `kind`/`screen_id`) and stamped on the
// PaymentIntent, linking a purchase to its source. See _shared/attribution.ts.
//
// POST { email, answers, promo?, src?, med?, camp?, cnt?, landing?, first_touch_at? }
//   → { checkout_url, session_id } | { flagged: true, flags } | { error, missing }
// GET → health check.
import Stripe from "npm:stripe@17";
import { admin, json, CORS, STRIPE_KEY } from "../_shared/challenge.ts";
import { SYSTEM_ONE_TIME_PRICE, SYSTEM_AUTOMATIC_TAX, SYSTEM_CHECKOUT_KIND, SYSTEM_PROMO_ALLOW_KEY } from "../_shared/pricing.ts";
import { screenOutcome, screenAnswersForIntake } from "../_shared/parq.ts";
import { sanitizeAttribution, withAttribution } from "../_shared/attribution.ts";

import { allowedOrigins } from "../_shared/origins.ts";

const stripe = new Stripe(STRIPE_KEY || "sk_test_placeholder", { apiVersion: "2024-06-20" });
const ALLOWED_ORIGINS = allowedOrigins();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return u.origin; // local render only; Stripe still live
    return ALLOWED_ORIGINS.some((d) => u.hostname === d || u.hostname.endsWith("." + d)) ? u.origin : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "system-checkout" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!STRIPE_KEY) return json({ error: "payments unavailable (no STRIPE_SECRET_KEY)" }, 500);
  if (!SYSTEM_ONE_TIME_PRICE) return json({ error: "STRIPE_PRICE_SELF_SERVE not set" }, 503);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "a valid email is required" }, 400);
  const origin = safeOrigin(req.headers.get("origin") || "");
  if (!origin) return json({ error: "origin not allowed" }, 403);

  const answers = body?.answers && typeof body.answers === "object" ? body.answers : {};
  const outcome = screenOutcome(answers);
  if (!outcome.ok && outcome.missing.length > 0)
    return json({ error: `Every health-screen question must be answered: ${outcome.missing.join(", ")}`, missing: outcome.missing }, 400);

  // Promo: explicit, allow-listed by coupon metadata, resolved BEFORE anything is stored so a
  // bad code leaves no screen row and no session behind. The coupon rides on the promotion
  // code object at this API version, so no expand is needed.
  const promo = typeof body?.promo === "string" ? body.promo.trim().toUpperCase().slice(0, 64) : "";
  let discounts: { promotion_code: string }[] | undefined;
  if (promo) {
    try {
      const found = await stripe.promotionCodes.list({ code: promo, active: true, limit: 1 });
      const pc = found.data[0];
      const coupon = pc?.coupon as Stripe.Coupon | undefined;
      if (!pc || !coupon?.valid || coupon.metadata?.[SYSTEM_PROMO_ALLOW_KEY] !== "true")
        return json({ error: "That code is not valid for Self-serve plan." }, 400);
      discounts = [{ promotion_code: pc.id }];
    } catch (e) {
      return json({ error: "stripe promo lookup: " + (e as Error).message }, 502);
    }
  }

  const db = admin();
  const { data: screen, error: sErr } = await db.from("system_prepay_screens")
    .insert({ email, answers: screenAnswersForIntake(answers), flagged: !outcome.ok })
    .select("id").single();
  if (sErr) return json({ error: "screen store: " + sErr.message }, 500);

  if (!outcome.ok) return json({ flagged: true, flags: outcome.flags });

  // Where this buyer came from. Complete and defaulted — never blank, never trusted as sent.
  const attribution = sanitizeAttribution(body);

  try {
    // Built and typed as Stripe's own parameters first, then handed to withAttribution, which
    // merges the source in without disturbing anything here: `kind` and `screen_id` are
    // preserved for system-provision, this session's free client_reference_id column takes the
    // src_med_cnt string, and payment mode stamps the four campaign fields on the PaymentIntent.
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "payment",
      line_items: [{ price: SYSTEM_ONE_TIME_PRICE, quantity: 1 }],
      customer_creation: "always",
      customer_email: email,
      // No open promo box — see header. `discounts` only when an allow-listed code was given.
      ...(discounts ? { discounts } : {}),
      automatic_tax: { enabled: SYSTEM_AUTOMATIC_TAX },
      success_url: `${origin}/system/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/system`,
      metadata: { kind: SYSTEM_CHECKOUT_KIND, screen_id: screen.id },
    };
    const session = await stripe.checkout.sessions.create(withAttribution(params, attribution));
    await db.from("system_prepay_screens").update({ checkout_session_id: session.id }).eq("id", screen.id);
    return json({ checkout_url: session.url, session_id: session.id });
  } catch (e) {
    return json({ error: "stripe checkout: " + (e as Error).message }, 502);
  }
});
