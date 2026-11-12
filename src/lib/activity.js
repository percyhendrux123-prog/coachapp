import { supabase } from "./supabase";
import { trainingEventsFromSessions, mergeActivityFeeds } from "./activityFeed";

const ACTIVITY_SELECT = "id, tenant_id, client_id, channel, template, sent_at, status, consent_snapshot, clients(display_name)";

export async function listActivity({ limit = 50 } = {}) {
  const { data, error } = await supabase
    .from("notification_log")
    .select(ACTIVITY_SELECT)
    .eq("channel", "in_app")
    .order("sent_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(normalizeActivity);
}

// The ledger + live training events, merged newest-first. Training events are
// NOT in notification_log (nothing writes them there — see activityFeed.js's
// header), so a ledger-only read silently omits the whole category while the
// Home cockpit shows it live. The two fetches fail independently: a training
// read failure returns the ledger WITH trainingFeedError set, so the page can
// say "this list is missing training events" instead of presenting an
// incomplete feed as complete — never the other way around silently.
export async function listActivityWithTraining({ limit = 80 } = {}) {
  const [ledger, training] = await Promise.allSettled([
    listActivity({ limit }),
    supabase
      .from("workout_sessions")
      .select("id, status, completed_at, session_date, clients(display_name), workout_logs(done, logged_at)")
      .order("session_date", { ascending: false })
      .limit(40),
  ]);
  if (ledger.status === "rejected") throw ledger.reason;

  if (training.status === "rejected" || training.value.error) {
    return { rows: ledger.value, trainingFeedError: true };
  }
  const trainingRows = trainingEventsFromSessions(training.value.data ?? []);
  return { rows: mergeActivityFeeds(ledger.value, trainingRows, { limit }), trainingFeedError: false };
}

export async function recordActivity({ tenantId, clientId, template, detail = {}, status = "recorded" }) {
  if (!tenantId || !clientId || !template) return;
  const { error } = await supabase.from("notification_log").insert({
    tenant_id: tenantId,
    client_id: clientId,
    channel: "in_app",
    template,
    status,
    consent_snapshot: detail,
  });
  if (error) throw error;
}

function normalizeActivity(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    template: row.template,
    at: row.sent_at,
    status: row.status,
    detail: row.consent_snapshot ?? {},
    clientName: row.clients?.display_name ?? "Client",
    label: labelFor(row.template, row.consent_snapshot ?? {}),
  };
}

function labelFor(template, detail) {
  if (template === "checkin_submitted") return "submitted a check-in";
  if (template === "client_message_sent") return "messaged the coach";
  if (template === "coach_message_sent") return "was sent a coach message";
  if (template === "cockpit_draft_sent") return `was sent a Cockpit draft${detail?.style ? ` (${detail.style})` : ""}`;
  if (template === "client_archived") return "was archived";
  if (template === "client_restored") return "was restored";
  if (template === "program_changed") return "had their program changed";
  return template.replace(/_/g, " ");
}
