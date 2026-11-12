// Paid + intake submitted 24h+ ago, still missing a program, meal plan or sign-in, and not
// moved to coaching. Found 2026-09-29: a buyer sat like this for two weeks unseen.
// Mirror of supabase/functions/_shared/systemStuck.ts (the daily digest alert) — keep in step.
export const STUCK_AFTER_HOURS = 24;
export function stuckReasons(row, now = new Date()) {
  if (row.converted_client_id) return [];
  if (row.intake_status !== "submitted" || !row.intake_submitted_at) return [];
  const at = Date.parse(row.intake_submitted_at);
  if (!Number.isFinite(at)) return [];
  if (now.getTime() - at < STUCK_AFTER_HOURS * 3600 * 1000) return [];
  const missing = [];
  if (!row.program_published) missing.push("program");
  if (!row.meal_plan_assigned) missing.push("meal plan");
  if (!row.has_account) missing.push("sign-in account");
  return missing;
}
