// Run with: deno test --no-check --allow-read supabase/functions/_shared/effectiveDays.test.ts
import { resolveEffectiveDays } from "./effectiveDays.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const PROGRAM = {
  structure: {
    days: [
      { day_id: "a", kind: "training", label: "Push" },
      { day_id: "b", kind: "training", label: "Pull" },
      { day_id: "c", kind: "rest", label: "Rest" },
      { day_id: "d", kind: "training", label: "Legs" },
    ],
  },
};

Deno.test("null day_order falls back to program order", () => {
  const out = resolveEffectiveDays(PROGRAM, { day_order: null });
  assert(out.usedFallback === false, "should not fall back on null");
  assert(JSON.stringify(out.days.map((d) => d.day_id)) === JSON.stringify(["a", "b", "c", "d"]), "wrong order");
});

Deno.test("valid permutation reorders the program's days", () => {
  const out = resolveEffectiveDays(PROGRAM, { day_order: ["d", "a", "b", "c"] });
  assert(out.usedFallback === false, "valid permutation should not fall back");
  assert(JSON.stringify(out.days.map((d) => d.day_id)) === JSON.stringify(["d", "a", "b", "c"]), "wrong order");
  assert(out.days[0].label === "Legs", "first day should be Legs");
});

Deno.test("stale day_order (references a day_id no longer in the program) falls back entirely, not partially", () => {
  const out = resolveEffectiveDays(PROGRAM, { day_order: ["d", "a", "b", "e"] });
  assert(out.usedFallback === true, "stale order should fall back");
  assert(!!out.fallbackReason, "fallback must state why");
  assert(JSON.stringify(out.days.map((d) => d.day_id)) === JSON.stringify(["a", "b", "c", "d"]), "should be full program order");
});

Deno.test("day_order with the wrong length falls back to program order entirely", () => {
  const out = resolveEffectiveDays(PROGRAM, { day_order: ["a", "b", "c"] });
  assert(out.usedFallback === true, "wrong length should fall back");
  assert(JSON.stringify(out.days.map((d) => d.day_id)) === JSON.stringify(["a", "b", "c", "d"]), "should be full program order");
});

Deno.test("day_order with a duplicate id is rejected as stale", () => {
  const out = resolveEffectiveDays(PROGRAM, { day_order: ["a", "a", "b", "c"] });
  assert(out.usedFallback === true, "duplicate id should fall back");
});

Deno.test("no program resolves to an empty day list, not a throw", () => {
  const out = resolveEffectiveDays(null, { day_order: ["a"] });
  assert(out.days.length === 0, "should be empty");
});
