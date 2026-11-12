// Shared day-close core — the ONE place that advances an assignment through its program.
// Callers (workout-close edge fn for the app's Finish button; the mcp fn's
// complete_current_day client-agent tool) load + ownership-check the assignment and
// program themselves, then delegate here. Semantics are load-bearing and identical for
// both: training days require/complete the day's workout_session; rest days advance
// session-free; closing an already-passed day is a no-op (idempotent double-tap); the
// final day deactivates the assignment and starts a fresh one on the same program
// (one assignment per run-through — "a block"), recording the boundary in
// notification_log so the coach sees the cycle.
import type { admin } from "./challenge.ts";
import { resolveEffectiveDays } from "./effectiveDays.ts";

type Day = { day_id: string; kind: string; label?: string };
type Db = ReturnType<typeof admin>;

export type CloseDayResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string };

// Record the block completion for the coach (best-effort — never blocks day-close on
// failure — but the failure itself must be visible, not swallowed).
async function notifyBlockComplete(db: Db, a: any, program: any, nextAssignmentId: string) {
  const { error } = await db.from("notification_log").insert({
    tenant_id: a.tenant_id, client_id: a.client_id, channel: "push",
    template: "program_block_complete", status: "recorded",
    consent_snapshot: { assignment_id: a.id, program_id: program.id, program_name: program.name, next_assignment_id: nextAssignmentId },
  });
  if (error) console.error("notifyBlockComplete: notification_log insert failed:", error.message);
}

export async function closeDayCore(db: Db, assignment: any, program: any, dayId: string): Promise<CloseDayResult> {
  if (!assignment.active) return { ok: false, status: 409, error: "assignment is no longer active" };

  // Reordered per assignment.day_order (client schedule adjustments) when set, else
  // the program's own order — see effectiveDays.ts. current_day_index always indexes
  // into this resolved order, never program.structure.days directly.
  const { days } = resolveEffectiveDays(program, assignment) as { days: Day[] };
  if (days.length === 0) return { ok: false, status: 500, error: "program has no days" };

  // current_day_index is a 0-based index into structure.days (live convention).
  const idx = assignment.current_day_index;
  const day = days[idx];
  if (!day) return { ok: false, status: 409, error: `no day at index ${idx}` };

  // Idempotency: closing a day that is no longer current is a no-op, not an error —
  // a double-tap on "finish" must not burn through extra days.
  if (day.day_id !== dayId) {
    const already = days.findIndex((d) => d.day_id === dayId);
    if (already !== -1 && already < idx) {
      return { ok: true, body: { assignment_id: assignment.id, closed_day_index: already, already_closed: true, current_day_index: idx } };
    }
    return { ok: false, status: 409, error: "day_id is not the current day" };
  }

  // Training days must have their session completed; rest days advance session-free.
  if (day.kind === "training") {
    const { data: session } = await db.from("workout_sessions").select("id, status")
      .eq("assignment_id", assignment.id).eq("day_id", dayId).maybeSingle();
    if (!session) return { ok: false, status: 409, error: "no workout session for this day — start the workout first" };
    if (session.status !== "complete") {
      const { error } = await db.from("workout_sessions")
        .update({ status: "complete", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", session.id);
      if (error) return { ok: false, status: 500, error: "session close failed: " + error.message };
    }
  }

  const isFinalDay = idx >= days.length - 1;

  if (!isFinalDay) {
    const { error } = await db.from("assignments")
      .update({ current_day_index: idx + 1, updated_at: new Date().toISOString() })
      .eq("id", assignment.id);
    if (error) return { ok: false, status: 500, error: "advance failed: " + error.message };
    return { ok: true, body: { assignment_id: assignment.id, closed_day_index: idx, current_day_index: idx + 1, cycled: false } };
  }

  // Final day → close out this block and start the next: deactivate, then a fresh
  // assignment on the same program (the one-active-per-client pattern the
  // publish_program_draft RPC uses). Client is never left without an active program.
  const { error: deact } = await db.from("assignments")
    .update({ active: false, current_day_index: idx + 1, updated_at: new Date().toISOString() })
    .eq("id", assignment.id);
  if (deact) return { ok: false, status: 500, error: "deactivate failed: " + deact.message };

  // A fresh block always starts from the coach's own program order (decision 3, plan
  // 2026-08-31): a client's schedule adjustment lasts exactly one block and never
  // carries forward. day_order stated explicitly here even though it's the column
  // default, so that intent survives a future default change.
  const { data: next, error: ins } = await db.from("assignments")
    .insert({ tenant_id: assignment.tenant_id, client_id: assignment.client_id, program_id: assignment.program_id, active: true, current_day_index: 0, day_order: null })
    .select("id").single();
  if (ins) return { ok: false, status: 500, error: "next-cycle assignment failed: " + ins.message };

  await notifyBlockComplete(db, assignment, program, next.id);

  return { ok: true, body: {
    assignment_id: assignment.id, closed_day_index: idx, cycled: true,
    next_assignment_id: next.id, current_day_index: 0,
  } };
}
