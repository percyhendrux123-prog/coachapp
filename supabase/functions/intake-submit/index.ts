// intake-submit — tokenized consultation/onboarding form (verify_jwt=false).
//
// A coach invites a client (createIntakeInvite), which creates an intake_forms row with a token
// scoped to the coach's tenant. The client opens /intake?token=… and submits answers here; we
// generate a plan and land a Pending program draft for the coach's approval. Health-flag
// (held_medical) routing is unchanged.
//
// REMOVED: the former self-serve-PAID mode (verify a Stripe Checkout session → create a coaching
// client). Coach↔client payments no longer run through this platform's Stripe account — coaches
// use their own external payment links, and access is granted by the coach invite above.
import { createClient } from "npm:@supabase/supabase-js@2";
import { generatePlan, missingParq } from "./generate.ts";
import { buildScreenRecord, SCREEN_KIND, screenProblems } from "./screen.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// Required fields for WP-7: form + generator never invent sex/height/weight/goal.
// Returns null when complete; otherwise a human-readable list of missing field names.
const GOAL_ENUM = new Set(["fat_loss", "muscle_gain", "recomp", "maintain"]);
const EQUIP_ENUM = new Set(["full_gym", "home_basic", "bodyweight"]);
const EXP_ENUM = new Set(["beginner", "intermediate", "advanced"]);
const SEX_ENUM = new Set(["male", "female"]);

function missingRequiredAnswers(a: any): string[] {
  const missing: string[] = [];
  const n = (v: unknown) => (v === null || v === undefined || v === "" ? NaN : Number(v));

  if (!GOAL_ENUM.has(String(a?.goal ?? "").toLowerCase())) missing.push("goal");
  if (!EQUIP_ENUM.has(String(a?.equipment ?? "").toLowerCase())) missing.push("equipment");
  if (!EXP_ENUM.has(String(a?.experience ?? "").toLowerCase())) missing.push("experience");

  const days = n(a?.days_per_week);
  if (!Number.isFinite(days) || days < 3 || days > 6) missing.push("days_per_week");

  if (!SEX_ENUM.has(String(a?.sex ?? "").toLowerCase())) missing.push("sex");

  const age = n(a?.age);
  if (!Number.isFinite(age) || age < 14 || age > 90) missing.push("age");

  const cm = n(a?.height_cm);
  if (!Number.isFinite(cm) || cm < 120 || cm > 230) missing.push("height_cm");

  const kg = n(a?.weight_kg);
  if (!Number.isFinite(kg) || kg < 35 || kg > 250) missing.push("weight_kg");

  // Goal weight is never required — see generate.ts doctrine. A client may not know it yet;
  // the generator computes macros off current weight and never blocks on this.

  // Unit-labeled raw strings: imperial/metric must be stated so coach review is unambiguous.
  const unit = String(a?.unit_pref ?? "").toLowerCase();
  if (unit !== "imperial" && unit !== "metric") missing.push("unit_pref");
  if (!String(a?.height_raw ?? "").trim()) missing.push("height_raw");
  if (!String(a?.weight_raw ?? "").trim()) missing.push("weight_raw");

  return missing;
}

