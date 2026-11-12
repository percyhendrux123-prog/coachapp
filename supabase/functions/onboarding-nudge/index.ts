// onboarding-nudge — the daily reminder run on onboarding stalls.
//
// Called by pg_cron (onboarding-nudge-daily) with the vault bearer, exactly like
// license-reconcile and send-digest. No public trigger surface, no JWT path.
//
// The database decides WHO is due (onboarding_reminders_due(): thresholds, dedupe, switch,
// sender, email, push facts). This function decides nothing about eligibility — it renders
// the approved copy, sends, and writes one notification_log row per (client, channel,
// template, threshold day, token) saying what happened. A skip is a row too
// (skipped_switch_off / skipped_no_sender / skipped_sender_unverified / skipped_no_email),
// written once per stall step, so "nothing was sent" is always distinguishable from
// "nothing was due". Every run writes ops_job_runs.
//
// POST {}            → run. Authorization: Bearer CRON_SECRET required.
// POST { dry: true } or ?dry=1 → no send, no log write: returns exactly who WOULD be messaged
//                      and, for each, the decision the live run would make.
// GET                → health.
import { admin, json, CORS } from "../_shared/challenge.ts";
import webpush from "npm:web-push@3.6.7";
import {
  type Candidate, decide, fromHeader, idempotencyKey, reminderMessage,
} from "../_shared/onboardingReminders.ts";

const JOB = "onboarding-nudge";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
// The SPA origin the emailed links point at (no request origin on a cron call).
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") || "http://localhost:5173";
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
if (VAPID_PUBLIC && VAPID_PRIVATE) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

type Db = ReturnType<typeof admin>;

async function record(db: Db, startedAt: string, outcome: string, healthy: boolean, detail: Record<string, unknown>) {
  const { error } = await db.from("ops_job_runs").insert({
    job: JOB, started_at: startedAt, finished_at: new Date().toISOString(), outcome, healthy, detail,
  });
  return error ? error.message : null;
}

