// starter-content/: the generated SQL files must match their JSON sources, every sample
// program must have the shape the program builder and the client session runner read, and
// every file must say it is sample content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAll, toStructure } from "../../scripts/build-starter-sql.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(root, "starter-content");
const read = (name) => readFileSync(join(dir, name), "utf8");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("generated starter SQL is up to date (run node scripts/build-starter-sql.mjs)", () => {
  for (const [name, text] of Object.entries(buildAll())) {
    assert.equal(read(name), text, `${name} is stale`);
  }
});

test("every starter file is marked as sample content", () => {
  for (const name of ["programs.json", "meal-plan-template.json", "sample_programs.sql", "sample_meal_plan.sql", "README.md"]) {
    assert.match(read(name), /sample content, edit before use/i, name);
  }
});

test("sample programs have the structure the builder and session runner expect", () => {
  const { programs } = JSON.parse(read("programs.json"));
  assert.ok(programs.length >= 2 && programs.length <= 3);
  const ids = new Set();
  for (const p of programs) {
    assert.match(p.name, /^Sample: /);
    const s = toStructure(p);
    assert.ok(s.days.length > 0);
    assert.ok(s.days.some((d) => d.kind === "training"), `${p.name} has no training day`);
    for (const d of s.days) {
      assert.ok(d.kind === "training" || d.kind === "rest");
      assert.match(d.day_id, UUID);
      assert.ok(d.label.trim());
      if (d.kind === "rest") { assert.deepEqual(d.groups, []); continue; }
      assert.ok(d.groups.length > 0, `${p.name} / ${d.label} has no groups`);
      for (const g of d.groups) {
        assert.ok(["straight", "superset", "circuit"].includes(g.type));
        assert.ok(g.exercises.length > 0);
        for (const ex of g.exercises) {
          assert.ok(ex.name.trim());
          assert.ok(!ids.has(ex.exercise_id), "exercise ids must be unique");
          ids.add(ex.exercise_id);
          assert.ok(ex.sets.length > 0);
          ex.sets.forEach((st, i) => assert.equal(st.set_index, i));
          if (ex.type === "cardio") {
            assert.equal(ex.sets.length, 1);
            assert.ok(ex.cardio.modality);
            assert.ok(ex.cardio.target_duration_min != null || ex.cardio.target_distance != null);
          } else {
            assert.equal(ex.type, "strength");
            for (const st of ex.sets) assert.ok(String(st.target_reps).trim());
          }
        }
      }
    }
  }
});

test("sample meal plan passes the release gate and its totals add up", () => {
  const plan = JSON.parse(read("meal-plan-template.json"));
  for (const k of ["calories", "protein_g", "fat_g", "carb_g"]) assert.equal(typeof plan[k], "number", k);
  assert.ok(plan.meals.length > 0);
  const kcal = plan.meals.flatMap((m) => m.items).reduce((s, it) => s + it.kcal, 0);
  assert.ok(Math.abs(kcal - plan.calories) <= plan.calories * 0.05, `items add to ${kcal}`);
  const macroKcal = plan.protein_g * 4 + plan.fat_g * 9 + plan.carb_g * 4;
  assert.ok(Math.abs(macroKcal - plan.calories) <= plan.calories * 0.05, `macros add to ${macroKcal}`);
  // The SQL saves a draft only; the coach releases it from the app.
  assert.match(read("sample_meal_plan.sql"), /'draft'\)\s*\n\s*on conflict \(tenant_id, client_id\) do nothing/);
});

test("starter SQL only inserts, and only into the owner account", () => {
  for (const name of ["sample_programs.sql", "sample_meal_plan.sql"]) {
    const sql = read(name).replace(/\$json\$[\s\S]*?\$json\$/g, "''");
    assert.doesNotMatch(sql, /\b(delete|drop|truncate|alter|grant|revoke)\b/i, name);
    assert.doesNotMatch(sql, /\bupdate\s+public\./i, name);
    assert.match(sql, /slug = 'owner'/, name);
  }
});
