// Client-side coaching data layer. All reads/writes go through RLS scoped to the
// signed-in client (current_client_id / current_tenant_id).
import { supabase } from "./supabase";
import {
  messageCursorForRow,
  messageCursorPostgrestFilter,
  normalizeMessageCursor,
} from "./clientMessagePresence";

export async function getMyClient() {
  const { data, error } = await supabase
    .from("clients")
    .select(
      "id, display_name, coaching_tier, subscription_status, status, email, sex, age, unit_pref, height_cm, height_in, weight_kg, weight_lb, goal_weight_lb, goal_weight_kg, activity_level, client_type, checkin_cadence, checkin_day_of_week, show_name, show_date, joined_at, welcome_seen, notif_enabled, notif_channels, push_subscription",
    )
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Active assignment → its program.
export async function getMyProgram() {
  const { data: a } = await supabase
    .from("assignments")
    .select("id, current_day_index, active, program_id, assigned_at, ends_on, block_weeks, day_order")
    .eq("active", true)
    .maybeSingle();
  if (!a) return null;
  const { data: p } = await supabase
    .from("programs")
    .select("id, name, structure, meal_plan")
    .eq("id", a.program_id)
    .maybeSingle();
  return { assignment: a, program: p };
}

// Tenant check-in question set, from the published white-label snapshot. Tenants
// published before the checkin key existed fall back to the legacy weight+note form.
export async function getCheckinConfig() {
  const { data, error } = await supabase.rpc("get_app_config");
  if (error) throw error;
  return data?.checkin ?? null;
}

// Upload check-in photos under the tenant prefix the photos_client_write storage
// policy requires. Returns storage paths.
export async function uploadCheckinPhotos({ tenantId, clientId, files }) {
  const paths = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const ext = (f.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${tenantId}/${clientId}/checkins/${stamp}-${i + 1}.${ext}`;
    const { error } = await supabase.storage.from("progress-photos").upload(path, f, { contentType: f.type || "image/jpeg" });
    if (error) throw error;
    paths.push(path);
  }
  return paths;
}

export async function listCheckins() {
  const { data, error } = await supabase
    .from("checkins")
    .select("id, submitted_at, weight, answers, coach_seen")
    .order("submitted_at", { ascending: false })
    .limit(12);
  if (error) throw error;
  return data ?? [];
}

export async function submitCheckin({ clientId, tenantId, weight, answers, photoPaths = [] }) {
  const w = weight === "" || weight == null ? null : Number(weight);
  const { data: ck, error } = await supabase.from("checkins").insert({
    client_id: clientId, tenant_id: tenantId,
    weight: w, answers, submitted_at: new Date().toISOString(),
    ...(photoPaths.length ? { photo_urls: photoPaths } : {}),
  }).select("id").single();
  if (error) throw error;

  // Feed the weight trend + photo timeline (client RLS policies pw/pp_client_insert).
  // These stay best-effort — the check-in itself is already saved, and throwing here
  // would tell the client their check-in failed when it didn't, inviting a duplicate
  // submit. But "best-effort" must not mean "silent": previously both inserts did
  // `.then(() => {}, () => {})`, so a failure left the weight trend and photo timeline
  // quietly missing data while the client saw a clean success. Failures are now
  // collected and returned so the caller can say so, and logged for the console.
  const warnings = [];

  if (w != null) {
    const { error: wErr } = await supabase.from("progress_weights").insert({
      client_id: clientId, tenant_id: tenantId,
      date: new Date().toISOString().slice(0, 10), weight: w, source_checkin_id: ck.id,
    });
    if (wErr) {
      console.error("check-in: weight was not added to your trend chart", wErr);
      warnings.push("Your weight was saved with the check-in, but didn't make it onto your trend chart.");
    }
  }

  let photoFailures = 0;
  for (const path of photoPaths) {
    const { error: pErr } = await supabase.from("progress_photos").insert({
      client_id: clientId, tenant_id: tenantId,
      taken_at: new Date().toISOString(), photo_url: path, source_checkin_id: ck.id,
    });
    if (pErr) {
      console.error("check-in: photo was not added to your timeline", path, pErr);
      photoFailures += 1;
    }
  }
  if (photoFailures > 0) {
    warnings.push(
      photoFailures === 1
        ? "One photo uploaded but didn't make it onto your progress timeline."
        : `${photoFailures} photos uploaded but didn't make it onto your progress timeline.`,
    );
  }

  return { id: ck.id, warnings };
}

// Fire this after a check-in submits, best-effort — the machine's read of the
// check-in (Default Paralysis Loop stage proposal, see the implementation specification).
// Never call this to gate or delay a successful submit: the check-in is already
// saved before this runs, and this is designed to be safe to skip entirely (a
// coach with no assessment row just sees "no read yet," same as a generator
// that hasn't been wired up at all).
export async function requestCheckinAssessment(checkinId) {
  const { data, error } = await supabase.functions.invoke("checkin-assess", {
    body: { checkin_id: checkinId },
  });
  if (error) throw error;
  return data;
}

export async function listMessages() {
  const { data, error } = await supabase
    .from("messages")
    .select("id, sender_role, body, sent_at")
    // Read the newest window so a long thread cannot hide a fresh coach message
    // beyond the limit. Reverse below to preserve the existing oldest-to-newest UI.
    .order("sent_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(100);
  if (error) throw error;
  return [...(data ?? [])].reverse();
}

export async function getLatestCoachMessageCursor() {
  const { data, error } = await supabase
    .from("messages")
    .select("id, sent_at")
    .eq("sender_role", "coach")
    .order("sent_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? messageCursorForRow(data) : null;
}

export async function countUnreadCoachMessagesAfter(lastSeenCursor) {
  const cursor = normalizeMessageCursor(lastSeenCursor);
  const filter = messageCursorPostgrestFilter(cursor);
  if (!cursor || !filter) return 0;
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("sender_role", "coach")
    .or(filter);
  if (error) throw error;
  return count ?? 0;
}

export async function sendMessage({ clientId, tenantId, body }) {
  const { error } = await supabase.from("messages").insert({
    client_id: clientId, tenant_id: tenantId, sender_role: "client", body,
  });
  if (error) throw error;
}

export async function listResources() {
  const { data, error } = await supabase
    .from("resources")
    .select("id, title, description, type, file_url")
    .order("sort", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function listMyActivity({ limit = 50 } = {}) {
  const { data, error } = await supabase
    .from("notification_log")
    .select("id, template, sent_at, status, consent_snapshot")
    .eq("channel", "in_app")
    .order("sent_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    template: row.template,
    at: row.sent_at,
    status: row.status,
    detail: row.consent_snapshot ?? {},
    label: activityLabel(row.template),
  }));
}

// Self-serve only: mint a fresh intake token for my own client row (28-day limit enforced
// in the database). Errors surface by name: not_self_serve, too_soon:YYYY-MM-DD.
export async function mintMyIntakeToken() {
  const { data, error } = await supabase.rpc("mint_my_intake_token");
  if (error) throw new Error(error.message);
  return data;
}

function activityLabel(template) {
  if (template === "checkin_submitted") return "You submitted a check-in";
  if (template === "client_message_sent") return "You messaged your coach";
  if (template === "coach_message_sent") return "Your coach sent you a message";
  if (template === "cockpit_draft_sent") return "Your coach sent you a message";
  if (template === "program_changed") return "Your program changed";
  return template.replace(/_/g, " ");
}
