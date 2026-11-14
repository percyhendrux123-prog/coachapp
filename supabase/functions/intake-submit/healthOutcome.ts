// What intake-submit answers when a health screen is flagged. Pure, no I/O, so the exact
// response bodies are pinned by tests (healthOutcome.test.ts).
//
// Coached tenants: byte-for-byte what intake-submit has always returned (a coach reviews).
// Self-serve tenants (P33): nobody here reviews a health answer. The fixed table in
// _shared/parq.ts decides between "doctor first" (needs_clearance: the signed-in person
// confirms their own doctor's clearance in the app, then a conservative plan is built) and
// "no self-serve plan" (blocked_health). Either way no plan is built here.
import { blockedReason, classifyFlags } from "../_shared/parq.ts";

// W9 — the text a connected AI gets back. An assistant can never answer the health screen or
// confirm clearance; there is no tool for it and system-clearance refuses connector tokens.
export const W9_TEXT =
  "Health screen flagged. No plan was built. The person must open the app, read the hold screen, and confirm their doctor's clearance themselves. An assistant cannot answer the health screen or confirm clearance for them.";

export const COACHED_HELD_MESSAGE = "Health-screen flag raised — held for coach review. No plan auto-generated.";

export function coachedHeldBody(draftId: string, healthFlags: string[]) {
  return { status: "held_medical", draft_id: draftId, health_flags: healthFlags, mode: "coached", message: COACHED_HELD_MESSAGE };
}

export type SelfServeHealth =
  | { status: "blocked_health"; reason: "pregnancy" | "eating_disorder_history" | "other" }
  | { status: "needs_clearance" };

// null = no flags, build as normal. A blocking flag anywhere wins over doctor-first flags.
export function selfServeHealthOutcome(flags: string[]): SelfServeHealth | null {
  if (!Array.isArray(flags) || flags.length === 0) return null;
  const reason = blockedReason(flags);
  if (reason) return { status: "blocked_health", reason };
  if (classifyFlags(flags).doctor_first.length > 0) return { status: "needs_clearance" };
  return { status: "blocked_health", reason: "other" }; // unreachable: fail closed
}

export function blockedBody(intakeId: string, reason: string) {
  return { status: "blocked_health", reason, intake_id: intakeId, mode: "self_serve", message: W9_TEXT };
}

export function needsClearanceBody(intakeId: string, draftId: string, healthFlags: string[]) {
  return { status: "needs_clearance", intake_id: intakeId, draft_id: draftId, health_flags: healthFlags, mode: "self_serve", message: W9_TEXT };
}
