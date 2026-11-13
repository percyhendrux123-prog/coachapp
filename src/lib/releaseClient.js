// Slice 3 — one release (the implementation specification).
//
// The database owns the rules: release_checklist() says what stands, release_client() does
// the release atomically and refuses naming the first missing item. This module only calls
// them and turns their answers into words. Nothing here decides whether a client is ready.
import { supabase } from "./supabase";

export async function getReleaseChecklist(clientId) {
  const { data, error } = await supabase.rpc("release_checklist", { p_client_id: clientId });
  if (error) throw error;
  return data;
}

// Returns the RPC's result. A refusal arrives as an error whose message starts with
// "release refused:" — the UI shows it verbatim; nothing was written.
export async function releaseClient(clientId, { noNutrition = false } = {}) {
  const { data, error } = await supabase.rpc("release_client", { p_client_id: clientId, p_no_nutrition: !!noNutrition });
  if (error) throw error;
  return data;
}

// P26: record the coach's review of a flagged health screen. The note says what they checked.
// A refusal arrives as an error whose message starts with "review refused:".
export async function reviewHealthScreen(intakeId, note) {
  const { data, error } = await supabase.rpc("review_health_screen", { p_intake_id: intakeId, p_note: note });
  if (error) throw error;
  return data;
}

export { checklistLines, isReadyToRelease, offerNoNutrition, releaseOutcomeLine, refusalText } from "./releaseChecklist.js";
