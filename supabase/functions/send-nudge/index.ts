// send-nudge — nudge channel. Server-side (service role). Checks consent,
// sends Web Push, writes notification_log. SMS is PENDING A2P: the SMS
// branch is logged as "skipped_pending_a2p" until the line is registered.
// (verify_jwt=false; auth self-handled, same posture as every other function here.)
//
// POST { client_id, template? }  (Bearer JWT required; caller must be the coach of
//   that client's own tenant)
// GET  → health check.
//
// Never trust client_id alone: verify the caller coaches that client's tenant
// before sending. A future cron entry point needs the shared-secret pattern
// (CRON_SECRET), not a relaxation of the coach check below.
import { admin, callerUserId, json, CORS } from "../_shared/challenge.ts";
import webpush from "npm:web-push@3.6.7";
import { pushTemplate } from "../_shared/notification-brand.ts";

const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") || "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "send-nudge" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const userId = await callerUserId(req);
    if (!userId) return json({ error: "authentication required" }, 401);

    const { data: prof } = await admin().from("profiles").select("tenant_id, role").eq("user_id", userId).maybeSingle();
    if (!prof || prof.role !== "coach") return json({ error: "coach only" }, 403);

    const { client_id, template = "message" } = await req.json();
    if (!client_id) return json({ error: "client_id required" }, 400);

    const { data: c } = await admin().from("clients").select("*").eq("id", client_id).maybeSingle();
    if (!c) return json({ error: "client not found" }, 404);
    if (c.tenant_id !== prof.tenant_id) return json({ error: "client is not in your tenant" }, 403);

    // Consent gate.
    if (!c.notif_enabled) {
      await log(c, "push", template, "skipped_no_consent");
      return json({ sent: false, reason: "notifications off" });
    }

    const { data: tenantConfig } = await admin().from("tenant_config")
      .select("app_name")
      .eq("tenant_id", c.tenant_id)
      .maybeSingle();
    const tpl = pushTemplate(template, tenantConfig?.app_name);
    const results: Record<string, string> = {};

    // ---- Push (live) ----
    const ch = c.notif_channels || {};
    if (ch.push && c.push_subscription && VAPID_PRIVATE) {
      try {
        await webpush.sendNotification(c.push_subscription, JSON.stringify({ ...tpl, url: "/client" }));
        results.push = "sent";
        await log(c, "push", template, "sent");
      } catch (e: any) {
        results.push = "failed";
        const code = e?.statusCode || "err";
        await log(c, "push", template, "failed:" + code);
        if (code === 404 || code === 410) {
          await admin().from("clients").update({
            push_subscription: null,
            notif_channels: { ...(c.notif_channels || {}), push: false },
          }).eq("id", c.id);
        }
      }
    } else {
      results.push = "skipped";
    }

    // ---- SMS (PENDING A2P) ----
    if (ch.sms && c.phone_verified_at && c.sms_consent_at) {
      // The A2P/10DLC line is not registered yet — do NOT send. Log honestly.
      results.sms = "skipped_pending_a2p";
      await log(c, "sms", template, "skipped_pending_a2p");
    } else {
      results.sms = "skipped";
    }

    return json({ sent: results.push === "sent", results });
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 500);
  }
});

async function log(c: any, channel: string, template: string, status: string) {
  await admin().from("notification_log").insert({
    tenant_id: c.tenant_id, client_id: c.id, channel, template, status,
    consent_snapshot: { notif_enabled: c.notif_enabled, notif_channels: c.notif_channels,
      sms_consent_at: c.sms_consent_at, phone_verified_at: c.phone_verified_at },
  });
}
