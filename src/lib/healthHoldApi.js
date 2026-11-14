// P33 — the signed-in self-serve person's own health-step calls. Nothing here decides
// anything: my_health_hold() reads the person's latest screen, and system-clearance runs
// attest_my_health_screen() with the person's own session, so the database decides.
import { supabase } from "./supabase";

export async function getMyHealthHold() {
  const { data, error } = await supabase.rpc("my_health_hold");
  if (error) throw error;
  return data ?? { state: "none" };
}

export async function confirmMyClearance({ intake_id, seen_flags, statement_version, typed_name }) {
  const { data, error } = await supabase.functions.invoke("system-clearance", {
    body: { intake_id, seen_flags, statement_version, typed_name },
  });
  if (error) {
    let detail = error.message;
    try { detail = (await error.context?.json())?.error ?? detail; } catch { /* keep */ }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
