// Platform-owner view of Self-serve plan buyers (Phase 4, part A). The rows come from
// list_system_buyers(), a SECURITY DEFINER reader that refuses anyone who is not a coach of
// the owner tenant — so a white-label coach calling this gets an error, not an empty list.
// One action exists: moving a signed-in buyer to coaching (part B, amended 2026-09-04).
import { supabase } from "./supabase";

export async function listSystemBuyers() {
  const { data, error } = await supabase.rpc("list_system_buyers");
  if (error) throw error;
  return data ?? [];
}

// Plain-language intake state for the table. `none` is a real fact: no intake row exists.
export function intakeLabel(row) {
  if (row.intake_status === "submitted") return "Submitted";
  if (row.intake_status === "pending") return "Not submitted";
  return "No intake";
}

// Move a signed-in SYSTEM buyer onto the owner's coaching roster. The database function creates
// the coaching row, moves the buyer's login to it, and revokes their AI tokens. Refuses a
// buyer who never signed in — the error text says so and the owner adds them normally instead.
export async function convertSystemBuyer(buyerClientId) {
  const { data, error } = await supabase.rpc("convert_system_buyer_to_coaching", { p_buyer_client_id: buyerClientId });
  if (error) throw error;
  return data; // new coaching client id
}

// Plain-language origin for a roster row. Null is "not tracked" and renders nothing.
export function originLabel(origin) {
  if (origin === "system") return "SYSTEM";
  if (origin === "trainerize_import") return "Imported";
  return null;
}

// Stuck-buyer rule lives in its own import-free file so the Deno parity test can load it.
export { STUCK_AFTER_HOURS, stuckReasons } from "./systemStuck.js";
