// Client-side data layer for schedule adjustments — swapping today's planned day
// with a later day in the current block. See
// the implementation specification The only write path is the
// adjust_my_schedule() RPC (SECURITY DEFINER): it re-derives the current effective
// order itself and validates the swap server-side, so this file stays a thin
// pass-through with no client-side trust of its own.
//
// No static import of ./supabase here — same reasoning as clientSchedule.js's
// header: supabase.js calls createClient(import.meta.env...) at module top-level,
// which throws under plain `node --test`. summarizeAdjustment/reasonChipLabel are
// pure and unit-tested directly; adjustMySchedule loads supabase via dynamic
// import, deferring that chain to call time (same pattern Client.jsx/CoachCockpit.jsx
// already use for lazy fixture loading).

// Six fixed chips, free text in the DB (free text by design —
// changing the set later is a UI edit, not a migration). "Skip" sends both as null,
// which is a real, first-class choice — not a default standing in for a value.
export const REASON_CHIPS = [
  { value: "work", label: "Work" },
  { value: "travel", label: "Travel" },
  { value: "family", label: "Family" },
  { value: "recovery", label: "Recovery" },
  { value: "no_gym_access", label: "No gym access" },
  { value: "other", label: "Other" },
];

export function reasonChipLabel(value) {
  return REASON_CHIPS.find((c) => c.value === value)?.label ?? value;
}

// newOrder: the FULL array of the program's day_ids, in the desired order — build
// it by swapping two positions in the client's current effective order (see
// effectiveDays.js), never a partial list. reasonTag/reasonNote default to null
// (skipped), which the RPC stores as NULL, not a substituted value.
export async function adjustMySchedule({ assignmentId, newOrder, reasonTag = null, reasonNote = null }) {
  const { supabase } = await import("./supabase");
  const { error } = await supabase.rpc("adjust_my_schedule", {
    p_assignment_id: assignmentId,
    p_new_order: newOrder,
    p_reason_tag: reasonTag,
    p_reason_note: reasonNote,
  });
  if (error) throw error;
}

// Plain-English summary of one schedule_adjustments row, for the coach's per-client
// event log. old_order/new_order are guaranteed to agree on every position before
// the adjustment's current_day_index at the time it happened (the RPC enforces
// that), so the FIRST position where they differ is exactly "today" at that
// moment: old_order there is the day that got pushed later, new_order there is the
// day the client pulled forward into today. Where the pushed day actually landed
// is found by locating it in new_order — that answers "moved to [slot]" without
// needing to reconstruct a calendar date (this app is sequence-based, not
// date-scheduled — see the plan's opening note — so a slot number is the honest
// unit here, not a weekday that would need a timezone assumption to compute).
export function summarizeAdjustment({ oldOrder, newOrder, dayLabelById }) {
  if (!Array.isArray(oldOrder) || !Array.isArray(newOrder)) return null;
  const n = Math.min(oldOrder.length, newOrder.length);
  let firstDiff = -1;
  for (let i = 0; i < n; i++) {
    if (oldOrder[i] !== newOrder[i]) { firstDiff = i; break; }
  }
  if (firstDiff === -1) return null; // no actual change (shouldn't happen; don't crash on it)

  const movedDayId = oldOrder[firstDiff];
  const pulledDayId = newOrder[firstDiff];
  const newPosition = newOrder.indexOf(movedDayId);
  const slotsLater = newPosition === -1 ? null : newPosition - firstDiff;

  return {
    movedDayId,
    pulledDayId,
    movedLabel: dayLabelById?.[movedDayId] ?? "a day",
    pulledLabel: dayLabelById?.[pulledDayId] ?? "a day",
    slotsLater,
  };
}
