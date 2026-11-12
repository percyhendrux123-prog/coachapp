// Intake form data layer. The page is public — the token IS the auth; it POSTs to the
// intake-submit edge function which owns all trust checks (token validity/expiry, medical
// hold gate). The former `?session_id=` self-serve mode was removed server-side 2026-07-22
// (commit ddbba82); Self-serve plan buyers arrive with a token from system-provision instead.
import { supabase } from "./supabase";

export async function submitIntake({ token, answers }) {
  const { data, error } = await supabase.functions.invoke("intake-submit", {
    body: { token, answers },
  });
  if (error) {
    let detail = error.message;
    try { detail = (await error.context?.json())?.error ?? detail; } catch { /* keep default */ }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// Coach action: create a tokenized intake invite for a client (coach ALL RLS).
export async function createIntakeInvite({ tenantId, clientId }) {
  return `${window.location.origin}/intake?token=${await mintIntakeToken({ tenantId, clientId })}`;
}

// Coach action: the short health screen + waiver link for a client who is already training.
// Same single-use 14-day token row; the /screen page submits it as the screen kind, which
// never builds a program draft.
export async function createScreenInvite({ tenantId, clientId }) {
  return `${window.location.origin}/screen?token=${await mintIntakeToken({ tenantId, clientId })}`;
}

async function mintIntakeToken({ tenantId, clientId }) {
  const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
  const expires = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  const { error } = await supabase.from("intake_forms").insert({
    tenant_id: tenantId, client_id: clientId, token, status: "pending", expires_at: expires,
  });
  if (error) throw error;
  return token;
}

async function invokeIntake(body) {
  const { data, error } = await supabase.functions.invoke("intake-submit", { body });
  if (error) {
    let detail = error.message;
    let status = error.context?.status ?? null;
    try { detail = (await error.context?.json())?.error ?? detail; } catch { /* keep default */ }
    const e = new Error(detail); e.status = status; throw e;
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// Who this screen link belongs to: { status: pending|submitted|expired, display_name }.
export async function peekIntake(token) {
  try {
    return await invokeIntake({ token, peek: true });
  } catch (e) {
    if (e.status === 404) return { status: "invalid" };
    throw e;
  }
}

export async function submitScreen({ token, answers }) {
  return invokeIntake({ token, kind: "screen", answers });
}
