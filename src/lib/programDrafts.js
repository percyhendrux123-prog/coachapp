// Coach-side program draft review — the approve/reject path for AI-generated plans.
//
// Until 2026-07-31 no frontend path called approve_program_draft at all: the coach home
// rendered a "Program drafts awaiting approval" count with nothing behind it, so a draft
// could sit at 'draft' indefinitely with the coach believing they had released it. The
// function itself was always correct and reachable (authenticated holds EXECUTE); what was
// missing was any caller.
import { supabase } from "./supabase";

// Pending drafts with the client's name, for the coach home's review list. Coach-scoped by
// RLS (drafts_coach_all = tenant + coach role), so this returns nothing for a client session.
//
// 'held_medical' is included ON PURPOSE. approve_program_draft accepts both 'draft' and
// 'held_medical', but rm_coach_overview's draft_approval count selects only status='draft' —
// so a medically-held draft is invisible in the count. Listing only what the count knows
// about would reproduce exactly the failure this screen exists to fix: work sitting in a
// state nobody can see. The count and this list may therefore disagree; the panel says so
// rather than silently showing a different number.
export async function listPendingProgramDrafts() {
  const { data, error } = await supabase
    .from("program_drafts")
    .select("id, client_id, status, training, health_flags, rationale, generated_at, clients!inner(display_name)")
    .in("status", ["draft", "held_medical"])
    .order("generated_at", { ascending: true });
  if (error) throw error;
  const drafts = data ?? [];

  // publish_program_draft deactivates whatever assignment is currently active for the
  // client, unconditionally — including one the coach built or assigned by hand after
  // this draft was generated. A draft still sitting at 'draft' has, by definition, never
  // published anything, so any active assignment found here belongs to something else.
  // Surface that up front rather than letting the coach discover it after clicking Approve.
  const clientIds = [...new Set(drafts.map((r) => r.client_id))];
  let activeByClient = new Map();
  if (clientIds.length) {
    const { data: active, error: ae } = await supabase
      .from("assignments")
      .select("client_id, assigned_at, programs(name)")
      .in("client_id", clientIds)
      .eq("active", true);
    if (!ae) {
      activeByClient = new Map((active ?? []).map((a) => [a.client_id, a]));
    }
    // A failed read here should not block the whole panel from rendering — worst case
    // the warning is silently absent for this load, same as before this change existed.
  }

  return drafts.map((r) => {
    const active = activeByClient.get(r.client_id);
    return {
      id: r.id,
      clientId: r.client_id,
      displayName: r.clients?.display_name ?? "Unnamed client",
      status: r.status,
      held: r.status === "held_medical",
      // Day count, not the days themselves — publish refuses an empty plan, and a held draft
      // with zero days cannot be approved until the coach builds one. Surfacing the number is
      // what tells the coach which case they are looking at.
      dayCount: Array.isArray(r.training?.days) ? r.training.days.length : 0,
      healthFlags: Array.isArray(r.health_flags) ? r.health_flags : [],
      rationale: r.rationale ?? null,
      generatedAt: r.generated_at,
      activeProgramName: active?.programs?.name ?? null,
      activeAssignedAt: active?.assigned_at ?? null,
    };
  });
}

// Approve or reject one draft.
//
// approve_program_draft is SECURITY DEFINER and raises loudly on wrong role, wrong tenant,
// non-pending status, and on approving a medical hold that has no plan built yet. Those
// raises are the point — they are surfaced to the coach verbatim rather than swallowed,
// because a click that silently does nothing is what cost a client a day.
//
// On 'approve' the function also runs publish_program_draft in the same transaction, so a
// successful return means: draft approved -> programs row inserted -> prior assignment
// deactivated -> new active assignment inserted. Returns
// { status: 'published', program_id, draft_id } or { status: 'rejected', draft_id }.
export async function decideProgramDraft({ draftId, decision, note = null }) {
  const { data, error } = await supabase.rpc("approve_program_draft", {
    p_draft_id: draftId,
    p_decision: decision,
    p_note: note,
  });
  if (error) throw new Error(error.message || `Could not ${decision} this draft.`);
  if (!data) throw new Error("The approval returned nothing. Treat this as not published.");
  return data;
}

// Prove the publish chain actually landed, rather than trusting the return value.
//
// The full chain is approve -> publish -> programs row -> active assignment -> renders, and
// anything short of all four looks identical to failure from the coach's side. This reads
// back the two rows that decide it, so the UI can report "published and live" only when both
// are observed. A mismatch is reported as a partial publish, never as success.
export async function verifyPublishedChain({ programId, clientId }) {
  // Deliberately NOT maybeSingle() on the assignment read: that throws when more than one
  // row comes back, which is exactly the broken state this check exists to catch. Reading
  // the list lets a violated one-active-assignment invariant be reported instead of
  // surfacing as an opaque query error.
  const [{ data: program, error: pe }, { data: assignments, error: ae }] = await Promise.all([
    supabase.from("programs").select("id, name").eq("id", programId).maybeSingle(),
    supabase.from("assignments").select("id, program_id, active, current_day_index")
      .eq("client_id", clientId).eq("active", true),
  ]);
  if (pe) throw pe;
  if (ae) throw ae;
  const active = assignments ?? [];
  const hasProgram = !!program;
  const pointsAtProgram = active.some((a) => a.program_id === programId);
  const hasAssignment = active.length === 1 && pointsAtProgram;
  return {
    ok: hasProgram && hasAssignment,
    hasProgram,
    hasAssignment,
    programName: program?.name ?? null,
    // Named so the caller can state which half failed. "It didn't work" is not a report.
    detail: hasProgram && hasAssignment
      ? null
      : !hasProgram
        ? "The program row was not found after publishing."
        : active.length === 0
          ? "The program was created but no active assignment points at it — the client will not see it."
          : !pointsAtProgram
            ? "The program was created but the client's active assignment points at a different program."
            : `The client has ${active.length} active assignments at once — only one should ever be active.`,
  };
}
