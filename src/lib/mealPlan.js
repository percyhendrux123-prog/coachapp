// Meal-plan PDF: one file per client, stored in the existing private `resources`
// bucket at <tenant_id>/<client_id>/nutrition/plan.pdf. Shared by the coach upload
// surface and the client's dashboard view — both scoped by storage RLS (res_coach_write /
// res_coach_update for the coach, res_tenant_read for both). The file's presence IS the
// record: no table row, and its storage timestamp is the "uploaded on" date.
import { supabase } from "./supabase";

const BUCKET = "resources";
const dir = (tenantId, clientId) => `${tenantId}/${clientId}/nutrition`;
const planPath = (tenantId, clientId) => `${dir(tenantId, clientId)}/plan.pdf`;

const SIGNED_URL_TTL = 3600; // 1 hour — links are generated fresh on each view.
export const MEAL_PLAN_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

// Coach action: upload (or replace) the client's meal-plan PDF. upsert overwrites the
// deterministic path in place, so there is exactly one plan per client at any time.
export async function uploadMealPlan({ tenantId, clientId, file }) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(planPath(tenantId, clientId), file, { contentType: "application/pdf", upsert: true });
  if (error) throw error;
}

// Returns { url, uploadedAt } for the current plan, or null if none uploaded yet.
// Works for both coach and client (same tenant) — read is gated by res_tenant_read.
export async function getMealPlan({ tenantId, clientId }) {
  const { data, error } = await supabase.storage.from(BUCKET).list(dir(tenantId, clientId), { limit: 100 });
  if (error) throw error;
  const obj = (data ?? []).find((o) => o.name === "plan.pdf");
  if (!obj) return null;
  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(planPath(tenantId, clientId), SIGNED_URL_TTL);
  if (signErr) throw signErr;
  return { url: signed.signedUrl, uploadedAt: obj.updated_at ?? obj.created_at ?? null };
}

// ── Structured meal plan (Wave 2 #3) — a generated, coach-editable plan stored in the
// meal_plans table (one row per client). Coexists with the PDF above. The client only
// sees it once status='assigned' (enforced by meal_plans_client_read RLS).

// Macro inputs for generation, pulled from the client's profile row.
export async function getClientMacroInputs(clientId) {
  const { data, error } = await supabase
    .from("clients")
    .select("age, sex, height_cm, weight_kg, goal_weight_kg, activity_level, client_type, body_fat_pct, show_date")
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// Coach: the client's current plan row (draft or assigned), or null.
export async function getMealPlanRecord(clientId) {
  const { data, error } = await supabase
    .from("meal_plans")
    .select("id, title, calories, protein_g, fat_g, carb_g, meals, notes, status, updated_at, assigned_at")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Client: their assigned plan, or null. RLS also restricts this to their own assigned row.
export async function getAssignedMealPlan(clientId) {
  const { data, error } = await supabase
    .from("meal_plans")
    .select("title, calories, protein_g, fat_g, carb_g, meals, notes, assigned_at")
    .eq("client_id", clientId)
    .eq("status", "assigned")
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Coach: create/replace the client's plan (one row per client). status 'draft' keeps it
// coach-private; 'assigned' publishes it to the client's Nutrition tab.
export async function upsertMealPlan({ tenantId, clientId, plan, status }) {
  const now = new Date().toISOString();

  // assigned_at is deliberately NOT in the base payload. It used to be written on every
  // save as `status === "assigned" ? now : null`, which meant editing an already-assigned
  // plan back to draft permanently erased the date it was assigned — real data loss on
  // real client records, with no way to recover it. Upsert only writes the columns it is
  // given, so omitting the key leaves any existing value intact.
  const row = {
    tenant_id: tenantId,
    client_id: clientId,
    title: plan.title ?? null,
    calories: plan.calories ?? null,
    protein_g: plan.protein_g ?? null,
    fat_g: plan.fat_g ?? null,
    carb_g: plan.carb_g ?? null,
    meals: plan.meals ?? [],
    notes: plan.notes ?? null,
    status,
    updated_at: now,
  };
  // Stamp the assignment date only when actually assigning. Re-assigning refreshes it;
  // saving a draft leaves the original date alone.
  if (status === "assigned") row.assigned_at = now;

  const { data, error } = await supabase
    .from("meal_plans")
    .upsert(row, { onConflict: "tenant_id,client_id" })
    .select("id, title, calories, protein_g, fat_g, carb_g, meals, notes, status, updated_at, assigned_at")
    .single();
  if (error) throw error;
  return data;
}

// ── Releasing drafted plans ────────────────────────────────────────────────────────────
// A drafted plan is finished work the client cannot see: status stays 'draft', and the
// client-read RLS policy (client_id = current_client_id() AND status = 'assigned') blocks
// the row outright. On 2026-07-30 that was 18 plans against 7 visible ones — the largest
// pool of completed-but-invisible work in the product, which is why the coach home surfaces
// it and why releasing has to be possible from there.

// Drafted plans with the client's name, for the coach home's release list. Coach-scoped by
// RLS (meal_plans_coach_all), so this returns nothing for a client session.
export async function listDraftMealPlans() {
  const { data, error } = await supabase
    .from("meal_plans")
    .select("id, client_id, title, calories, updated_at, clients!inner(display_name)")
    .eq("status", "draft")
    .order("updated_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    clientId: r.client_id,
    displayName: r.clients?.display_name ?? "Unnamed client",
    title: r.title,
    calories: r.calories,
    updatedAt: r.updated_at,
  }));
}

// Publish one drafted plan to its client's Nutrition tab.
//
// Deliberately a targeted UPDATE of two columns, not an upsert of the whole row: the plan's
// contents are not in scope here and must not be rewritten by a release. This is also why it
// cannot reintroduce the assigned_at bug — it only ever writes a date, never nulls one.
//
// The status guard makes the call idempotent and prevents a release from silently refreshing
// the assignment date of a plan that was already live.
export async function releaseMealPlan(clientId) {
  const { data, error } = await supabase
    .from("meal_plans")
    .update({ status: "assigned", assigned_at: new Date().toISOString() })
    .eq("client_id", clientId)
    .eq("status", "draft")
    .select("id, client_id, status, assigned_at")
    .maybeSingle();
  if (error) throw error;
  return data;
}
