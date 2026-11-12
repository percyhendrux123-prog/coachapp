// Coach-side client management. Coach ALL policies gate everything to the coach's tenant.
import { supabase } from "./supabase";

// client_type/show_date/show_name ride in the list query so the roster can show
// classification at a glance — including who is still unclassified — without a
// second round trip per client. All three are coach-controlled (guarded in
// clients_guard_self_update as of 20260731013000).
const LIST_COLS =
  "id, display_name, coaching_tier, status, subscription_status, email, client_type, show_date, show_name, sex, age, height_cm, weight_kg, goal_weight_kg, activity_level, origin, converted_from_client_id, joined_at";

export async function listClients({ includeArchived = false } = {}) {
  let query = supabase
    .from("clients")
    .select(LIST_COLS)
    .order("display_name");
  if (!includeArchived) query = query.neq("status", "archived");
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

// Slice 1 status view: one row per non-archived client from client_onboarding_facts().
// Returns null on a failed read so the caller can render "could not load" rather than an
// empty roster of statuses (a failed read and "nothing to report" are different facts).
export async function listOnboardingFacts() {
  const { data, error } = await supabase.rpc("client_onboarding_facts");
  if (error) throw error;
  return data ?? [];
}

// Coach pre-creates a client record (before the client ever logs in) so they can start
// prepping. tenant_id is stamped by create_coach_client from the session — the browser
// must not supply it. Duplicate email is raised by the RPC and, as a hard backstop, by
// the clients_tenant_email_unique index (surfaced as 23505).
export async function createClient({
  displayName, email, coachingTier, status,
  clientType, showDate, showName,
}) {
  const clean = (email || "").trim().toLowerCase();
  const { data, error } = await supabase.rpc("create_coach_client", {
    p_display_name: (displayName || "").trim(),
    p_email: clean || null,
    p_coaching_tier: coachingTier?.trim() || null,
    p_status: status || "invited",
    // Unset stays NULL rather than defaulting to lifestyle. A client created
    // without a stated type is unclassified, and the roster says so.
    p_client_type: clientType || null,
    // Show details only mean anything on a prep client; sending them on a
    // lifestyle record would leave a stale date behind if the type is corrected.
    p_show_date: clientType === "prep" ? (showDate || null) : null,
    p_show_name: clientType === "prep" ? (showName?.trim() || null) : null,
  });
  if (error) {
    if (error.code === "23505") throw new Error("A client with that email already exists.");
    throw error;
  }
  return data;
}

// Edit any coach-owned field on the client (name/email/tier/status + stats). Returns the
// refreshed list-shaped row so the caller can keep the roster in sync.
export async function updateClient(clientId, fields) {
  const { data, error } = await supabase
    .from("clients").update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", clientId).select(LIST_COLS).single();
  if (error) {
    if (error.code === "23505") throw new Error("Another client already uses that email.");
    throw error;
  }
  return data;
}

export async function archiveClient(clientId) {
  return updateClient(clientId, { status: "archived" });
}

export async function deleteClient(clientId) {
  const { error } = await supabase.from("clients").delete().eq("id", clientId);
  if (error) {
    if (error.code === "23503") {
      throw new Error(
        "This client has retained records, so delete is blocked. Archive them instead to remove them from active coaching while keeping history.",
      );
    }
    throw error;
  }
}

// Full editable profile incl. structured stats (superset of the list columns).
export async function getClientProfile(clientId) {
  const { data, error } = await supabase.from("clients")
    .select("id, tenant_id, display_name, email, coaching_tier, status, client_user_id, age, sex, height_cm, weight_kg, goal_weight_kg, activity_level, body_fat_pct, unit_pref, client_type, show_date, show_name, origin, converted_from_client_id, joined_at")
    .eq("id", clientId).single();
  if (error) throw error;
  return data;
}

// Classification only — the fast path used by the bulk classifier, where the owner is
// working down a list of unclassified clients and nothing else about the record
// should move. Deliberately narrow: it cannot touch name, tier or status even by
// accident, which matters when it is being fired 30 times in a row.
//
// Clearing back to unclassified is allowed (clientType null) and clears the show
// details with it — an undated non-prep client should not keep a show on file.
export async function setClientClassification(clientId, { clientType, showDate, showName }) {
  const isPrep = clientType === "prep";
  const patch = {
    client_type: clientType || null,
    show_date: isPrep ? (showDate || null) : null,
    show_name: isPrep ? (showName?.trim() || null) : null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("clients").update(patch).eq("id", clientId).select(LIST_COLS).single();
  if (error) throw error;
  return data;
}

// Mint a single-use invite link tied to this client record (14-day expiry). Regenerating
// (re-send) rotates the token, invalidating any older link. The invitee claims it at
// /claim?token=… via claim_client_invite(). Mirrors createIntakeInvite's coach-RLS write.
export async function createClientInvite(clientId) {
  // Goes through the client-invite edge function rather than writing the token
  // directly, because minting an invite must ALSO create the client's auth account
  // server-side (only the service role can do that). With the account pre-created,
  // the client's code request still works when the coach turns sign-ups off (the app
  // then falls back to a signup-confirmation email; see src/lib/emailAuth.js). Without
  // it, closing sign-ups would reject every first-time client as if they were a
  // stranger. See supabase/functions/client-invite/index.ts.
  const { data, error } = await supabase.functions.invoke("client-invite", {
    body: { client_id: clientId },
  });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep original */ }
    throw new Error(msg);
  }
  return `${window.location.origin}${data.claim_path}`;
}

