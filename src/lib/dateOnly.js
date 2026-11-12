// Zero-dependency date-only primitives — the node-test-safe subset of
// src/lib/schedule.js's date math. schedule.js can't be statically imported by
// anything that needs to run under plain `node --test` (no Vite env injection):
// it imports ./supabase, which calls createClient(import.meta.env..., ...) at
// module top-level and throws outside a Vite runtime. These two functions are
// byte-identical to schedule.js's versions; keep them in sync if that file's
// day math ever changes. Shared by clientSchedule.js and consistency.js so the
// duplication exists in exactly one place instead of once per caller.
export function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function ymd(date) {
  const d = new Date(date);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
