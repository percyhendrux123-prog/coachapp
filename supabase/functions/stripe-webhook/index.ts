// stripe-webhook — the server-side fallback behind /welcome.
//
// History: this used to create coaching clients from every Stripe event on the assumption that
// all coaches billed through this account. That model is gone (coaches use their own payment
// links; hosting is reconciled by license-reconcile). This function does one thing:
// on a verified `checkout.session.completed` whose line item is a configured coaching price, run the
// same provision + welcome-email routine the /welcome redirect runs. Idempotency makes whichever
// of the two arrives second a no-op. Every other event is 200-acknowledged and ignored.
//
// Fails closed: no STRIPE_WEBHOOK_SECRET → 200 {received, ignored:"unverified"} and no writes.
// Stripe's signing secret is set in Supabase secrets; it never passes through a session.
import Stripe from "npm:stripe@17";
import { admin, CORS, STRIPE_KEY } from "../_shared/challenge.ts";
import { tierForProduct } from "../_shared/pricing.ts";
import { gateCoachingSession, productIdOf, provisionCoachingClient } from "../_shared/coachingProvision.ts";

const stripe = new Stripe(STRIPE_KEY || "sk_test_placeholder", { apiVersion: "2024-06-20" as Stripe.LatestApiVersion });
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("EMAIL_FROM") || "Coach App <no-reply@example.com>";
// The SPA origin the emailed intake link points at (no request origin on a webhook).
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") || "http://localhost:5173";
const cryptoProvider = Stripe.createSubtleCryptoProvider();

const ack = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ received: true, ...body }), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return ack({ ok: true, service: "stripe-webhook", verifying: Boolean(WEBHOOK_SECRET) });
  if (req.method !== "POST") return ack({ ignored: "method" }, 405);
  if (!WEBHOOK_SECRET || !STRIPE_KEY) return ack({ ignored: "unverified" });

  const sig = req.headers.get("stripe-signature") || "";
  const raw = await req.text();
  let event: any;
  try { event = await stripe.webhooks.constructEventAsync(raw, sig, WEBHOOK_SECRET, undefined, cryptoProvider); }
  catch (e) { return ack({ error: "signature: " + (e as Error).message }, 400); }

  if (event.type !== "checkout.session.completed") return ack({ ignored: event.type });

  // The event payload does not carry line items; retrieve with them expanded so the gate is
  // the same object shape /welcome sees.
  let session: any;
  try { session = await stripe.checkout.sessions.retrieve(event.data.object.id, { expand: ["line_items"] }); }
  catch (e) { return ack({ error: "retrieve: " + (e as Error).message }, 500); }
  const gate = gateCoachingSession(session);
  if (!gate.ok) {
    const coaching = (session.line_items?.data || []).some((it: any) => tierForProduct(productIdOf(it)) !== null);
    return ack({ ignored: coaching ? gate.reason : "not a coaching purchase" });
  }

  try {
    const r = await provisionCoachingClient({
      db: admin(), sessionId: session.id, email: gate.email, tier: gate.tier, origin: APP_ORIGIN, resendKey: RESEND_KEY, from: FROM,
    });
    // One line per coaching checkout so the outcome is readable in the function logs.
    console.log(JSON.stringify({ webhook: "coaching_checkout", session: session.id, outcome: r.outcome, account: r.account, email_sent: r.email_sent, email_error: r.email_error }));
    return ack({ outcome: r.outcome, account: r.account, email_sent: r.email_sent, email_error: r.email_error, detail: r.detail ?? null });
  } catch (e) {
    // 500 so Stripe retries; provision is idempotent, so a retry is safe.
    return ack({ error: (e as Error).message }, 500);
  }
});
