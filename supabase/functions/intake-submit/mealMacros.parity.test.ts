// Parity test between src/lib/mealMacros.js and its hand-maintained Deno twin,
// mealMacros.ts. There's no automated sync between the two — this is the only thing
// that catches drift when one changes without the other. Run with:
//   deno test --no-check --allow-read supabase/functions/intake-submit/mealMacros.parity.test.ts
// --no-check is required: mealMacros.js's JSDoc gives its params narrower literal
// types than mealMacros.ts's MacroInputs, and Deno's checker enforces both at once
// against these test inputs. This is a runtime-output parity check, not a type check.

// @ts-nocheck
import { computeMacros as jsComputeMacros, missingBodyMetrics as jsMissingBodyMetrics }
  from "../../../src/lib/mealMacros.js";
import { computeMacros as tsComputeMacros, missingBodyMetrics as tsMissingBodyMetrics }
  from "./mealMacros.ts";

function assertDeepEqual(a: unknown, b: unknown, label: string) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) {
    throw new Error(`${label}: JS and TS twins disagree.\n  JS: ${sa}\n  TS: ${sb}`);
  }
}

const CASES: Record<string, Record<string, unknown>> = {
  maleLifestyleFatLoss: {
    sex: "male", age: 34, heightCm: 180, weightKg: 95, activity: "moderate",
    goal: "fat_loss", weeklyLossLb: 1.5, clientClass: "lifestyle",
  },
  femaleCompetitorFatLossWithBf: {
    sex: "female", age: 28, heightCm: 165, weightKg: 62, activity: "active",
    goal: "fat_loss", weeklyLossLb: 1.0, clientClass: "competitor",
    bodyFatPct: 22, proteinPerKgLbm: 2.8, fatPct: 18,
  },
  maleMuscleGainNoActivity_daysDerived: {
    sex: "male", age: 25, heightCm: 178, weightKg: 78, daysPerWeek: 5,
    goal: "muscle_gain", clientClass: "lifestyle",
  },
  femaleMaintainLowFatRequest: {
    sex: "female", age: 40, heightCm: 168, weightKg: 70, activity: "sedentary",
    goal: "maintain", clientClass: "lifestyle", fatPct: 8,
  },
  competitorRefuseToCoach: {
    sex: "male", age: 30, heightCm: 180, weightKg: 90, activity: "active",
    goal: "fat_loss", weeklyLossLb: 4.5, clientClass: "competitor",
  },
};

Deno.test("mealMacros.js and mealMacros.ts produce identical computeMacros output for every case", () => {
  for (const [name, input] of Object.entries(CASES)) {
    assertDeepEqual(jsComputeMacros(input), tsComputeMacros(input), name);
  }
});

Deno.test("mealMacros.js and mealMacros.ts agree on missingBodyMetrics for incomplete input", () => {
  const incomplete = [
    {},
    { sex: "male" },
    { sex: "female", age: 30, heightCm: 165, weightKg: 60 },
    { sex: "male", age: 30, heightCm: 180, weightKg: 90, daysPerWeek: 4 },
  ];
  for (const input of incomplete) {
    assertDeepEqual(
      jsMissingBodyMetrics(input),
      tsMissingBodyMetrics(input),
      `missingBodyMetrics(${JSON.stringify(input)})`,
    );
  }
});

Deno.test("mealMacros.js and mealMacros.ts throw the same way on an invalid goal", () => {
  const input = {
    sex: "male", age: 30, heightCm: 180, weightKg: 90, activity: "moderate",
    goal: "not_a_real_goal", clientClass: "lifestyle",
  };
  let jsThrew = false, tsThrew = false;
  try { jsComputeMacros(input); } catch { jsThrew = true; }
  try { tsComputeMacros(input); } catch { tsThrew = true; }
  if (!jsThrew || !tsThrew) {
    throw new Error(`Expected both twins to throw on invalid goal — jsThrew=${jsThrew} tsThrew=${tsThrew}`);
  }
});

Deno.test("twins agree on the protein floor (1.6 g/kg, rounded grams, null without weight)", async () => {
  const js = await import("../../../src/lib/mealMacros.js");
  const ts = await import("./mealMacros.ts");
  assertDeepEqual(js.PROTEIN_FLOOR_PER_KG, ts.PROTEIN_FLOOR_PER_KG, "PROTEIN_FLOOR_PER_KG");
  for (const w of [97.522, 62, 0, null, undefined, "abc"]) {
    assertDeepEqual(js.proteinFloorG(w), ts.proteinFloorG(w), `proteinFloorG(${String(w)})`);
  }
  assertDeepEqual(ts.proteinFloorG(97.522), 156, "97.5 kg → 156 g");
  assertDeepEqual(ts.proteinFloorG(null), null, "no weight → no floor, never a default");
});