// Domains Resend will actually send from. A sender on any other domain is skipped and
// logged as such rather than failing at send time and reading as a transport error.
async function verifiedDomains(): Promise<{ domains: Set<string>; error: string | null }> {
  if (!RESEND_KEY) return { domains: new Set(), error: "RESEND_API_KEY not set" };
  try {
    const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${RESEND_KEY}` } });
    if (!res.ok) return { domains: new Set(), error: `Resend domains ${res.status}` };
    const body = await res.json();
    const names = (body?.data || []).filter((d: any) => d?.status === "verified").map((d: any) => String(d.name).toLowerCase());
    return { domains: new Set(names), error: null };
  } catch (e) {
    return { domains: new Set(), error: (e as Error).message };
  }
}

async function log(db: Db, c: Candidate, channel: "push" | "sms" | "in_app", status: string, extra: Record<string, unknown> = {}) {
  // notification_log.channel is an enum {push, sms, in_app}; email reminders are logged as
  // in_app with consent_snapshot.channel = 'email' (the same posture as the coach sign-in code).
  const { error } = await db.from("notification_log").insert({
    tenant_id: c.tenant_id, client_id: c.client_id, channel, template: c.template, status,
    consent_snapshot: {
      channel: channel === "in_app" ? "email" : channel,
      threshold_day: String(c.threshold_day), ref: c.ref, days_since: c.days_since,
      sender: c.sender_email, switch_on: c.switch_on, ...extra,
    },
  });
  // A duplicate skip row (same stall step, same status, next day) is the unique index doing
  // its job — not an error. Anything else is reported.
  if (error && !/duplicate key|unique/i.test(error.message)) return error.message;
  return null;
}

async function sendEmail(from: string, to: string, m: { subject: string; text: string; html: string }, key: string): Promise<string | null> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}`, "Idempotency-Key": key },
    body: JSON.stringify({ from, to: [to], subject: m.subject, text: m.text, html: m.html }),
  });
  if (!res.ok) return `Resend ${res.status}: ${(await res.text()).slice(0, 200)}`;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: JOB });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!CRON_SECRET || (req.headers.get("authorization") || "") !== `Bearer ${CRON_SECRET}`) {
    return json({ error: "forbidden" }, 403);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is the cron's normal call */ }
  const dry = body?.dry === true || new URL(req.url).searchParams.get("dry") === "1";

  const startedAt = new Date().toISOString();
  const db = admin();

  const { data: due, error: dueErr } = await db.rpc("onboarding_reminders_due");
  if (dueErr) {
    const logErr = dry ? null : await record(db, startedAt, "error", false, { stage: "select due", message: dueErr.message });
    return json({ outcome: "error", healthy: false, error: dueErr.message, log_error: logErr }, 500);
  }
  const candidates = (due ?? []) as Candidate[];

  const { domains, error: domErr } = await verifiedDomains();

  // Tenant display names for the from header / push title, read once per run.
  const tenantIds = [...new Set(candidates.map((c) => c.tenant_id))];
  const names = new Map<string, { app_name: string | null; coach_display_name: string | null }>();
  if (tenantIds.length) {
    const { data: tcs } = await db.from("tenant_config").select("tenant_id, app_name, coach_display_name").in("tenant_id", tenantIds);
    for (const t of tcs || []) names.set(t.tenant_id, { app_name: t.app_name, coach_display_name: t.coach_display_name });
  }

  const results: Record<string, unknown>[] = [];
  let sent = 0, skipped = 0, failed = 0;
  const errors: string[] = [];
  if (domErr) errors.push("domains: " + domErr);

  for (const c of candidates) {
    const d = decide(c, domains);
    const base = {
      tenant: c.tenant_slug, client_id: c.client_id, display_name: c.display_name, template: c.template,
      threshold_day: c.threshold_day, days_since: c.days_since, email: c.email ? c.email.replace(/^(.).*?(.?)@/, (_m, a, b) => `${a}…${b}@`) : null,
    };

    if (d.action === "skip") {
      skipped++;
      results.push({ ...base, decision: d.status });
      if (!dry) { const e = await log(db, c, "in_app", d.status); if (e) errors.push(e); }
      continue;
    }

    results.push({ ...base, decision: "send", channels: d.channels });
    if (dry) continue;

    const tn = names.get(c.tenant_id);
    const m = reminderMessage(c.template, c.threshold_day, `${APP_ORIGIN}${c.link_path}`, tn?.app_name);
    const from = fromHeader(c.sender_email!, tn?.coach_display_name);
    const emailErr = await sendEmail(from, c.email!, m, idempotencyKey(c));
    if (emailErr) {
      failed++;
      errors.push(`${c.client_id}/${c.template}: ${emailErr}`);
      const e = await log(db, c, "in_app", "failed:email", { error: emailErr.slice(0, 200) });
      if (e) errors.push(e);
    } else {
      sent++;
      const e = await log(db, c, "in_app", "sent", { from, subject: m.subject });
      if (e) errors.push(e);
    }

    if (d.channels.includes("push") && m.push && VAPID_PRIVATE && c.push_subscription) {
      try {
        await webpush.sendNotification(c.push_subscription as any, JSON.stringify(m.push));
        const e = await log(db, c, "push", "sent"); if (e) errors.push(e);
      } catch (e: any) {
        const code = e?.statusCode || "err";
        const le = await log(db, c, "push", "failed:" + code); if (le) errors.push(le);
        if (code === 404 || code === 410) {
          await db.from("clients").update({ push_subscription: null }).eq("id", c.client_id);
        }
      }
    }
  }

  const outcome = candidates.length === 0 ? "nothing_due" : failed > 0 ? "partial" : "ran";
  const healthy = failed === 0 && errors.length === 0;
  const detail = { dry, due: candidates.length, sent, skipped, failed, errors, verified_domains: [...domains] };
  const logErr = dry ? null : await record(db, startedAt, outcome, healthy, detail);
  return json({ outcome, healthy, dry, due: candidates.length, sent, skipped, failed, errors, verified_domains: [...domains], results, log_error: logErr });
});
