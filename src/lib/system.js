// Self-serve plan signup (P33: free). The function is public (the person is a stranger); the
// public key on supabase.functions.invoke passes the gateway, and system-signup owns every
// check. The intake link is only ever emailed: this call never returns it.
import { supabase } from "./supabase";
import { attributionBody } from "./attribution";

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

// Every signup carries the six attribution fields (see ./attribution.js) so the owner can see
// which post a signup came from. The server re-sanitizes them.
// → { ok: true } (sent, or already sent today) | { paused: true }
export const startSystemSignup = ({ email }) => invoke("system-signup", { email, ...attributionBody() });
