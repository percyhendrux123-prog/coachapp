// workout-close — close out the assignment's current program day and advance. Idempotent.
// Clients are SELECT-only on assignments (RLS), so day advancement and cycle handoff live
// behind the service role. The actual advance/cycle semantics are in
// _shared/workoutDay.ts#closeDayCore, shared with the mcp fn's complete_current_day
// client-agent tool — this fn is the JWT-auth wrapper for the app's Finish button.
// (verify_jwt=false; auth self-handled.)
//
// POST { assignment_id, day_id }  (Bearer JWT required; caller must be the assigned client.
//   day_id must match the CURRENT day — a repeat call for an already-closed day is a no-op.)
// GET → health check.
import { admin, callerUserId, json, CORS } from "../_shared/challenge.ts";
import { closeDayCore } from "../_shared/workoutDay.ts";

// Load the assignment the caller owns (via clients.client_user_id), joined to its program.
async function loadOwnedAssignment(assignmentId: string, userId: string) {
  const db = admin();
  const { data: a } = await db.from("assignments").select("*").eq("id", assignmentId).maybeSingle();
  if (!a) return { error: json({ error: "assignment not found" }, 404) };
  const { data: cli } = await db.from("clients").select("id, client_user_id, tenant_id").eq("id", a.client_id).maybeSingle();
  if (!cli || cli.client_user_id !== userId) return { error: json({ error: "not your assignment" }, 403) };
  const { data: program } = await db.from("programs").select("id, name, structure").eq("id", a.program_id).maybeSingle();
  if (!program) return { error: json({ error: "program missing" }, 500) };
  return { assignment: a, client: cli, program };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "workout-close" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "authentication required" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { assignment_id, day_id } = body || {};
  if (!assignment_id || !day_id) return json({ error: "assignment_id and day_id required" }, 400);

  const owned = await loadOwnedAssignment(assignment_id, userId);
  if ("error" in owned) return owned.error;

  const res = await closeDayCore(admin(), owned.assignment, owned.program, day_id);
  return res.ok ? json(res.body) : json({ error: res.error }, res.status);
});
