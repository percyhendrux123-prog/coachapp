// The self-serve build: insert the draft, publish it, assemble and assign nutrition. One copy,
// used by intake-submit (a clean screen) and system-clearance (after the person's own
// confirmation, P33). Self-serve tenants have no coach to press Release, so nutrition is
// assembled and assigned in the same request as the program publish.
//
// `db` is a service-role client. Every write is pinned to the intake's own tenant and client.
// Returns the same fields intake-submit has always returned for a published self-serve plan.

// deno-lint-ignore no-explicit-any
type Db = any;

export type BuiltPlan = {
  training: unknown; meal_plan: unknown; macros: unknown; rationale: string; health_flags: string[];
};

export type BuildResult =
  | { ok: true; draft_id: string; program_id: string; meal_plan_id: string | null; meal_plan_error: string | null }
  | { ok: false; stage: "draft" | "publish"; error: string; draft_id?: string };

export async function insertDraft(
  db: Db,
  intake: { id: string; tenant_id: string; client_id: string },
  plan: BuiltPlan,
  status: "draft" | "held_medical",
  gate: boolean,
): Promise<{ ok: true; draft: { id: string } } | { ok: false; error: string }> {
  const ins = await db.from("program_drafts").insert({
    tenant_id: intake.tenant_id, client_id: intake.client_id, intake_id: intake.id,
    status, training: plan.training, meal_plan: plan.meal_plan, macros: plan.macros,
    rationale: plan.rationale, health_flags: plan.health_flags, gate_enabled: gate,
  }).select("*").single();
  if (ins.error) return { ok: false, error: ins.error.message };
  return { ok: true, draft: ins.data };
}

// Publish an inserted draft and, for a self-serve tenant, assemble + assign nutrition.
export async function publishSelfServe(db: Db, clientId: string, draftId: string, selfServe: boolean): Promise<BuildResult> {
  const { data: pid, error } = await db.rpc("publish_program_draft", { p_draft_id: draftId });
  if (error) return { ok: false, stage: "publish", error: error.message, draft_id: draftId };
  let meal_plan_id: string | null = null;
  let meal_plan_error: string | null = null;
  if (selfServe) {
    const { data: mp, error: mpErr } = await db.rpc("assemble_client_meal_plan_system", { p_client_id: clientId });
    if (mpErr) meal_plan_error = mpErr.message; else meal_plan_id = mp as string;
  }
  return { ok: true, draft_id: draftId, program_id: pid as string, meal_plan_id, meal_plan_error };
}

// insert → publish → nutrition, for a self-serve tenant.
export async function buildSelfServe(
  db: Db,
  intake: { id: string; tenant_id: string; client_id: string },
  plan: BuiltPlan,
): Promise<BuildResult> {
  const d = await insertDraft(db, intake, plan, "draft", false);
  if (!d.ok) return { ok: false, stage: "draft", error: d.error };
  return await publishSelfServe(db, intake.client_id, d.draft.id, true);
}
