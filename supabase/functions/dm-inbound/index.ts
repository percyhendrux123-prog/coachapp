// dm-inbound — inbound Instagram-DM lead webhook (verify_jwt=false; auth self-handled).
// Every keyword-trigger DM the DM automation sees lands here as a row in dm_inbound (+ a
// dm_conversations / dm_messages pair) for the Setter/Closer pipeline to pick up.
//
// AUTH (pentest F1, 2026-09-05). This used to be fully open — "same trust model as
// sms-inbound: no shared secret" — and an anonymous POST from the bare URL wrote a lead row
// during a security test. sms-inbound had since been locked; this had not. Now
// gated by CRON_SECRET, the same `Authorization: Bearer <CRON_SECRET>` the pg_cron jobs and
// notify-coach use. Any DM automation that posts here must send the bearer.
// Malformed bodies return 400, not 500 (F4).
//
// POST (JSON or form-encoded) { subscriber_id, contact_name?, ig_username?, last_input_text?, keyword_tag? }
//   → { ok: true, id, conversation_id, message_id }
// GET → health check (open; reports nothing but the service name).
import { admin, json, CORS } from "../_shared/challenge.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const MAX_LEN = 2000;
const clip = (s: string) => s.slice(0, MAX_LEN);

// Find or create a conversation by subscriber_id or ig_username. Returns the convo id.
// Updates last_message_at even if the convo already exists (every DM counts as activity).
async function upsertConversation(db: any, msg: any): Promise<string> {
  const subscriber = (msg.ig_username || msg.subscriber_id || "").toLowerCase().trim();
  // Try to find existing by IG username first, then subscriber_id.
  let convo = null;
  if (subscriber) {
    const lookup = await db.from("dm_conversations").select("id").eq("ig_username", subscriber).maybeSingle();
    if (lookup.error) throw new Error("conversation lookup by username: " + lookup.error.message);
    convo = lookup.data;
  }
  if (!convo && msg.subscriber_id) {
    const lookup = await db.from("dm_conversations").select("id").eq("subscriber_id", msg.subscriber_id).maybeSingle();
    if (lookup.error) throw new Error("conversation lookup by subscriber: " + lookup.error.message);
    convo = lookup.data;
  }
  if (convo) {
    const update = await db.from("dm_conversations").update({
      last_message_at: new Date().toISOString(),
      keyword_trigger: msg.keyword_tag || undefined,
    }).eq("id", convo.id);
    if (update.error) throw new Error("conversation update: " + update.error.message);
    return convo.id;
  }
  const ins = await db.from("dm_conversations").insert({
    ig_username: msg.ig_username || subscriber,
    contact_name: msg.contact_name || null,
    subscriber_id: msg.subscriber_id || null,
    lead_status: "new",
    keyword_trigger: msg.keyword_tag || null,
    first_message_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
  }).select("id").single();
  if (ins.error) throw new Error("conversation insert: " + ins.error.message);
  return ins.data.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "dm-inbound" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Shared-secret gate. An unset secret fails closed — never "open because unconfigured".
  if (!CRON_SECRET || (req.headers.get("authorization") || "") !== `Bearer ${CRON_SECRET}`) {
    return json({ error: "unauthorized" }, 401);
  }

  // Body parsing is outside the main try so a malformed request is a 400, not a 500.
  let body: Record<string, unknown> = {};
  try {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      body = await req.json();
    } else {
      const f = await req.formData();
      for (const [k, v] of f.entries()) body[k] = String(v);
    }
  } catch {
    return json({ error: "malformed body: send JSON or form-encoded fields" }, 400);
  }

  try {

    const subscriber_id = String(body.subscriber_id ?? body.id ?? "").trim();
    if (!subscriber_id) return json({ error: "subscriber_id required" }, 400);

    const lastInputText = String(body.last_input_text ?? "").trim();
    const row = {
      subscriber_id: clip(subscriber_id),
      contact_name: body.contact_name || body.name
        ? clip(String(body.contact_name ?? body.name).trim())
        : null,
      ig_username: body.ig_username || body.instagram_username || body.username
        ? clip(String(body.ig_username ?? body.instagram_username ?? body.username).trim())
        : null,
      last_input_text: lastInputText ? clip(lastInputText) : null,
      keyword_tag: body.keyword_tag || lastInputText
        ? clip(String(body.keyword_tag ?? lastInputText).trim())
        : null,
    };

    const { data, error } = await admin().from("dm_inbound").insert(row).select("id").single();
    if (error) return json({ error: error.message }, 500);

    // --- DM conversation memory ---
    // Every inbound DM also writes to the conversation store so Setter/Closer agents
    // have memory of every lead between messages. Upsert conversation + insert message.
    const db = admin();
    const lookupKey = row.ig_username || row.subscriber_id;
    if (lookupKey) {
      const convoId = await upsertConversation(db, row);
      const message = await db.from("dm_messages").insert({
        conversation_id: convoId,
        direction: "inbound",
        content: row.last_input_text || "(no text)",
        agent_role: null,
        status: "sent",
      }).select("id").single();
      if (message.error) throw new Error("message insert: " + message.error.message);

      return json({ ok: true, id: data.id, conversation_id: convoId, message_id: message.data.id });
    }

    return json({ error: "conversation key required" }, 400);
  } catch (e) {
    return json({ error: "dm-inbound: " + (e as Error).message }, 500);
  }
});