// Slice 3 Release, step one: pre-create the client's auth account WITHOUT minting a token.
// Inert and idempotent (an unconfirmed, passwordless account with no invite cannot be used),
// so a failure here means nothing was released, and a success here changes nothing the
// client can see until release_client() runs. Returns "created" | "existed" | "no_email".
export async function prepareClientAccount(clientId) {
  const { data, error } = await supabase.functions.invoke("client-invite", {
    body: { client_id: clientId, account_only: true },
  });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep original */ }
    throw new Error(msg);
  }
  return data?.account ?? "unknown";
}

export const claimLinkFromPath = (claimPath) => `${window.location.origin}${claimPath}`;

// Coach-only. Hits client-signin-code: the one-time sign-in code the email would have
// carried, handed to the coach to read over the phone. Pre-creates the account and attaches
// the client row if either is missing. See supabase/functions/client-signin-code/index.ts.
export async function getClientSigninCode(clientId) {
  const { data, error } = await supabase.functions.invoke("client-signin-code", {
    body: { client_id: clientId },
  });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep original */ }
    throw new Error(msg);
  }
  if (!data?.code) throw new Error("No code came back. Nothing was handed out.");
  return data; // { code, email (masked), account, linked, audit_logged, audit_error }
}

// Coach-only. Hits send-nudge. Does not invent a send if the client has push off.
export async function sendClientNudge(clientId, template = "message") {
  const { data, error } = await supabase.functions.invoke("send-nudge", {
    body: { client_id: clientId, template },
  });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  return data;
}

