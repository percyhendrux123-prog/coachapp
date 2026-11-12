// send-digest — Phase 2 daily coach email digest. Cron-driven, shared-secret auth.
// Gathers the last 24h of notification_log activity for the platform owner.
//
// The coach-owed onboarding section is included in this email
// when the tenant's coach_digest switch is on, read from
// onboarding_coach_digest(). With the switch on and something owed, one push line goes to
// the coach's subscribed devices too. Switch off → one quiet line says so, nothing pushed.
//
// POST { }  (Authorization: Bearer CRON_SECRET required)
// GET → health check.
import { admin, json, CORS } from "../_shared/challenge.ts";
import { requireOwnerTenant } from "./policy.ts";
import { OWNER_TENANT_SLUG } from "../_shared/owner.ts";
import webpush from "npm:web-push@3.6.7";
import { type CoachDigest, coachDigestLine, coachDigestPush } from "../_shared/onboardingReminders.ts";
import { type SystemBuyerRow, stuckLine, stuckSystemBuyers } from "../_shared/systemStuck.ts";

const RESEND_API = "https://api.resend.com/emails";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const DIGEST_TO = Deno.env.get("DIGEST_RECIPIENT") || "";
const DIGEST_FROM = Deno.env.get("DIGEST_SENDER") || Deno.env.get("EMAIL_FROM") || "Coach App <no-reply@example.com>";
const APP_ORIGIN = (Deno.env.get("APP_ORIGIN") || "http://localhost:5173").replace(/\/$/, "");
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
if (VAPID_PUBLIC && VAPID_PRIVATE) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// The onboarding section. Returns the html block and whether a push went out. Any failure
// here is reported inside the email rather than sinking the digest.
async function onboardingSection(db: ReturnType<typeof admin>, tenantId: string): Promise<{ html: string; pushed: number; line: string | null }> {
  const { data, error } = await db.rpc("onboarding_coach_digest", { p_tenant_id: tenantId });
  if (error) return { html: `<p style="color:#b00">Onboarding section could not be read: ${escapeHtml(error.message)}</p>`, pushed: 0, line: null };
  const d = data as CoachDigest;
  if (!d?.switch_on) {
    return { html: `<p style="color:#888;font-size:12px">Onboarding reminders digest is off (Settings → Reminders).</p>`, pushed: 0, line: null };
  }
  const line = coachDigestLine(d);
  if (!line) return { html: `<p style="color:#555">Owed by you, 3+ days: nothing.</p>`, pushed: 0, line: null };

  // The push is about the roster, not one client, and notification_log requires a client_id —
  // so it is not written there. The count is returned in this function's response (which the
  // cron discards) and, more usefully, stamped on the coach's subscription row (last_used_at).
  let pushed = 0;
  const tpl = coachDigestPush(d);
  if (tpl && VAPID_PRIVATE) {
    const { data: subs } = await db.from("coach_push_subscriptions").select("id, subscription").eq("tenant_id", tenantId).is("revoked_at", null);
    for (const s of subs || []) {
      try {
        await webpush.sendNotification(s.subscription, JSON.stringify(tpl));
        pushed++;
        await db.from("coach_push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", s.id);
      } catch (e: any) {
        const code = e?.statusCode || "err";
        if (code === 404 || code === 410) await db.from("coach_push_subscriptions").update({ revoked_at: new Date().toISOString() }).eq("id", s.id);
      }
    }
  }
  const html = `<p style="color:#111;font-weight:600;margin:0 0 4px">Onboarding</p>
    <p style="color:#111;margin:0">${escapeHtml(line).replace("Open Clients → Stuck.", `<a href="${escapeHtml(APP_ORIGIN)}/coach/clients?stuck=1">Open Clients → Stuck</a>.`)}</p>`;
  return { html, pushed, line };
}

