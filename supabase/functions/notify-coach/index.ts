// notify-coach — coach-side Web Push. Server-side only.
//
// Called by the DB trigger notify_coach_of_client_event() (pg_net) when a client sends a
// message or submits a check-in. Gated by CRON_SECRET, the same bearer the pg_cron jobs
// present to license-reconcile — there is no public trigger surface and no JWT path.
//
// Trust posture: the body is only a pointer. The row is re-read with the service role
// and must match the tenant + client named in the body before anything is sent; a
// message must really be from the client. Every send is written to notification_log
// (channel 'push', template 'coach_message' | 'coach_checkin') so a claim of "sent"
// is observable. Dead endpoints (404/410) are revoked in place.
//
// POST { kind: "message"|"checkin", tenant_id, client_id, row_id }
// GET  → health.
import { admin, json, CORS } from "../_shared/challenge.ts";
import webpush from "npm:web-push@3.6.7";
import { coachPushTemplate } from "../_shared/notification-brand.ts";

const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "notify-coach" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!CRON_SECRET || (req.headers.get("authorization") || "") !== `Bearer ${CRON_SECRET}`) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!VAPID_PRIVATE) return json({ sent: 0, reason: "push_not_configured" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { kind, tenant_id, client_id, row_id } = body || {};
  if (kind !== "message" && kind !== "checkin") return json({ error: "kind must be message|checkin" }, 400);
  for (const v of [tenant_id, client_id, row_id]) {
    if (typeof v !== "string" || !UUID.test(v)) return json({ error: "tenant_id, client_id, row_id must be uuids" }, 400);
  }

  const db = admin();

  // Re-read the event row. The trigger's body is a pointer, never the truth.
  const table = kind === "message" ? "messages" : "checkins";
  const cols = kind === "message" ? "id, tenant_id, client_id, sender_role, body" : "id, tenant_id, client_id";
  // `cols` is a runtime union, which defeats supabase-js's select-string type parser — the
  // row is read as `any` on purpose; the checks below are the real contract.
  const { data } = await db.from(table).select(cols).eq("id", row_id).maybeSingle();
  const row = data as any;
  if (!row || row.tenant_id !== tenant_id || row.client_id !== client_id) {
    return json({ sent: 0, reason: "row_not_found" }, 404);
  }
  if (kind === "message" && (row as any).sender_role !== "client") {
    return json({ sent: 0, reason: "not_a_client_message" });
  }

  const { data: client } = await db.from("clients").select("id, display_name").eq("id", client_id).maybeSingle();
  const { data: subs } = await db
    .from("coach_push_subscriptions")
    .select("id, user_id, subscription")
    .eq("tenant_id", tenant_id)
    .is("revoked_at", null);
  if (!subs || subs.length === 0) return json({ sent: 0, reason: "no_coach_subscriptions" });

  const tpl = coachPushTemplate(kind, client?.display_name, kind === "message" ? (row as any).body : undefined);
  const template = kind === "message" ? "coach_message" : "coach_checkin";
  let sent = 0, failed = 0, revoked = 0;

  for (const s of subs) {
    try {
      await webpush.sendNotification(s.subscription, JSON.stringify(tpl));
      sent++;
      await db.from("coach_push_subscriptions").update({ last_used_at: new Date().toISOString() }).eq("id", s.id);
      await log(db, tenant_id, client_id, template, "sent", s.id);
    } catch (e: any) {
      failed++;
      const code = e?.statusCode || "err";
      await log(db, tenant_id, client_id, template, "failed:" + code, s.id);
      if (code === 404 || code === 410) {
        revoked++;
        await db.from("coach_push_subscriptions").update({ revoked_at: new Date().toISOString() }).eq("id", s.id);
      }
    }
  }

  return json({ sent, failed, revoked });
});

async function log(db: any, tenant_id: string, client_id: string, template: string, status: string, subscriptionId: string) {
  await db.from("notification_log").insert({
    tenant_id, client_id, channel: "push", template, status,
    consent_snapshot: { coach_subscription_id: subscriptionId },
  });
}
