// Participant-side data layer for the public challenge funnel.
// Reads go through RLS (published challenge/standards are public; a participant sees
// only their own run + day logs). Mutations go through the edge functions so the
// server owns integrity (a participant can't self-mark a perfect week).
import { supabase } from "./supabase";
import { functionError } from "./challengeRunFlow";

export async function getPublishedChallenge(slug) {
  const { data, error } = await supabase
    .from("challenges")
    .select("id, slug, title, subtitle, description, duration_days, num_standards, reward_type, status")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getStandards(challengeId) {
  const { data, error } = await supabase
    .from("challenge_standards")
    .select("id, ordinal, title, description")
    .eq("challenge_id", challengeId)
    .order("ordinal");
  if (error) throw error;
  return data ?? [];
}

// RLS returns only the caller's own run (participant_user_id = auth.uid()).
export async function getMyRun(challengeId) {
  const { data, error } = await supabase
    .from("challenge_runs")
    .select("id, status, current_day_index, perfect_week, reward_granted_at, started_at, completed_at")
    .eq("challenge_id", challengeId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function getDayLogs(runId) {
  const { data, error } = await supabase
    .from("challenge_day_logs")
    .select("day_index, standards_hit, all_standards_met")
    .eq("run_id", runId)
    .order("day_index");
  if (error) throw error;
  return data ?? [];
}

// ── Mutations via edge functions (session JWT auto-attached by invoke) ──
async function invoke(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    // Surface the function's JSON error body: message = body.error, and keep the rest
    // (status, detail, next_allowed_at, last_log_at) so the flow can tell a 20-hour
    // lock from a real failure. See challengeRunFlow.js.
    let msg = error.message;
    const extra = { status: error.context?.status ?? null };
    try {
      const j = await error.context?.json?.();
      if (j?.error) msg = j.error;
      for (const k of ["detail", "next_allowed_at", "last_log_at"]) if (j?.[k] != null) extra[k] = j[k];
    } catch { /* ignore */ }
    throw functionError(msg, extra);
  }
  return data;
}


export const enroll = (challengeId) => invoke("challenge-enroll", { challenge_id: challengeId });
export const logDay = (runId, dayIndex, standardsHit) =>
  invoke("challenge-log", { run_id: runId, day_index: dayIndex, standards_hit: standardsHit });
export const closeDay = (runId) => invoke("challenge-day-close", { run_id: runId });
// The default api the run view uses; previews and tests inject a synthetic one.
export const participantApi = { getDayLogs, logDay, closeDay };
