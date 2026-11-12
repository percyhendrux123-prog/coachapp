// OWNER coaching buyer path (Slice 0). Public: the buyer is not signed in; the anon key on
// supabase.functions.invoke passes the gateway, the function owns every trust check.
import { supabase } from "./supabase";

async function invoke(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let detail = error.message;
    try { detail = (await error.context?.json())?.error ?? detail; } catch { /* keep */ }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export const redeemCoachingSession = (session_id) => invoke("coaching-provision", { session_id });
