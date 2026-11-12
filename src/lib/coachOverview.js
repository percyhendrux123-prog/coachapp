// ============================================================================
// Coach overview data layer.
//
// ONE call. The page performs no aggregation, no ranking and no health
// computation — all of that lives in rm_coach_overview() so the MCP connector
// calling the same function can never diverge from what the coach sees.
//
// If you find yourself adding a .filter() or .sort() that changes which items
// appear or in what order, stop: that logic belongs in the SQL.
// ============================================================================
import { supabase } from "./supabase";

export async function fetchCoachOverview() {
  const { data, error } = await supabase.rpc("rm_coach_overview");
  if (error) throw error;
  return data;
}

// Slice 2: the coach's reminder switches, sender, last-24h send/skip counts and the last
// cron run — shaped in SQL (onboarding_reminder_status), rendered as-is.
export async function fetchReminderStatus() {
  const { data, error } = await supabase.rpc("onboarding_reminder_status");
  if (error) throw error;
  return data;
}

