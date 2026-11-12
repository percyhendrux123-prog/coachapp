// sms-inbound — P4 §3 carrier webhook for STOP / HELP / START. Public endpoint
// (verify_jwt=false). Reconciles carrier opt-out with the in-app toggle so the
// two can never disagree. Live now for compliance even while outbound SMS is
// pending A2P — an inbound STOP must always be honored.
import { createClient } from "npm:@supabase/supabase-js@2";
import { notificationAppName } from "../_shared/notification-brand.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  try {
    // Accept both form-encoded (typical carrier webhook) and JSON.
    let from = "", body = "";
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await req.json(); from = j.From || j.from || ""; body = j.Body || j.body || "";
    } else {
      const f = await req.formData(); from = String(f.get("From") || f.get("from") || ""); body = String(f.get("Body") || f.get("body") || "");
    }
    const keyword = body.trim().toUpperCase();
    const phone = from.trim();
    if (!phone) return xml("<Response></Response>");

    const { data: c } = await admin.from("clients").select("*").eq("phone_e164", phone).maybeSingle();
    const { data: cfg } = c
      ? await admin.from("tenant_config").select("app_name").eq("tenant_id", c.tenant_id).maybeSingle()
      : { data: null };
    const appName = notificationAppName(cfg?.app_name);

    if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(keyword)) {
      if (c) {
        await admin.from("clients").update({
          notif_channels: { ...(c.notif_channels || {}), sms: false },
          // G6 (2026-08-09): keep sms_consent_at — do not null it on STOP.
          // sms_consent_at is the TCPA consent trail; withdrawal is recorded
          // separately via consent_events below. Nulling the original consent
          // timestamp destroys the proof that consent was once given.
          sms_opted_out_at: new Date().toISOString(),
        }).eq("id", c.id);
        await admin.from("consent_events").insert({
          tenant_id: c.tenant_id, client_id: c.id, event_type: "stop_keyword", channel: "sms",
          phone_e164: phone, prior_state: { sms: true }, new_state: { sms: false }, source: "sms_inbound",
        });
      }
      return xml(`<Response><Message>${appName}: You are unsubscribed. No more messages will be sent. Reply START to re-subscribe.</Message></Response>`);
    }

    if (keyword === "HELP") {
      if (c) await admin.from("consent_events").insert({ tenant_id: c.tenant_id, client_id: c.id, event_type: "help_keyword", channel: "sms", phone_e164: phone, source: "sms_inbound" });
      return xml(`<Response><Message>${appName}: For help contact your coach in-app. Msg and data rates may apply. Reply STOP to opt out.</Message></Response>`);
    }

    if (["START", "UNSTOP", "YES"].includes(keyword)) {
      // Re-subscribe requires a fresh in-app opt-in with disclosures + OTP; here
      // we only log the inbound intent (P4: never a silent flip back on).
      if (c) await admin.from("consent_events").insert({ tenant_id: c.tenant_id, client_id: c.id, event_type: "start_keyword", channel: "sms", phone_e164: phone, source: "sms_inbound" });
      return xml(`<Response><Message>${appName}: To turn texts back on, re-enable SMS in your app settings.</Message></Response>`);
    }

    return xml("<Response></Response>");
  } catch (_e) {
    return xml("<Response></Response>");
  }
});

function xml(s: string) {
  return new Response(s, { headers: { "Content-Type": "application/xml" } });
}
