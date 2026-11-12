// Coach-side data layer for the challenge board. Every call goes through supabase-js
// with the coach's session — RLS (challenges/standards/content coach_all, runs coach read)
// enforces that a coach only ever touches their own tenant's rows.
import { supabase } from "./supabase";

export const AUDIENCE_LABEL = {
  open: "Open — anyone",
  clients_only: "Existing clients only",
  non_clients_only: "New people only (not current coaching clients)",
};

export async function listChallenges() {
  const { data, error } = await supabase
    .from("challenges")
    .select("id, slug, title, subtitle, status, audience, max_entrants, duration_days, num_standards, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function createChallenge({ tenantId, slug, title, subtitle, audience = "open" }) {
  const { data, error } = await supabase
    .from("challenges")
    .insert({ tenant_id: tenantId, slug, title, subtitle, audience })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function setChallengeStatus(id, status) {
  const { error } = await supabase.from("challenges").update({ status }).eq("id", id);
  if (error) throw error;
}

export async function setChallengeAudience(id, audience) {
  const { error } = await supabase.from("challenges").update({ audience }).eq("id", id);
  if (error) throw error;
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

export async function upsertStandard({ tenantId, challengeId, ordinal, title, description }) {
  const { error } = await supabase
    .from("challenge_standards")
    .upsert(
      { tenant_id: tenantId, challenge_id: challengeId, ordinal, title, description },
      { onConflict: "challenge_id,ordinal" }
    );
  if (error) throw error;
}

export async function deleteStandard(id) {
  const { error } = await supabase.from("challenge_standards").delete().eq("id", id);
  if (error) throw error;
}

export async function getContent(challengeId) {
  const { data, error } = await supabase
    .from("challenge_content")
    .select("id, day_index, title, body")
    .eq("challenge_id", challengeId)
    .order("day_index");
  if (error) throw error;
  return data ?? [];
}

export async function upsertContent({ tenantId, challengeId, dayIndex, title, body }) {
  const { error } = await supabase
    .from("challenge_content")
    .upsert(
      { tenant_id: tenantId, challenge_id: challengeId, day_index: dayIndex, title, body },
      { onConflict: "challenge_id,day_index" }
    );
  if (error) throw error;
}

// Runs with the participant's sign-in email, via challenge_runs_for_coach() (SECURITY
// DEFINER, coach-only, scoped to the coach's tenant — migration 20260908120000).
export async function listRuns(challengeId) {
  const { data, error } = await supabase.rpc("challenge_runs_for_coach", { p_challenge_id: challengeId });
  if (error) throw error;
  return data ?? [];
}

export async function setChallengeMaxEntrants(id, maxEntrants) {
  const value = maxEntrants === "" || maxEntrants == null ? null : Number(maxEntrants);
  if (value !== null && (!Number.isInteger(value) || value < 1)) throw new Error("Places must be a whole number of 1 or more, or blank for no cap.");
  const { error } = await supabase.from("challenges").update({ max_entrants: value }).eq("id", id);
  if (error) throw error;
  return value;
}
