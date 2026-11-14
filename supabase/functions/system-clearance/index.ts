// system-clearance — P33. The signed-in self-serve person confirms their own doctor's
// clearance for a flagged health screen; the database records it; a conservative plan is built.
//
// verify_jwt is ON (config.toml). The caller's own JWT is required: the service key, the anon
// key and connector tokens are refused (flow.ts checkCaller), and attest_my_health_screen()
// runs with the caller's JWT, so the database — not this function — decides who may confirm
// what. There is no connector tool for this and no AI path to it.
//
// POST { intake_id, seen_flags, statement_version, typed_name }
//   → { status: "built", program_id, draft_id, meal_plan_id, meal_plan_error, message }
//   | { error }
// GET → health check.
import { createClient } from "npm:@supabase/supabase-js@2";
import { admin, json, CORS, SUPABASE_URL, SERVICE_KEY } from "../_shared/challenge.ts";
import { buildSelfServe } from "../_shared/selfServeBuild.ts";
import { checkCaller, parseInput, runClearance, type Deps } from "./flow.ts";

const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
// Longer than any edge-function run, so a takeover never races a build still in flight.
const STALE_CLAIM_MS = 10 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "system-clearance" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const caller = checkCaller(req.headers.get("Authorization"), { serviceKey: SERVICE_KEY, anonKey: ANON_KEY });
  if (!caller.ok) return json({ error: caller.error }, caller.status);

  // The user client carries the public key and the caller's JWT, never the service key.
  if (!ANON_KEY) return json({ error: "SUPABASE_ANON_KEY is not set" }, 500);
  const user = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${caller.jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: u, error: uErr } = await user.auth.getUser(caller.jwt);
  if (uErr || !u?.user || u.user.id !== caller.sub) return json({ error: "sign in first" }, 401);

  let body: unknown;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const parsed = parseInput(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const db = admin();
  const deps: Deps = {
    attest: async (input) => {
      const { data, error } = await user.rpc("attest_my_health_screen", {
        p_intake_id: input.intake_id, p_seen_flags: input.seen_flags,
        p_statement_version: input.statement_version, p_typed_name: input.typed_name,
      });
      if (error) return { ok: false, status: error.code === "42501" ? 403 : 400, error: error.message };
      const r = data as Record<string, unknown>;
      return { ok: true, row: {
        attestation_id: String(r.attestation_id), intake_id: String(r.intake_id),
        client_id: String(r.client_id), flags: (r.flags as string[]) ?? [],
      } };
    },
    loadIntake: async (intakeId, clientId) => {
      const { data } = await db.from("intake_forms").select("id, tenant_id, client_id, answers")
        .eq("id", intakeId).eq("client_id", clientId).eq("status", "submitted").maybeSingle();
      return data ?? null;
    },
    findPublished: async (intakeId) => {
      const { data } = await db.from("program_drafts").select("id, published_program_id")
        .eq("intake_id", intakeId).eq("status", "published").order("generated_at", { ascending: false }).limit(1);
      const d = data?.[0];
      return d?.published_program_id ? { draft_id: d.id, program_id: d.published_program_id } : null;
    },
    claim: async (attestationId, intakeId) => {
      const ins = await db.from("health_clearance_builds").insert({ attestation_id: attestationId, intake_id: intakeId });
      if (!ins.error) return "claimed";
      // A claim left by a build that crashed (no draft after ten minutes) is taken over.
      const { data: c } = await db.from("health_clearance_builds").select("claimed_at, draft_id")
        .eq("attestation_id", attestationId).maybeSingle();
      if (c && !c.draft_id && Date.now() - Date.parse(c.claimed_at) > STALE_CLAIM_MS) {
        const { data: took } = await db.from("health_clearance_builds")
          .update({ claimed_at: new Date().toISOString() })
          .eq("attestation_id", attestationId).is("draft_id", null).eq("claimed_at", c.claimed_at).select("attestation_id");
        if (took?.length) return "claimed";
      }
      return "taken";
    },
    release: async (attestationId) => {
      await db.from("health_clearance_builds").delete().eq("attestation_id", attestationId).is("draft_id", null);
    },
    build: async (intake, plan) => {
      // The screen must still be the person's latest when the plan is published (review round 1).
      const { data: latest } = await db.from("intake_forms").select("id")
        .eq("client_id", intake.client_id).eq("tenant_id", intake.tenant_id).eq("status", "submitted")
        .order("submitted_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(1);
      if (latest?.[0]?.id !== intake.id) return { ok: false, error: "a newer health screen exists — open the app again" };
      const r = await buildSelfServe(db, intake, plan);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, built: { draft_id: r.draft_id, program_id: r.program_id, meal_plan_id: r.meal_plan_id, meal_plan_error: r.meal_plan_error } };
    },
    finish: async (attestationId, intakeId, draftId) => {
      await db.from("health_clearance_builds").update({ draft_id: draftId }).eq("attestation_id", attestationId);
      // The held draft for this screen is done with. The draft status enum has no
      // 'superseded'; 'rejected' with a note is the nearest existing value.
      const { data: i } = await db.from("intake_forms").select("tenant_id, client_id").eq("id", intakeId).maybeSingle();
      if (!i) return;
      await db.from("program_drafts").update({
        status: "rejected", decided_at: new Date().toISOString(),
        decision_note: "Superseded: a conservative plan was built after the person confirmed their own doctor's clearance in the app (P33). Nobody reviewed the health answers.",
      }).eq("intake_id", intakeId).eq("tenant_id", i.tenant_id).eq("client_id", i.client_id).eq("status", "held_medical");
      {
        const { error } = await db.from("notification_log").insert({
          tenant_id: i.tenant_id, client_id: i.client_id, channel: "push", template: "system_clearance_built",
          status: "recorded", consent_snapshot: { intake_id: intakeId, draft_id: draftId, attestation_id: attestationId },
        });
        if (error) console.error("system-clearance: notification_log insert failed:", error.message);
      }
    },
  };

  const out = await runClearance(deps, parsed.input);
  return json(out.body, out.status);
});
