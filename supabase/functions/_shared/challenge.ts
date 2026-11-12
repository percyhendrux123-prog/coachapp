// Shared helpers for the challenge-engine edge functions.
// Matches the coachapp house style: service-role admin client, CORS, json() helper,
// self-handled auth (functions deploy with verify_jwt=false).
import { createClient } from "npm:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";

// One service-role client per invocation. Bypasses RLS — the challenge run/log
// integrity gate lives here in code (participants cannot self-mark a perfect week).
export const admin = () => createClient(SUPABASE_URL, SERVICE_KEY);

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

export const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// Resolve the authenticated caller from their bearer JWT (validated via GoTrue).
// Returns the auth user id, or null if unauthenticated/invalid.
export async function callerUserId(req: Request): Promise<string | null> {
  const authz = req.headers.get("Authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!token) return null;
  const { data, error } = await admin().auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

// Load a challenge_run the caller owns, joined to its challenge. 403 if not owner.
export async function loadOwnedRun(runId: string, userId: string) {
  const { data: run } = await admin().from("challenge_runs").select("*").eq("id", runId).maybeSingle();
  if (!run) return { error: json({ error: "run not found" }, 404) };
  if (run.participant_user_id !== userId) return { error: json({ error: "not your run" }, 403) };
  const { data: challenge } = await admin().from("challenges").select("*").eq("id", run.challenge_id).maybeSingle();
  if (!challenge) return { error: json({ error: "challenge missing" }, 500) };
  return { run, challenge };
}
