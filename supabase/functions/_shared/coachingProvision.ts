// Shared by coaching-provision (the /welcome redirect) and stripe-webhook (the belt).
// One gate, one provisioning routine, one email — so the two paths cannot disagree.

import { tierForProduct } from "./pricing.ts";

export type Gate =
  | { ok: true; tier: "entry" | "standard"; email: string; priceId: string; productId: string }
  | { ok: false; reason: string; pending?: boolean };

// Decide whether a retrieved Checkout Session (line_items expanded) is a paid coaching
// purchase. Exact configured PRODUCT id, never amount. Payment Links carry no metadata, so none is
// required. `price.product` is a string id unless the caller expanded it, so accept both.
export const productIdOf = (item: any): string | null => {
  const p = item?.price?.product;
  return typeof p === "string" ? p : (p && typeof p.id === "string" ? p.id : null);
};

export function gateCoachingSession(session: any): Gate {
  if (!session) return { ok: false, reason: "session not found" };
  const paid = session.status === "complete" &&
    (session.payment_status === "paid" || session.payment_status === "no_payment_required");
  if (!paid) return { ok: false, reason: "payment not completed for this session", pending: session.status === "open" };
  if (session.mode !== "subscription") return { ok: false, reason: "not a coaching subscription" };
  const items: any[] = session.line_items?.data || [];
  const hit = items.find((it) => tierForProduct(productIdOf(it)) !== null);
  if (!hit) return { ok: false, reason: "session is not a coaching purchase" };
  const tier = tierForProduct(productIdOf(hit))!;
  const email = String(session.customer_details?.email || session.customer_email || "").trim().toLowerCase();
  if (!email) return { ok: false, reason: "no email on this payment — contact support" };
  return { ok: true, tier, email, priceId: String(hit?.price?.id ?? ""), productId: productIdOf(hit)! };
}

// Day-0 email: one job — get them into the intake. Short lines, no hype.
export function coachingWelcomeEmail({ intakeUrl }: { intakeUrl: string }) {
  const subject = "Your coaching intake link";
  const text = [
    "You're in.",
    "",
    "Next step is a short intake. Your first training week and your nutrition targets are built from what you enter. About eight minutes.",
    "",
    intakeUrl,
    "",
    "I read every intake before anything gets built. You hear from me, then your program lands in the app.",
    "",
    "Structure outlives motivation. This is the first piece of it.",
    "",
    `— ${Deno.env.get("COACH_SIGNATURE") || "Your coach"}`,
  ].join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = text.split("\n").map((l) => l === intakeUrl
    ? `<p><a href="${esc(intakeUrl)}">Open your intake</a></p>`
    : `<p>${l ? esc(l) : "&nbsp;"}</p>`).join("");
  return { subject, text, html };
}

export const maskEmail = (e: string) => e.replace(/^(.).*?(.?)@/, (_m, a, b) => `${a}…${b}@`);

export type ProvisionResult = {
  outcome: "created" | "attached" | "existed" | "ambiguous";
  client_id?: string;
  intake_path?: string;
  email_sent: boolean;
  email_error: string | null;
  account: "created" | "existed" | "failed" | "skipped";
  email: string;
  detail?: string;
};

// Provision (idempotent on session id), pre-create the sign-in account, send the welcome.
// `db` is a service-role client. `origin` is the SPA origin the intake link should point at.
export async function provisionCoachingClient(opts: {
  db: any; sessionId: string; email: string; tier: "entry" | "standard"; origin: string;
  resendKey: string; from: string;
}): Promise<ProvisionResult> {
  const { db, sessionId, email, tier, origin, resendKey, from } = opts;
  const { data: prov, error: pErr } = await db.rpc("provision_coaching_client", {
    p_email: email, p_session_id: sessionId, p_tier: tier,
  });
  if (pErr) throw new Error("provision: " + pErr.message);
  if (prov?.outcome === "ambiguous") {
    return { outcome: "ambiguous", email_sent: false, email_error: null, account: "skipped", email: maskEmail(email), detail: prov.detail };
  }

  // Sign-in account, unconfirmed, no password — same posture as client-invite.
  let account: ProvisionResult["account"] = "failed";
  const { data: found, error: lErr } = await db.rpc("auth_user_id_by_email", { p_email: email });
  if (!lErr && found) account = "existed";
  else if (!lErr) {
    const { data: made, error: cuErr } = await db.auth.admin.createUser({ email, email_confirm: false, user_metadata: { invited_as: "Coaching" } });
    if (cuErr) account = /already|exists|registered/i.test(cuErr.message) ? "existed" : "failed";
    else {
      account = "created";
      if (made?.user?.id) { const { error: pw } = await db.rpc("auth_clear_password", { p_user_id: made.user.id }); if (pw) account = "failed"; }
    }
  }

  const intake_path = `/intake?token=${prov.intake_token}`;
  const email_error = await sendCoachingWelcome({ to: email, intakeUrl: `${origin}${intake_path}`, idempotencyKey: `coaching-welcome-${sessionId}`, resendKey, from });
  return { outcome: prov.outcome, client_id: prov.client_id, intake_path, email_sent: email_error === null, email_error, account, email: maskEmail(email) };
}

export async function sendCoachingWelcome(o: { to: string; intakeUrl: string; idempotencyKey: string; resendKey: string; from: string }): Promise<string | null> {
  if (!o.resendKey) return "RESEND_API_KEY not set";
  const m = coachingWelcomeEmail({ intakeUrl: o.intakeUrl });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.resendKey}`, "Idempotency-Key": o.idempotencyKey },
    body: JSON.stringify({ from: o.from, to: [o.to], subject: m.subject, text: m.text, html: m.html }),
  });
  if (!res.ok) return `Resend ${res.status}: ${(await res.text()).slice(0, 200)}`;
  return null;
}
