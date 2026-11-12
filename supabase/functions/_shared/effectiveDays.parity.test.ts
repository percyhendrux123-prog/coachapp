// Parity test between src/lib/effectiveDays.js and its hand-maintained Deno twin,
// effectiveDays.ts. There's no automated sync between the two — this is the only
// thing that catches drift when one changes without the other. Run with:
//   deno test --no-check --allow-read supabase/functions/_shared/effectiveDays.parity.test.ts
// --no-check is required to import the plain-JS twin without Deno's type checker
// tripping on the lack of static types there — this is a runtime-output parity
// check, not a type check (same rationale as mealMacros.parity.test.ts).

// @ts-nocheck
import { resolveEffectiveDays as jsResolve } from "../../../src/lib/effectiveDays.js";
import { resolveEffectiveDays as tsResolve } from "./effectiveDays.ts";

function assertDeepEqual(a: unknown, b: unknown, label: string) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) {
    throw new Error(`${label}: JS and TS twins disagree.\n  JS: ${sa}\n  TS: ${sb}`);
  }
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

const CASES: Record<string, unknown> = {
  nullOrder: { day_order: null },
  noAssignment: {},
  validPermutation: { day_order: ["d", "a", "b", "c"] },
  staleUnknownId: { day_order: ["d", "a", "b", "e"] },
  wrongLength: { day_order: ["a", "b", "c"] },
  duplicateId: { day_order: ["a", "a", "b", "c"] },
  emptyArray: { day_order: [] },
};

Deno.test("effectiveDays JS/TS twins agree on every case", () => {
  for (const [name, assignment] of Object.entries(CASES)) {
    assertDeepEqual(jsResolve(PROGRAM, assignment), tsResolve(PROGRAM, assignment), name);
  }
  assertDeepEqual(jsResolve(null, { day_order: ["a"] }), tsResolve(null, { day_order: ["a"] }), "noProgram");
});
