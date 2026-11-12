// Add-a-coach admin data layer. Gated server-side (admin-provision-coach checks the
// caller is the owner-tenant coach); the UI gate in CoachSettings.jsx is just so
// nobody else sees the section, not the actual security boundary.
import { supabase } from "./supabase";

async function invoke(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return data;
}

// mode: "trial" | "comped" | "paid"
export const provisionCoach = ({ appName, displayName, mode, reason, subscriptionId, customerId }) =>
  invoke("admin-provision-coach", {
    app_name: appName,
    display_name: displayName,
    mode,
    reason: reason ? String(reason).trim() : undefined,
    subscription_id: subscriptionId ? String(subscriptionId).trim() : undefined,
    customer_id: customerId ? String(customerId).trim() : undefined,
  });
