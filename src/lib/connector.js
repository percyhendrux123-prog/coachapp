// AI connector tokens — coach-side management. The plaintext token is generated and
// hashed HERE in the browser; only the SHA-256 hash is ever stored (RLS-scoped insert),
// so a token can never be re-shown after creation.
import { supabase } from "./supabase";

const configuredMcpEndpoint = import.meta.env.VITE_MCP_ENDPOINT;

export const MCP_ENDPOINT = configuredMcpEndpoint
  || (typeof window !== "undefined" ? `${window.location.origin}/mcp` : "");

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createToken({ tenantId, userId, label, scope }) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const plaintext = "coach_mcp_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const { error } = await supabase.from("connector_tokens").insert({
    tenant_id: tenantId, created_by: userId, kind: "coach",
    scope, label: label.trim() || "My AI", token_hash: await sha256hex(plaintext),
  });
  if (error) throw error;
  return plaintext; // shown once, never stored
}

export async function listTokens() {
  const { data, error } = await supabase
    .from("connector_tokens")
    .select("id, kind, scope, label, created_at, last_used_at, revoked_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function revokeToken(id) {
  const { error } = await supabase.from("connector_tokens")
    .update({ revoked_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

// ---- client opt-in (own data; RLS forces kind/client and scope ∈ read|comms|owner) ----
// scope: 'read' = read-only; 'comms' = read + relay/log (message coach, flag issue,
// log sets, complete the day); 'owner' = comms PLUS full control of your own program/
// meal plan (self-serve only — the DB trigger refuses 'owner' for any coached tenant
// even if this client is bypassed). Never read_write — that scope is coach-token-only
// (DB CHECK; see the implementation specification).
export async function createClientToken({ tenantId, clientId, userId, label, scope = "read" }) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const plaintext = "coach_mcp_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const { error } = await supabase.from("connector_tokens").insert({
    tenant_id: tenantId, created_by: userId, kind: "client", client_id: clientId,
    scope: scope === "comms" ? "comms" : scope === "owner" ? "owner" : "read",
    label: label?.trim() || "My AI", token_hash: await sha256hex(plaintext),
  });
  if (error) throw error;
  return plaintext;
}

export async function listAudit(limit = 30) {
  const { data, error } = await supabase
    .from("connector_audit")
    .select("id, tool, summary, created_at, token_id")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}
