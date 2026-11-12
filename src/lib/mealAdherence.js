// Client meal adherence (implementation minimal). Status is only:
//   logged   — ate the assigned / good-week meal for that slot
//   skipped  — did not eat that slot
//   fallback — used the bad-week / fallback meal
// Not a free-form food diary. RLS: client owns their rows; coach reads tenant.
import { supabase } from "./supabase";

export const MEAL_ADHERENCE_STATUSES = ["logged", "skipped", "fallback"];

export function ymdLocal(date = new Date()) {
  const d = new Date(date);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Logs for one calendar day for the signed-in client. */
export async function listMealAdherenceForDate(logDate) {
  const { data, error } = await supabase
    .from("meal_adherence_logs")
    .select("id, plan_id, log_date, slot_index, slot_label, status, meal_id, note, updated_at")
    .eq("log_date", logDate)
    .order("slot_index", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * Logs in [fromDate, toDate] inclusive (YYYY-MM-DD).
 * Used by the client history calendar.
 */
export async function listMealAdherenceRange({ fromDate, toDate }) {
  const { data, error } = await supabase
    .from("meal_adherence_logs")
    .select("id, plan_id, log_date, slot_index, slot_label, status, meal_id, note, updated_at")
    .gte("log_date", fromDate)
    .lte("log_date", toDate)
    .order("log_date", { ascending: false })
    .order("slot_index", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * Upsert one slot for a day. Unique key: (client_id, log_date, slot_index).
 * status must be logged | skipped | fallback.
 */
export async function upsertMealAdherence({
  tenantId,
  clientId,
  planId,
  logDate,
  slotIndex,
  slotLabel,
  status,
  mealId = null,
  note = null,
}) {
  if (!MEAL_ADHERENCE_STATUSES.includes(status)) {
    throw new Error(`Invalid status "${status}". Use logged, skipped, or fallback.`);
  }
  if (!tenantId || !clientId || !logDate || slotIndex == null) {
    throw new Error("Missing required fields for meal adherence.");
  }
  // plan_id is optional (nullable) so legacy PDF/JSON plans can still log slots.
  const row = {
    tenant_id: tenantId,
    client_id: clientId,
    plan_id: planId || null,
    log_date: logDate,
    slot_index: slotIndex,
    slot_label: slotLabel ?? null,
    status,
    meal_id: mealId || null,
    note: note?.trim() ? note.trim() : null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("meal_adherence_logs")
    .upsert(row, { onConflict: "client_id,log_date,slot_index" })
    .select("id, plan_id, log_date, slot_index, slot_label, status, meal_id, note, updated_at")
    .single();
  if (error) throw error;
  return data;
}

/** Group logs by YYYY-MM-DD for calendar dots. */
export function groupAdherenceByDate(rows) {
  const m = {};
  for (const r of rows ?? []) {
    (m[r.log_date] ??= []).push(r);
  }
  return m;
}

export function adherenceLabel(status) {
  if (status === "logged") return "Logged";
  if (status === "skipped") return "Skipped";
  if (status === "fallback") return "Backup";
  return status;
}
