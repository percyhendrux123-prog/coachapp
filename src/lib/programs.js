// Coach-side program library + assignment. Coach ALL policies (tenant + role) gate
// programs and assignments, so these are direct client-side writes — no edge function.
import { supabase } from "./supabase";

// Programs with their active-assignment usage. Hand-built splits and AI-generated
// per-client plans share the table; source_draft_id tells them apart (no template flag).
export async function listPrograms() {
  const [{ data: programs, error }, { data: assigns, error: e2 }] = await Promise.all([
    supabase.from("programs")
      .select("id, name, structure, is_default, source_draft_id, created_at")
      .order("created_at", { ascending: false }),
    supabase.from("assignments").select("program_id, client_id, active").eq("active", true),
  ]);
  if (error) throw error;
  if (e2) throw e2;
  const activeByProgram = {};
  for (const a of assigns ?? []) (activeByProgram[a.program_id] ??= []).push(a.client_id);
  return (programs ?? []).map((p) => ({ ...p, active_client_ids: activeByProgram[p.id] ?? [] }));
}

// Deep-copy a structure, minting fresh uuids for every day/group/exercise node.
// (Set rows carry no ids — set_index is positional.) Used by duplicate; the builder
// reuses mintDay/mintGroup/mintExercise for NEW nodes while PRESERVING existing ids.
export const newId = () => crypto.randomUUID();
export function remintStructure(structure) {
  const days = Array.isArray(structure?.days) ? structure.days : [];
  return {
    ...structure,
    days: days.map((d) => ({
      ...d, day_id: newId(),
      groups: (d.groups ?? []).map((g) => ({
        ...g, group_id: newId(),
        exercises: (g.exercises ?? []).map((ex) => ({ ...ex, exercise_id: newId() })),
      })),
    })),
  };
}

// Clone-to-customize: fresh uuids so the copy's execution history never collides
// with the original's.
export async function duplicateProgram(program, tenantId) {
  const { data, error } = await supabase.from("programs").insert({
    tenant_id: tenantId, name: `${program.name} (copy)`,
    structure: remintStructure(program.structure),
    meal_plan: program.meal_plan ?? null, is_default: false, source_draft_id: null,
  }).select("id, name").single();
  if (error) throw error;
  return data;
}

// Assign a program to clients: deactivate each client's prior active assignment,
// then insert the new one at day 0 — the publish_program_draft one-active pattern.
export async function assignProgram({ programId, clientIds, tenantId }) {
  for (const clientId of clientIds) {
    const { error: d } = await supabase.from("assignments")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("client_id", clientId).eq("active", true);
    if (d) throw d;
    const { error: i } = await supabase.from("assignments")
      .insert({ tenant_id: tenantId, client_id: clientId, program_id: programId, active: true, current_day_index: 0 });
    if (i) throw i;
  }
}

export async function createProgram({ tenantId, name, structure }) {
  const { data, error } = await supabase.from("programs")
    .insert({ tenant_id: tenantId, name, structure, is_default: false, source_draft_id: null })
    .select("id").single();
  if (error) throw error;
  return data;
}

export async function updateProgram(id, { name, structure }) {
  const { error } = await supabase.from("programs").update({ name, structure }).eq("id", id);
  if (error) throw error;
}
