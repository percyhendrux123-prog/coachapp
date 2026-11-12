import test from "node:test";
import assert from "node:assert/strict";
import {
  computeMacros,
  missingBodyMetrics,
  missingParq,
  computeHealthFlags,
  FAT_PCT_FLOOR,
} from "./mealMacros.js";

// Golden values captured from the pre-refactor mealGen.js (git HEAD~1 as of the
// 2026-08-24 merge, commit 7e68666's parent) via its own computeMacros, run against
// these exact profiles, BEFORE mealMacros.js existed. Coach-driven generation always
// supplies a self-reported `activity`, so these profiles do too — that's the path the
// oracle and the merged code must agree on byte-for-byte. If one of these numbers
// changes, that's macro-math drift, not a golden-value update — investigate first.
const GOLDEN = {
  maleLifestyleFatLoss: {
    input: {
      sex: "male", age: 34, heightCm: 180, weightKg: 95, activity: "moderate",
      goal: "fat_loss", weeklyLossLb: 1.5, clientClass: "lifestyle",
    },
    expect: { calories: 2230, protein_g: 210, fat_g: 50, carb_g: 235, tdee: 2960, bmr: 1910 },
  },
  femaleCompetitorFatLossWithBf: {
    input: {
      sex: "female", age: 28, heightCm: 165, weightKg: 62, activity: "active",
      goal: "fat_loss", weeklyLossLb: 1.0, clientClass: "competitor",
      bodyFatPct: 22, proteinPerKgLbm: 2.8, fatPct: 18,
    },
    expect: { calories: 1820, protein_g: 135, fat_g: 35, carb_g: 240, tdee: 2330, bmr: 1350 },
  },
  maleMuscleGain: {
    input: {
      sex: "male", age: 25, heightCm: 178, weightKg: 78, activity: "very_active",
      goal: "muscle_gain", clientClass: "lifestyle",
    },
    expect: { calories: 3680, protein_g: 155, fat_g: 80, carb_g: 585, tdee: 3370, bmr: 1770 },
  },
  femaleRecompDefaultWeekly: {
    input: {
      sex: "female", age: 40, heightCm: 168, weightKg: 70, activity: "sedentary",
      goal: "recomp", clientClass: "lifestyle",
    },
    expect: { calories: 1580, protein_g: 140, fat_g: 35, carb_g: 175, tdee: 1670, bmr: 1390 },
  },
};

test("golden-value regression: coach-driven macro math is unchanged by the merge", () => {
  for (const [name, { input, expect: exp }] of Object.entries(GOLDEN)) {
    const got = computeMacros(input);
    for (const key of Object.keys(exp)) {
      assert.equal(got[key], exp[key], `${name}.${key}: expected ${exp[key]}, got ${got[key]}`);
    }
  }
});

test("missing goal throws instead of silently defaulting to recomp", () => {
  const base = { sex: "male", age: 30, heightCm: 180, weightKg: 85, activity: "moderate" };
  assert.throws(() => computeMacros({ ...base }), /goal is missing or not one of/);
  assert.throws(() => computeMacros({ ...base, goal: "shredded" }), /goal is missing or not one of/);
});

test("missingBodyMetrics: activity_level is satisfied by a reported level OR training days, never both required", () => {
  const complete = { sex: "male", age: 30, heightCm: 180, weightKg: 85 };
  assert.deepEqual(missingBodyMetrics({ ...complete, activity: "moderate" }), []);
  assert.deepEqual(missingBodyMetrics({ ...complete, daysPerWeek: 4 }), []);
  assert.deepEqual(missingBodyMetrics({ ...complete }), ["activity_level"]);
});

test("missingBodyMetrics: out-of-range or absent body facts are named, not guessed", () => {
  assert.deepEqual(missingBodyMetrics({}), ["sex", "weight_kg", "height_cm", "age", "activity_level"]);
  assert.ok(missingBodyMetrics({ sex: "male", age: 30, heightCm: 180, weightKg: 400, activity: "moderate" })
    .includes("weight_kg"));
});

test("PAR-Q: null (unanswered) is distinguished from false (answered no) — only true gates", () => {
  const unanswered = { parq_heart_condition: null, parq_chest_pain: null, parq_dizziness: null,
    parq_bone_joint: null, parq_bp_meds: null, parq_other_reason: null, pregnant: null,
    eating_disorder_history: null };
  assert.deepEqual(missingParq(unanswered), Object.keys(unanswered));
  assert.deepEqual(computeHealthFlags(unanswered), []);

  const answeredNo = Object.fromEntries(Object.keys(unanswered).map((k) => [k, false]));
  assert.deepEqual(missingParq(answeredNo), []);
  assert.deepEqual(computeHealthFlags(answeredNo), []);

  const oneTrue = { ...answeredNo, parq_chest_pain: true };
  assert.deepEqual(computeHealthFlags(oneTrue), ["parq_chest_pain"]);
});

test("fat% floor: a request below 15% is clamped to the floor and flagged, never silently honored", () => {
  const input = {
    sex: "male", age: 30, heightCm: 180, weightKg: 85, activity: "moderate",
    goal: "maintain", clientClass: "lifestyle", fatPct: 8,
  };
  const got = computeMacros(input);
  assert.equal(got.fat_pct, FAT_PCT_FLOOR);
  assert.ok(got.flags.some((f) => f.includes("below the 15% floor")));
});

test("protein basis switches to LBM-based dosing only when bodyFatPct is supplied", () => {
  const base = {
    sex: "male", age: 30, heightCm: 180, weightKg: 90, activity: "moderate",
    goal: "fat_loss", weeklyLossLb: 1.5, clientClass: "lifestyle",
  };
  const noBf = computeMacros(base);
  assert.match(noBf.protein_basis, /CURRENT weight/);

  const withBf = computeMacros({ ...base, bodyFatPct: 18 });
  assert.match(withBf.protein_basis, /lean body mass/);
});

test("refuse_to_coach fires at or above the 4 lb/wk line, not before", () => {
  const base = {
    sex: "male", age: 30, heightCm: 180, weightKg: 90, activity: "moderate",
    goal: "fat_loss", clientClass: "lifestyle",
  };
  assert.equal(computeMacros({ ...base, weeklyLossLb: 3.9 }).refuse_to_coach, false);
  assert.equal(computeMacros({ ...base, weeklyLossLb: 4.0 }).refuse_to_coach, true);
});

test("protein floor is 1.6 g/kg of entered weight, rounded, and null (never a default) without a weight", async () => {
  const { PROTEIN_FLOOR_PER_KG, proteinFloorG } = await import("./mealMacros.js");
  assert.equal(PROTEIN_FLOOR_PER_KG, 1.6);
  assert.equal(proteinFloorG(97.522), 156);
  assert.equal(proteinFloorG(62), 99);
  assert.equal(proteinFloorG(null), null);
  assert.equal(proteinFloorG(0), null);
  assert.equal(proteinFloorG("nope"), null);
});
