import test from "node:test";
import assert from "node:assert/strict";
import { generateTrainingProgram } from "./programGen.js";

function trainingDays(prog) {
  return prog.days.filter((d) => d.kind === "training");
}

test("every training day emits at most one superset group, and it has exactly 2 exercises", () => {
  for (const daysPerWeek of [3, 4, 5, 6]) {
    const prog = generateTrainingProgram({ daysPerWeek, experience: "intermediate", equipment: "full_gym", injuries: [] });
    for (const day of trainingDays(prog)) {
      const supersets = day.groups.filter((g) => g.type === "superset");
      assert.ok(supersets.length <= 1, `${day.label}: expected at most 1 superset group, got ${supersets.length}`);
      for (const g of supersets) {
        assert.equal(g.exercises.length, 2, `${day.label}: superset group should pair exactly 2 exercises`);
      }
    }
  }
});

test("a superset's two exercises never also appear in the straight group", () => {
  const prog = generateTrainingProgram({ daysPerWeek: 4, experience: "beginner", equipment: "full_gym", injuries: [] });
  for (const day of trainingDays(prog)) {
    const superset = day.groups.find((g) => g.type === "superset");
    if (!superset) continue;
    const straight = day.groups.find((g) => g.type === "straight");
    const supersetNames = new Set(superset.exercises.map((e) => e.name));
    const straightNames = (straight?.exercises ?? []).map((e) => e.name);
    for (const name of straightNames) assert.ok(!supersetNames.has(name), `${name} appears in both groups`);
  }
});

test("every exercise across all groups in a day is unique (no duplicate slot)", () => {
  const prog = generateTrainingProgram({ daysPerWeek: 6, experience: "advanced", equipment: "full_gym", injuries: [] });
  for (const day of trainingDays(prog)) {
    const ids = day.groups.flatMap((g) => g.exercises.map((e) => e.exercise_id));
    assert.equal(new Set(ids).size, ids.length, `${day.label}: duplicate exercise_id across groups`);
  }
});

test("training frequency still resolves and rest days still fill the week (unaffected by superset change)", () => {
  const prog = generateTrainingProgram({ daysPerWeek: 4, experience: "beginner", equipment: "full_gym", injuries: [] });
  assert.equal(prog.days.length, 7);
  assert.equal(prog.frequency.training_days, 4);
  assert.equal(prog.frequency.rest_days, 3);
});
