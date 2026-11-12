// Hosting-subscription helpers (coach side).
import { supabase } from "./supabase";

// Open the Stripe Billing Portal so the coach can update their card / resume the hosting.
export async function openBillingPortal() {
  const { data, error } = await supabase.functions.invoke("license-portal", {
    body: { return_url: `${window.location.origin}/coach/brief` },
  });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return data; // { portal_url }
}
