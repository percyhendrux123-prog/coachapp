// system-signup — the free self-serve plan signup (P33). Replaces system-checkout and
// system-provision: there is no payment, so there is nothing to redeem.
//
// verify_jwt is OFF (config.toml): the person is a stranger. The function owns every check:
// origin allow-list (same as the old checkout), the limits in system_signup_gate(), and the
// rule that the intake link only ever travels by email. See flow.ts for the exact answers.
//
// POST { email, src?, med?, camp?, cnt?, landing?, first_touch_at? }
//   → { ok: true } | { paused: true } | { error }
// GET → health check.
import { admin, json, CORS, SERVICE_KEY } from "../_shared/challenge.ts";
import { allowedOrigins } from "../_shared/origins.ts";
import { sanitizeAttribution } from "../_shared/attribution.ts";
import { signInEmail, welcomeEmail } from "./welcomeEmail.ts";
import { clientIp, keyedHash, parseCap, runSignup, safeOrigin, type Deps } from "./flow.ts";

const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("SYSTEM_EMAIL_FROM") || Deno.env.get("EMAIL_FROM") || "Coach App <no-reply@example.com>";
const ALLOWED_ORIGINS = allowedOrigins();
// Links in the emails are built from the configured site address, never from the request's
// Origin header (a script can send any Origin). Review round 1.
const APP_ORIGIN = (Deno.env.get("APP_ORIGIN") || "").replace(/\/$/, "");
const APP_IS_LOCAL = !APP_ORIGIN || /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(APP_ORIGIN);


async function sendEmail(to: string, m: { subject: string; text: string; html: string }, idempotencyKey: string): Promise<string | null> {
  if (!RESEND_KEY) return "RESEND_API_KEY not set";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}`, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ from: FROM, to: [to], subject: m.subject, text: m.text, html: m.html }),
  });
  if (!res.ok) { console.error(`system-signup: Resend ${res.status}`); return `Resend ${res.status}`; }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "system-signup" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const origin = safeOrigin(req.headers.get("origin") || "", ALLOWED_ORIGINS, APP_IS_LOCAL);
  if (!origin) return json({ error: "origin not allowed" }, 403);
  const linkBase = APP_ORIGIN || origin;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const db = admin();
  const deps: Deps = {
    hash: (v) => keyedHash(SERVICE_KEY, v),
    gate: async (emailHash, ipHash, cap) => {
      const { data, error } = await db.rpc("system_signup_gate", { p_email_hash: emailHash, p_ip_hash: ipHash, p_daily_cap: cap });
      if (error) throw new Error(error.message);
      return data;
    },
    provision: async (email) => {
      const { data, error } = await db.rpc("provision_system_signup", { p_email: email });
      if (error) throw new Error(error.message);
      return data;
    },
    // Same posture as the old system-provision and client-invite: unconfirmed, no password.
    ensureAccount: async (email) => {
      const { data: found, error: lErr } = await db.rpc("auth_user_id_by_email", { p_email: email });
      if (lErr) return "failed";
      if (found) return "existed";
      const { data: made, error: cuErr } = await db.auth.admin.createUser({ email, email_confirm: false, user_metadata: { invited_as: "Self-serve plan" } });
      if (cuErr) return /already|exists|registered/i.test(cuErr.message) ? "existed" : "failed";
      if (made?.user?.id) {
        const { error: pw } = await db.rpc("auth_clear_password", { p_user_id: made.user.id });
        if (pw) return "failed";
      }
      return "created";
    },
    saveSource: async (clientId) => {
      await db.from("system_signup_sources").upsert(
        { client_id: clientId, attribution: sanitizeAttribution(body) }, { onConflict: "client_id", ignoreDuplicates: true });
    },
    // &system=1 switches the intake page's wording only; intake-submit decides from the token.
    sendIntake: (email, clientId, token) =>
      sendEmail(email, welcomeEmail({ intakeUrl: `${linkBase}/intake?token=${token}&system=1` }), `system-signup-${clientId}-${token.slice(0, 12)}`),
    sendSignIn: (email, clientId) =>
      sendEmail(email, signInEmail({ loginUrl: `${linkBase}/login` }), `system-signup-${clientId}-signin-${new Date().toISOString().slice(0, 10)}`),
    mark: async (attemptId, decision) => {
      await db.from("system_signup_attempts").update({ decision }).eq("id", attemptId);
    },
  };

  const out = await runSignup(deps, {
    email: body?.email, ip: clientIp(req.headers), cap: parseCap(Deno.env.get("SYSTEM_SIGNUP_DAILY_CAP")),
  });
  return json(out.body, out.status);
});