// Turn a resolved (intake, answers) into a plan + Pending draft. Tenant-scoped via the intake row.
async function processSubmission(intake: any, answers: any): Promise<Response> {
  const missing = missingRequiredAnswers(answers);
  if (missing.length > 0) {
    return json({
      error:
        `Intake refused. Missing or out-of-range fields: ${missing.join(", ")}. ` +
        `These are facts about a specific person and cannot be defaulted.`,
      missing,
    }, 400);
  }

  // PAR-Q: null ≠ false. Unanswered questions are not the same as a declared "no."
  // Refuse independently of the frontend gate — the backend is the final word.
  const unansweredParq = missingParq(answers);
  if (unansweredParq.length > 0) {
    return json({
      error:
        `Intake refused. Unanswered health-screen questions: ${unansweredParq.join(", ")}. ` +
        `Every PAR-Q question must be answered — null is not the same as no.`,
      missing_parq: unansweredParq,
    }, 400);
  }

  const plan = generatePlan(answers);

  await admin.from("intake_forms").update({
    answers, health_flags: plan.health_flags, status: "submitted", submitted_at: new Date().toISOString(),
  }).eq("id", intake.id);

  // The tenant's mode rides on every outcome so the Intake page can pick the right words:
  // a self-serve buyer has no coach to "review personally".
  const { data: tc } = await admin.from("tenant_config").select("mode").eq("tenant_id", intake.tenant_id).maybeSingle();
  const mode = tc?.mode === "self_serve" ? "self_serve" : "coached";

  // Self-serve: the buyer's own numbers go onto the client row. Nothing else ever writes them
  // there (a coached client's row is filled by the coach / onboarding path), and the meal-plan
  // assembly and the owner tools read the ROW, not the intake — found 2026-09-03 when the first
  // walkthrough buyer's program published but nutrition refused with missing_body_metrics.
  // Coached tenants are deliberately untouched here.
  if (mode === "self_serve") {
    const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
    const row: Record<string, unknown> = {
      sex: String(answers.sex).toLowerCase(), age: num(answers.age),
      height_cm: num(answers.height_cm), weight_kg: num(answers.weight_kg),
      unit_pref: String(answers.unit_pref).toLowerCase(), updated_at: new Date().toISOString(),
    };
    const gw = num(answers.goal_weight_kg); if (gw !== null) row.goal_weight_kg = gw;
    const { error: cErr } = await admin.from("clients").update(row).eq("id", intake.client_id).eq("tenant_id", intake.tenant_id);
    if (cErr) console.error("intake-submit: client metrics write failed:", cErr.message);
  }

  const { data: cfg } = await admin.from("tenant_config").select("program_approval_gate")
    .eq("tenant_id", intake.tenant_id).maybeSingle();
  const gate = cfg?.program_approval_gate ?? true;
  const status = plan.held ? "held_medical" : "draft";

  const ins = await admin.from("program_drafts").insert({
    tenant_id: intake.tenant_id, client_id: intake.client_id, intake_id: intake.id,
    status, training: plan.training, meal_plan: plan.meal_plan, macros: plan.macros,
    rationale: plan.rationale, health_flags: plan.health_flags, gate_enabled: gate,
  }).select("*").single();
  if (ins.error) return json({ error: "draft insert: " + ins.error.message }, 500);
  const draft = ins.data;

  // Best-effort — never blocks the submission response on failure, but the failure
  // itself must be visible, not swallowed.
  const notify = async (template: string) => {
    const { error } = await admin.from("notification_log").insert({
      tenant_id: intake.tenant_id, client_id: intake.client_id, channel: "push",
      template, status: "recorded", consent_snapshot: { draft_id: draft.id },
    });
    if (error) console.error("intake-submit notify: notification_log insert failed:", error.message);
  };

  if (plan.held) {
    await notify("program_medical_hold");
    return json({ status: "held_medical", draft_id: draft.id, health_flags: plan.health_flags, mode,
      message: mode === "self_serve"
        ? "Health-screen flag raised — no self-serve plan built. Coaching is the right next step."
        : "Health-screen flag raised — held for coach review. No plan auto-generated." });
  }
  if (gate === false) {
    const { data: pid, error } = await admin.rpc("publish_program_draft", { p_draft_id: draft.id });
    if (error) return json({ error: "publish: " + error.message, draft_id: draft.id }, 500);

    // Self-serve tenants have no coach to press Release, so nutrition is assembled and
    // assigned here, in the same request as the program publish. Coached tenants with the
    // gate off (none today) are left exactly as before — a coach still releases nutrition.
    let meal_plan_id: string | null = null;
    let meal_plan_error: string | null = null;
    if (mode === "self_serve") {
      const { data: mp, error: mpErr } = await admin.rpc("assemble_client_meal_plan_system", { p_client_id: intake.client_id });
      if (mpErr) meal_plan_error = mpErr.message; else meal_plan_id = mp as string;
    }
    return json({ status: "published", draft_id: draft.id, program_id: pid, gate: false, mode, meal_plan_id, meal_plan_error });
  }
  await notify("program_draft_pending_approval");
  return json({ status: "draft_pending_approval", draft_id: draft.id, gate: true,
    message: "Plan generated and queued as a pending draft for coach approval." });
}

