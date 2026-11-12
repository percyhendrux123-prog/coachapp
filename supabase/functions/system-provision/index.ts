// system-provision — redeem a paid Self-serve plan checkout: verify the session server-side,
// provision the client + intake token atomically, pre-create the sign-in account, email the
// intake link. Called from the SPA via supabase.functions.invoke; the buyer is not signed in.
//
// Trust boundary: the session is retrieved with the secret key; must be complete, paid or
// no_payment_required (100%-off promo), carry the exact SYSTEM price id, and carry our
// metadata.kind. The email comes from Stripe's customer_details, never from the request.
// Idempotent: every path re-runs safely (unique session id in provision_system_buyer;
// account creation reports "existed"; Resend idempotency key = session id, so a reload
// cannot send a second email).
//
// POST { session_id } → { intake_path, email_sent, email_error, account, email }
// GET → health check.
import Stripe from "npm:stripe@17";
import { admin, json, CORS, STRIPE_KEY } from "../_shared/challenge.ts";
import { SYSTEM_ONE_TIME_PRICE, SYSTEM_CHECKOUT_KIND } from "../_shared/pricing.ts";
import { welcomeEmail } from "./welcomeEmail.ts";

import { allowedOrigins } from "../_shared/origins.ts";

const stripe = new Stripe(STRIPE_KEY || "sk_test_placeholder", { apiVersion: "2024-06-20" });
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("SYSTEM_EMAIL_FROM") || Deno.env.get("EMAIL_FROM") || "Coach App <no-reply@example.com>";
const ALLOWED_ORIGINS = allowedOrigins();

function safeOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return u.origin;
    return ALLOWED_ORIGINS.some((d) => u.hostname === d || u.hostname.endsWith("." + d)) ? u.origin : null;
  } catch { return null; }
}

// Mask for the response: the page shows where the email went without echoing it whole.
const maskEmail = (e: string) => e.replace(/^(.).*?(.?)@/, (_m, a, b) => `${a}…${b}@`);

async function sendWelcome(to: string, intakeUrl: string, idempotencyKey: string): Promise<string | null> {
  if (!RESEND_KEY) return "RESEND_API_KEY not set";
  const m = welcomeEmail({ intakeUrl });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}`, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ from: FROM, to: [to], subject: m.subject, text: m.text, html: m.html }),
  });
  if (!res.ok) return `Resend ${res.status}: ${(await res.text()).slice(0, 200)}`;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "system-provision" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!STRIPE_KEY) return json({ error: "payment verification unavailable" }, 500);
  if (!SYSTEM_ONE_TIME_PRICE) return json({ error: "STRIPE_PRICE_SELF_SERVE not set" }, 503);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const sessionId = body?.session_id;
  if (typeof sessionId !== "string" || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return json({ error: "invalid session id" }, 400);
  const origin = safeOrigin(req.headers.get("origin") || "");
  if (!origin) return json({ error: "origin not allowed" }, 403);

  let session: any;
  try { session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items"] }); }
  catch { return json({ error: "session not found" }, 402); }
  const paid = session.status === "complete" && (session.payment_status === "paid" || session.payment_status === "no_payment_required");
  if (!paid) return json({ error: "payment not completed for this session", pending: session.status === "open" }, 402);
  if (session.metadata?.kind !== SYSTEM_CHECKOUT_KIND) return json({ error: "not a Self-serve plan purchase" }, 402);
  const items = session.line_items?.data || [];
  if (!items.some((it: any) => it?.price?.id === SYSTEM_ONE_TIME_PRICE)) return json({ error: "session is not a Self-serve plan purchase" }, 402);
  const email = String(session.customer_details?.email || session.customer_email || "").trim().toLowerCase();
  if (!email) return json({ error: "no email on this payment — contact support" }, 402);

  const db = admin();
  const screenId = typeof session.metadata?.screen_id === "string" ? session.metadata.screen_id : "";
  const { data: screen } = screenId
    ? await db.from("system_prepay_screens").select("id, answers").eq("id", screenId).maybeSingle()
    : { data: null };

  const { data: prov, error: pErr } = await db.rpc("provision_system_buyer", {
    p_email: email, p_session_id: session.id, p_parq: screen?.answers ?? {},
  });
  if (pErr) return json({ error: "provision: " + pErr.message }, 500);
  if (screen && !prov?.already_provisioned) await db.from("system_prepay_screens").update({ consumed_at: new Date().toISOString() }).eq("id", screen.id);

  // Sign-in account, unconfirmed, no password — same posture as client-invite.
  let account: "created" | "existed" | "failed" = "failed";
  const { data: found, error: lErr } = await db.rpc("auth_user_id_by_email", { p_email: email });
  if (!lErr && found) account = "existed";
  else if (!lErr) {
    const { data: made, error: cuErr } = await db.auth.admin.createUser({ email, email_confirm: false, user_metadata: { invited_as: "Self-serve plan" } });
    if (cuErr) account = /already|exists|registered/i.test(cuErr.message) ? "existed" : "failed";
    else {
      account = "created";
      if (made?.user?.id) { const { error: pw } = await db.rpc("auth_clear_password", { p_user_id: made.user.id }); if (pw) account = "failed"; }
    }
  }

  // &system=1 switches the intake page's wording only (a buyer never reads "your coach");
  // intake-submit decides everything from the token, never from this flag.
  const intake_path = `/intake?token=${prov.intake_token}&system=1`;
  const email_error = await sendWelcome(email, `${origin}${intake_path}`, `system-welcome-${session.id}`);
  return json({ intake_path, email_sent: email_error === null, email_error, account, email: maskEmail(email) });
});
