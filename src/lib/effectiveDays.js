// The one shared resolver for "what order does this client actually walk through
// their program's days in." Every reader of current_day_index must go through this
// instead of indexing program.structure.days directly — see
// the implementation specification, "The one invariant everything
// hangs on."
//
// A program's day order (program.structure.days) is the coach's authored sequence and
// never changes for schedule-adjustment purposes. assignment.day_order is a nullable
// permutation of that same sequence's day_ids, scoped to one assignment (one block):
// null means "no override — use the program's own order"; set means "walk the days in
// this order instead." current_day_index always indexes into the RESULT of this
// resolver, never into program.structure.days directly.
//
// Twin: supabase/functions/_shared/effectiveDays.ts (Deno edge-function runtime can't
// import from src/lib — see mealMacros.js's header for why this split exists). Keep
// both in sync by hand; effectiveDays.parity.test.ts catches drift between them.
//
// Pure, no I/O: program + assignment are plain data already fetched by the caller.

/**
 * @param {{ structure?: { days?: unknown[] } } | null | undefined} program
 * @param {{ day_order?: string[] | null } | null | undefined} assignment
 * @returns {{ days: unknown[], usedFallback: boolean, fallbackReason: string | null }}
 */
export function resolveEffectiveDays(program, assignment) {
  const programDays = Array.isArray(program?.structure?.days) ? program.structure.days : [];
  const dayOrder = assignment?.day_order;

  // No override set (the state of every assignment before its first adjustment, and
  // every fresh cycle per decision 3) — program order applies untouched.
  if (dayOrder == null) {
    return { days: programDays, usedFallback: false, fallbackReason: null };
  }
  if (!Array.isArray(dayOrder) || dayOrder.length === 0) {
    return { days: programDays, usedFallback: false, fallbackReason: null };
  }

  const programIds = programDays.map((d) => d?.day_id);
  const validIds = new Set(programIds.filter((id) => id != null));
  const distinctOrderIds = new Set(dayOrder);

  // Stale after a coach edit to the program (day added/removed/replaced): day_order no
  // longer names an exact permutation of the program's current day_ids. Per the plan,
  // this falls back to program order ENTIRELY — never a partial reorder, never a
  // silent drop of the override. The mismatch is a system state worth surfacing
  // (fallbackReason), not something to paper over.
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
  const days = dayOrder.map((id) => byId.get(id));
  return { days, usedFallback: false, fallbackReason: null };
}