// Coach-private notes on a client (RLS: coach-only, no client read). Newest first.
export async function getClientNotes(clientId) {
  const { data, error } = await supabase.from("client_notes")
    .select("id, body, created_at, updated_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function addClientNote({ tenantId, clientId, userId, body }) {
  const { error } = await supabase.from("client_notes").insert({
    tenant_id: tenantId, client_id: clientId, author_user_id: userId, body: body.trim(),
  });
  if (error) throw error;
}

export async function updateClientNote(id, body) {
  const { error } = await supabase.from("client_notes")
    .update({ body: body.trim(), updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

export async function getClientCheckins(clientId) {
  const { data, error } = await supabase
    .from("checkins")
    .select("id, submitted_at, weight, answers, coach_seen, photo_urls")
    .eq("client_id", clientId)
    .order("submitted_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data ?? [];
}

export async function markCheckinSeen(id) {
  const { error } = await supabase.from("checkins").update({ coach_seen: true }).eq("id", id);
  if (error) throw error;
}

// Full program row (not just the name): the client-view Program tab embeds the same
// inline editor the Programs page uses, so it needs structure plus active-assignment
// usage (active_client_ids drives the builder's mid-cycle edit-safety warning).
export async function getClientProgram(clientId) {
  const { data: a } = await supabase
    .from("assignments")
    .select("current_day_index, active, program_id")
    .eq("client_id", clientId).eq("active", true).maybeSingle();
  if (!a) return null;
  const [{ data: p }, { data: actives }] = await Promise.all([
    supabase.from("programs")
      .select("id, name, structure, is_default, source_draft_id, created_at")
      .eq("id", a.program_id).maybeSingle(),
    supabase.from("assignments").select("client_id").eq("program_id", a.program_id).eq("active", true),
  ]);
  if (!p) return { assignment: a, program: null };
  return { assignment: a, program: { ...p, active_client_ids: (actives ?? []).map((x) => x.client_id) } };
}

// Client-initiated day-swap events (schedule_adjustments), newest first — the coach
// surface for spotting one client's pattern (or a repeated re-move of the same day
// across blocks, which the log makes visible on its own — decision 3 in the plan).
// v1 is a plain per-client list; no roster-wide rollup (explicitly out of scope).
export async function getClientScheduleAdjustments(clientId, { limit = 20 } = {}) {
  const { data, error } = await supabase
    .from("schedule_adjustments")
    .select("id, assignment_id, old_order, new_order, reason_tag, reason_note, created_at")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

// A client's workout sessions + set logs (coach SELECT RLS), with each session's
// program structure fetched via its assignment so days/exercises resolve by uuid —
// across cycles and across program switches, not just the active assignment.
export async function getClientWorkouts(clientId) {
  const { data: sessions, error } = await supabase
    .from("workout_sessions")
    .select("id, day_id, session_date, status, completed_at, assignment_id, workout_logs(exercise_id, set_index, weight, reps, duration_seconds, distance_meters, rpe, done)")
    .eq("client_id", clientId)
    .order("session_date", { ascending: false })
    .limit(30);
  if (error) throw error;
  const ids = [...new Set((sessions ?? []).map((s) => s.assignment_id))];
  const programByAssignment = {};
  if (ids.length > 0) {
    const { data: assigns, error: e2 } = await supabase
      .from("assignments")
      .select("id, programs(id, name, structure)")
      .in("id", ids);
    if (e2) throw e2;
    for (const a of assigns ?? []) programByAssignment[a.id] = a.programs;
  }
  return { sessions: sessions ?? [], programByAssignment };
}

// Submitted consultation/intake responses for a client (coach ALL RLS). Newest first —
// a client who re-does the intake gets a fresh intake_forms row, so this can return
// several. Pending/expired invites (no answers yet) are excluded.
export async function getClientIntakes(clientId) {
  const { data, error } = await supabase
    .from("intake_forms")
    .select("id, answers, health_flags, status, submitted_at, created_at")
    .eq("client_id", clientId)
    .eq("status", "submitted")
    .order("submitted_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return data ?? [];
}

export async function getClientMessages(clientId) {
  const { data, error } = await supabase
    .from("messages")
    .select("id, sender_role, body, sent_at")
    .eq("client_id", clientId)
    .order("sent_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

// Sending a reply is a PURE APPEND. It must never acknowledge unread inbound
// client messages — replying to one message is not proof the coach has seen
// the other N-1 unread items in the thread (Cockpit quick replies, per-client
// tab sends, and agent sends all reach this without triage intent). Unread
// state clears only through the explicit acknowledgment paths: Inbox
// openThread / deep-link → markThreadRead below, or the MCP mark_thread_read
// tool for connector agents.
export async function sendCoachMessage({ clientId, body }) {
  const { error } = await supabase.rpc("send_coach_message", {
    p_client_id: clientId,
    p_body: body,
  });
  if (error) throw error;
}

// Unified inbox: one row per client that has messages, with the latest message
// preview and this coach's unread count (client messages newer than their read
// pointer). Newest-active thread first. Backed by the coach_inbox() RPC.
export async function getCoachInbox() {
  const { data, error } = await supabase.rpc("coach_inbox");
  if (error) throw error;
  return data ?? [];
}

// Stamp this coach's read pointer for a thread to now(), clearing its unread badge.
export async function markThreadRead(clientId) {
  const { error } = await supabase.rpc("mark_thread_read", { p_client_id: clientId });
  if (error) throw error;
}

// ── Trainerize archive (coach read; ta_coach_read RLS) ──────────────────────────────
// Historical data the importer preserves verbatim because it has no live home in the
// coachapp model: performed workout sessions (real kg × reps × rpe) and meal logs
// (adherence merged in). Weights in these payloads are KG as Trainerize exported them —
// the UI must label them, since live tenant data is usually lb.

// Row counts per kind — cheap head queries so the Archive tab only appears for
// clients that actually have imported history.
export async function getClientArchiveCounts(clientId) {
  const count = async (kind) => {
    const { count: n, error } = await supabase
      .from("trainerize_archive")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId).eq("kind", kind);
    if (error) throw error;
    return n ?? 0;
  };
  const [workouts, meals] = await Promise.all([count("workout_session"), count("meal")]);
  return { workouts, meals, total: workouts + meals };
}

// One kind's rows, newest first, paged for clients with long histories.
export async function getClientArchive(clientId, kind, { limit = 40, offset = 0 } = {}) {
  const { data, error } = await supabase
    .from("trainerize_archive")
    .select("id, kind, trainerize_id, occurred_at, payload, imported_at")
    .eq("client_id", clientId).eq("kind", kind)
    .order("occurred_at", { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data ?? [];
}