// Self-serve buyers who paid and submitted intake 24h+ ago but still lack a plan
// or sign-in. This alert is owner-only: it must not notify other tenants.
// A read failure is shown in the email, never swallowed.
async function systemStuckSection(db: ReturnType<typeof admin>, tenantId: string): Promise<{ html: string; stuck: number; pushed: number }> {
  const { data, error } = await db.rpc("list_system_buyers");
  if (error) return { html: `<p style="color:#b00">Self-serve buyer check could not run: ${escapeHtml(error.message)}</p>`, stuck: 0, pushed: 0 };
  const stuck = stuckSystemBuyers((data ?? []) as SystemBuyerRow[]);
  if (stuck.length === 0) return { html: `<p style="color:#555">Self-serve buyers stuck after intake: none.</p>`, stuck: 0, pushed: 0 };

  let pushed = 0;
  if (VAPID_PRIVATE) {
    const tpl = {
      title: "Self-serve buyer stuck",
      body: stuck.length === 1 ? stuckLine(stuck[0]) : `${stuck.length} Self-serve buyers paid and submitted intake but have no plan or sign-in.`,
      url: "/coach/clients",
    };
    const { data: subs } = await db.from("coach_push_subscriptions").select("id, subscription").eq("tenant_id", tenantId).is("revoked_at", null);
    for (const s of subs || []) {
      try {
        await webpush.sendNotification(s.subscription, JSON.stringify(tpl));
        pushed++;
      } catch (e: any) {
        const code = e?.statusCode || "err";
        if (code === 404 || code === 410) await db.from("coach_push_subscriptions").update({ revoked_at: new Date().toISOString() }).eq("id", s.id);
      }
    }
  }

  const items = stuck.map((s) => `<li>${escapeHtml(stuckLine(s))}</li>`).join("");
  const html = `<p style="color:#b00;font-weight:600;margin:0 0 4px">Self-serve buyers stuck after intake (${stuck.length})</p>
    <p style="color:#111;margin:0 0 4px">They paid and submitted the intake 24+ hours ago. Nothing reaches them until this is fixed.</p>
    <ul style="color:#111;margin:0 0 4px;padding-left:18px">${items}</ul>
    <p style="color:#555;margin:0"><a href="${escapeHtml(APP_ORIGIN)}/coach/clients">Open Clients → Self-serve buyers</a>. A buyer who never signed in cannot be moved; add them as a client and send an intake.</p>`;
  return { html, stuck: stuck.length, pushed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "send-digest" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Shared-secret auth — same pattern as license-reconcile.
  const authz = req.headers.get("Authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!CRON_SECRET || token !== CRON_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!DIGEST_TO) {
    console.log("DIGEST_RECIPIENT not set");
    return json({ ok: true, skipped: "DIGEST_RECIPIENT not set" });
  }
  if (!RESEND_KEY) return json({ error: "RESEND_API_KEY not set" }, 500);

  try {
    const db = admin();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: ownerRow, error: ownerError } = await db.from("tenants")
      .select("id, slug")
      .eq("slug", OWNER_TENANT_SLUG)
      .maybeSingle();
    if (ownerError) throw ownerError;
    const owner = requireOwnerTenant(ownerRow);

    // This is an owner-only digest, not a multi-tenant aggregate.
    const { data: rows, error: rowsError } = await db.from("notification_log")
      .select("template, client_id, status, sent_at, consent_snapshot")
      .eq("tenant_id", owner.id)
      .gte("sent_at", since)
      .order("sent_at", { ascending: false });
    if (rowsError) throw rowsError;

    const onboarding = await onboardingSection(db, owner.id);
    const system = await systemStuckSection(db, owner.id);

    if (!rows || rows.length === 0) {
      // Send a "quiet day" digest — still useful to confirm the system is alive.
      await sendEmail({
        subject: "Daily digest",
        body: `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto">
               ${system.html}
               ${onboarding.html}
               <p style="margin-top:16px">No coach-notification activity in the last 24 hours.</p>
               <p style="color:#888;font-size:12px">This means the digest itself is working — there just wasn't anything to report.</p></div>`,
      });
      return json({ ok: true, sent: 0, digest: "quiet", onboarding: { line: onboarding.line, pushed: onboarding.pushed }, system_stuck: { n: system.stuck, pushed: system.pushed } });
    }

    // Build a clean text summary.
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const key = r.template || "unknown";
      counts[key] = (counts[key] || 0) + 1;
    }
    const total = rows.length;

    const lines = Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${k}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${v}</td></tr>`)
      .join("");

    const body = `
      <div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#111">Daily digest</h2>
        ${system.html}
        ${onboarding.html}
        <p style="color:#555;margin-top:16px">Last 24 hours — ${total} notification${total === 1 ? "" : "s"} recorded.</p>
        <table style="width:100%;border-collapse:collapse;margin-top:12px">
          <thead><tr style="background:#f5f5f5">
            <th style="text-align:left;padding:6px 8px">Type</th>
            <th style="text-align:right;padding:6px 8px">Count</th>
          </tr></thead>
          ${lines}
        </table>
        <p style="margin-top:20px;color:#999;font-size:12px">
          Sent by Coach App — ${new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
        </p>
      </div>`;

    await sendEmail({ subject: "Daily digest", body });
    return json({ ok: true, sent: total, digest: "summary", onboarding: { line: onboarding.line, pushed: onboarding.pushed }, system_stuck: { n: system.stuck, pushed: system.pushed } });

  } catch (e) {
    return json({ error: "send-digest: " + (e as Error).message }, 500);
  }
});

async function sendEmail(opts: { subject: string; body: string }) {
  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: DIGEST_FROM,
      to: [DIGEST_TO],
      subject: opts.subject,
      html: opts.body,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API ${res.status}: ${text.slice(0, 200)}`);
  }
}