import test from "node:test";
import assert from "node:assert/strict";
import { resolveEffectiveDays } from "./effectiveDays.js";

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

test("null day_order falls back to program order", () => {
  const out = resolveEffectiveDays(PROGRAM, { day_order: null });
  assert.equal(out.usedFallback, false);
  assert.deepEqual(out.days.map((d) => d.day_id), ["a", "b", "c", "d"]);
});

test("missing assignment (undefined day_order) falls back to program order", () => {
  const out = resolveEffectiveDays(PROGRAM, {});
  assert.equal(out.usedFallback, false);
  assert.deepEqual(out.days.map((d) => d.day_id), ["a", "b", "c", "d"]);
});

test("no program at all resolves to an empty day list, not a throw", () => {
  const out = resolveEffectiveDays(null, { day_order: ["a"] });
  assert.equal(out.days.length, 0);
});

test("valid permutation reorders the program's days", () => {
  const out = resolveEffectiveDays(PROGRAM, { day_order: ["d", "a", "b", "c"] });
  assert.equal(out.usedFallback, false);
  assert.deepEqual(out.days.map((d) => d.day_id), ["d", "a", "b", "c"]);
  assert.equal(out.days[0].label, "Legs");
});

test("stale day_order (references a day_id no longer in the program) falls back to program order entirely — not partial", () => {
  // Simulates the coach editing the program after this assignment's day_order was set:
  // "e" no longer exists, so the whole override is treated as stale, not just the one bad id.
  const out = resolveEffectiveDays(PROGRAM, { day_order: ["d", "a", "b", "e"] });
  assert.equal(out.usedFallback, true);
  assert.ok(out.fallbackReason);
  assert.deepEqual(out.days.map((d) => d.day_id), ["a", "b", "c", "d"]);
});

test("day_order with the wrong length (program grew/shrank) falls back to program order entirely", () => {
  const out = resolveEffectiveDays(PROGRAM, { day_order: ["a", "b", "c"] });
  assert.equal(out.usedFallback, true);
  assert.deepEqual(out.days.map((d) => d.day_id), ["a", "b", "c", "d"]);
});

test("day_order with a duplicate id is rejected as stale, not silently deduped", () => {
  const out = resolveEffectiveDays(PROGRAM, { day_order: ["a", "a", "b", "c"] });
  assert.equal(out.usedFallback, true);
  assert.deepEqual(out.days.map((d) => d.day_id), ["a", "b", "c", "d"]);
});

test("empty-array day_order behaves like null (program order, no fallback flag)", () => {
  const out = resolveEffectiveDays(PROGRAM, { day_order: [] });
  assert.equal(out.usedFallback, false);
  assert.deepEqual(out.days.map((d) => d.day_id), ["a", "b", "c", "d"]);
});
