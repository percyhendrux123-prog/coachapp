// Deno twin of src/lib/effectiveDays.js — byte-for-byte-equivalent logic. Edge
// functions run in a separate bundler and can't import from src/lib directly (same
// split as mealMacros.ts); effectiveDays.parity.test.ts (in the frontend repo) catches
// drift between them. If you change one, change the other the same way.
//
// The one shared resolver for "what order does this client actually walk through
// their program's days in." Every reader of current_day_index must go through this
// instead of indexing program.structure.days directly.
// Used by closeDayCore (workoutDay.ts), shared by both the app's Finish
// button (workout-close) and the mcp fn's complete_current_day tool.

export type ProgramDay = { day_id: string; kind: string; label?: string; [k: string]: unknown };
export type ProgramLike = { structure?: { days?: unknown[] } } | null | undefined;
export type AssignmentLike = { day_order?: string[] | null } | null | undefined;

export type EffectiveDaysResult = {
  days: ProgramDay[];
  usedFallback: boolean;
  fallbackReason: string | null;
};

export function resolveEffectiveDays(program: ProgramLike, assignment: AssignmentLike): EffectiveDaysResult {
  const programDays: ProgramDay[] = Array.isArray(program?.structure?.days)
    ? (program!.structure!.days as ProgramDay[])
    : [];
  const dayOrder = assignment?.day_order;

  if (dayOrder == null) {
    return { days: programDays, usedFallback: false, fallbackReason: null };
  }
  if (!Array.isArray(dayOrder) || dayOrder.length === 0) {
    return { days: programDays, usedFallback: false, fallbackReason: null };
  }

  const programIds = programDays.map((d) => d?.day_id);
  const validIds = new Set(programIds.filter((id) => id != null));
  const distinctOrderIds = new Set(dayOrder);

  const isExactPermutation =
    dayOrder.length === programIds.length &&
    distinctOrderIds.size === dayOrder.length &&
    dayOrder.every((id) => validIds.has(id));

  if (!isExactPermutation) {
    return {
      days: programDays,
      usedFallback: true,
      fallbackReason:
        "assignment.day_order no longer matches this program's current days (the coach likely edited the program since the last adjustment) — falling back to program order",
    };
  }

  const byId = new Map(programDays.map((d) => [d.day_id, d]));
  const days = dayOrder.map((id) => byId.get(id)!);
  return { days, usedFallback: false, fallbackReason: null };
}
