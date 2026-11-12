import test from "node:test";
import assert from "node:assert/strict";
import { summarizeAdjustment, reasonChipLabel } from "./scheduleAdjustments.js";

const LABELS = { a: "Push", b: "Pull", c: "Rest", d: "Legs" };

test("summarizeAdjustment identifies the displaced day and the pulled-forward day", () => {
  // Client pulled Legs (d) to today, pushing Push (a) three slots later.
  const out = summarizeAdjustment({
    oldOrder: ["a", "b", "c", "d"],
    newOrder: ["d", "b", "c", "a"],
    dayLabelById: LABELS,
  });
  assert.equal(out.movedLabel, "Push");
  assert.equal(out.pulledLabel, "Legs");
  assert.equal(out.slotsLater, 3);
});

test("summarizeAdjustment returns null for a no-op (identical orders) rather than throwing", () => {
  const out = summarizeAdjustment({ oldOrder: ["a", "b"], newOrder: ["a", "b"], dayLabelById: LABELS });
  assert.equal(out, null);
});

test("summarizeAdjustment falls back to a generic label for an unknown day id", () => {
  const out = summarizeAdjustment({ oldOrder: ["a", "b"], newOrder: ["b", "a"], dayLabelById: {} });
  assert.equal(out.movedLabel, "a day");
  assert.equal(out.pulledLabel, "a day");
});

test("reasonChipLabel maps a known chip value to its display label", () => {
  assert.equal(reasonChipLabel("no_gym_access"), "No gym access");
});

test("reasonChipLabel falls back to the raw value for an unrecognized tag rather than hiding it", () => {
  assert.equal(reasonChipLabel("weird_custom_value"), "weird_custom_value");
});
