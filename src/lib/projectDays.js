// Pure day-sequence projection — the one shared algorithm behind every forward
// calendar view in this app: the coach roster calendar (schedule.js), the client's
// own forward schedule (clientSchedule.js), and the Deno twin backing the
// get_client_schedule / my_schedule MCP tools (supabase/functions/mcp/scheduleView.ts).
// Extracted into its own zero-dependency module (no supabase.js in the import chain)
// so it's directly unit-testable under plain `node --test` — schedule.js imports
// supabase.js at module top-level, which throws without Vite's env injection (see
// clientSchedule.js's header for the same constraint on that file).
//
// `effectiveDays` is day_order-swapped, if the client has adjusted their schedule
// (see effectiveDays.js); `programDays` is the coach's own unswapped authored order.
// The projection follows effectiveDays for the REMAINING slots of the current block,
// then falls through to programDays for anything past that boundary — closeDayCore
// resets assignment.day_order to null on every new block (an adjustment lasts exactly
// one block per decision 3, the implementation specification), so
// carrying a swap past the boundary would project a day that will never actually
// happen (finding B2.3, the implementation specification).
import { startOfDay } from "./dateOnly.js";

export function projectDays(effectiveDays, programDays, currentIndex, startDate, count) {
  if (!Array.isArray(effectiveDays) || effectiveDays.length === 0) return [];
  const base = startOfDay(startDate);
  const unswapped = Array.isArray(programDays) && programDays.length > 0 ? programDays : effectiveDays;
  const remaining = effectiveDays.length - currentIndex; // slots left before the block boundary
  const out = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(base);
    date.setDate(base.getDate() + i);
    const day = i < remaining ? effectiveDays[currentIndex + i] : unswapped[(i - remaining) % unswapped.length];
    out.push({ date, offset: i, day });
  }
  return out;
}