// Health screen + waiver only (see ./screen.ts). Never generates a program draft: these are
// clients who are already training. A yes or a medications note is recorded as a health flag
// and logged for coach review; the client is told their coach reviews it.
async function processScreen(intake: any, raw: any): Promise<Response> {
  const problems = screenProblems(raw);
  if (problems.missing_parq.length || problems.legal.length) {
    return json({
      error: problems.missing_parq.length
        ? `Every health question needs a yes or a no. Unanswered: ${problems.missing_parq.join(", ")}.`
        : "The waiver needs your signature before it can be saved.",
      missing_parq: problems.missing_parq, missing_legal: problems.legal,
    }, 400);
  }

  const { data: prevRows, error: prevErr } = await admin.from("intake_forms").select("answers")
    .eq("client_id", intake.client_id).eq("tenant_id", intake.tenant_id).eq("status", "submitted")
    .order("submitted_at", { ascending: false }).limit(1);
  // A failed read must not silently drop earlier answers from the new latest row.
  if (prevErr) return json({ error: "Could not save right now. Try again in a minute." }, 503);

  const now = new Date().toISOString();
  const rec = buildScreenRecord(prevRows?.[0]?.answers ?? null, raw, now);

  const { data: upd, error: updErr } = await admin.from("intake_forms").update({
    answers: rec.answers, health_flags: rec.health_flags, status: "submitted", submitted_at: now,
  }).eq("id", intake.id).eq("status", "pending").select("id");
  if (updErr) return json({ error: "Could not save right now. Try again in a minute." }, 500);
  if (!upd?.length) return json({ error: "intake already submitted" }, 409);

  const template = rec.needs_review ? "intake_screen_review" : "intake_screen_complete";
  const { error: logErr } = await admin.from("notification_log").insert({
    tenant_id: intake.tenant_id, client_id: intake.client_id, channel: "push",
    template, status: "recorded", consent_snapshot: { intake_id: intake.id, health_flags: rec.health_flags },
  });
  if (logErr) console.error("intake-submit screen: notification_log insert failed:", logErr.message);

  return json({ status: rec.needs_review ? "screen_review" : "screen_complete", health_flags: rec.health_flags });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "intake-submit" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const token = body?.token;
  if (!token) return json({ error: "token required" }, 400);

  const { data: intake } = await admin.from("intake_forms").select("*").eq("token", token).maybeSingle();
  if (!intake) return json({ error: "invalid token" }, 404);
  const expired = !!(intake.expires_at && new Date(intake.expires_at) < new Date());

  // Peek: the screen page asks who the link belongs to before the client answers anything,
  // so it can greet them by name and prefill the signature. The token holder already has
  // the right to submit as this client; the display name is all that comes back.
  if (body?.peek === true) {
    if (intake.status === "submitted") return json({ ok: true, status: "submitted" });
    if (expired) return json({ ok: false, status: "expired" });
    const { data: c } = await admin.from("clients").select("display_name")
      .eq("id", intake.client_id).eq("tenant_id", intake.tenant_id).maybeSingle();
    if (!c) return json({ error: "client not found" }, 404);
    return json({ ok: true, status: "pending", display_name: c.display_name ?? null });
  }

  if (intake.status === "submitted") return json({ error: "intake already submitted" }, 409);
  if (expired) return json({ error: "intake expired" }, 410);
  const { data: client } = await admin.from("clients").select("id").eq("id", intake.client_id).maybeSingle();
  if (!client) return json({ error: "client not found" }, 404);

  if (body?.kind === SCREEN_KIND) return await processScreen(intake, body?.answers || {});
  return await processSubmission(intake, body?.answers || {});
});
