// Run: deno test --allow-read supabase/functions/intake-submit/conservative.test.ts
import { CONSERVATIVE, CONSERVATIVE_RATIONALE, conservativeProfile, generateConservativePlan, generatePlan } from "./generate.ts";

const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
const NO = { parq_heart_condition: false, parq_chest_pain: false, parq_dizziness: false, parq_bone_joint: false,
  parq_bp_meds: false, parq_other_reason: false, pregnant: false, eating_disorder_history: false };
const person = { goal: "fat_loss", sex: "female", age: 41, height_cm: 165, weight_kg: 82, experience: "intermediate",
  days_per_week: 5, equipment: "full_gym", injuries: ["none"], ...NO };

Deno.test("normal profile unchanged: golden values from the generator on 172cfb9", () => {
  const p: any = generatePlan(person as any);
  eq({ calories: p.macros.calories, protein_g: p.macros.protein_g, fat_g: p.macros.fat_g, carb_g: p.macros.carb_g, weekly: p.macros.weekly_loss_lb },
     { calories: 1800, protein_g: 180, fat_g: 40, carb_g: 180, weekly: 1 }, "macros");
  eq(p.frequency, { training_days: 5, rest_days: 2 }, "frequency");
  eq(p.training.days[0].groups[0].exercises[0].sets[0].target_reps, "6-8", "intermediate compound reps");
});
Deno.test("a flagged screen still holds in generatePlan (no path around the gate)", () => {
  const p: any = generatePlan({ ...person, parq_chest_pain: true } as any);
  eq(p.held, true, "held"); eq(p.training.days.length, 0, "no days");
});
Deno.test("conservative profile: beginner, at most 4 days, the smallest deficit", () => {
  const prof = conservativeProfile(person as any);
  eq([prof.experience, prof.days_per_week, prof.weekly_loss_lb, prof.client_class], ["beginner", 4, 0.5, "lifestyle"], "knobs");
  eq(conservativeProfile({ ...person, days_per_week: 3 } as any).days_per_week, 3, "3 stays 3");
  eq(conservativeProfile({ ...person, goal: "muscle_gain", weekly_loss_lb: 2 } as any).weekly_loss_lb, undefined, "no deficit outside fat loss");
  eq(CONSERVATIVE.fat_loss_weekly_lb, 0.5, "0.5 lb/wk");
});
Deno.test("conservative plan after a confirmed doctor-first screen", () => {
  const p: any = generateConservativePlan({ ...person, parq_chest_pain: true } as any, ["parq_chest_pain"]);
  eq(p.held, false, "built");
  eq(p.conservative, true, "marked");
  eq(p.frequency.training_days <= 4, true, "<=4 days");
  eq(p.macros.weekly_loss_lb, 0.5, "smallest deficit");
  eq(p.training.days.find((d: any) => d.kind === "training").groups[0].exercises[0].sets[0].target_reps, "8-10", "beginner reps");
  eq(p.rationale.startsWith(CONSERVATIVE_RATIONALE), true, "rationale line first");
  eq(p.health_flags, ["parq_chest_pain"], "flags kept on the record");
});
Deno.test("conservative plan refuses blocking, mismatched or empty flags", () => {
  const bad = [
    [{ ...person, pregnant: true }, ["pregnancy"]],
    [{ ...person, parq_chest_pain: true, eating_disorder_history: true }, ["parq_chest_pain", "eating_disorder_history"]],
    [{ ...person, parq_chest_pain: true }, ["parq_dizziness"]],
    [{ ...person, parq_chest_pain: true, parq_dizziness: true }, ["parq_chest_pain"]],
    [person, []],
  ];
  for (const [i, f] of bad) {
    let threw = false;
    try { generateConservativePlan(i as any, f as string[]); } catch { threw = true; }
    if (!threw) throw new Error("built when it must refuse: " + JSON.stringify(f));
  }
});

Deno.test("a pre-P33 screen with 'none' typed in medications (stored as medication_disclosed) still builds", () => {
  const legacy = { ...person, parq_chest_pain: true, medications: "none" };
  const p: any = generateConservativePlan(legacy as any, ["parq_chest_pain", "medication_disclosed"]);
  eq(p.held, false, "built");
  eq(p.health_flags, ["parq_chest_pain", "medication_disclosed"], "the record keeps what was confirmed");
  const onlyMeds: any = generateConservativePlan({ ...person, medications: "N/A" } as any, ["medication_disclosed"]);
  eq(onlyMeds.conservative, true, "medication-only legacy screen builds conservative");
});
Deno.test("a confirmed flag the answers no longer raise is refused unless it is the legacy 'none'", () => {
  let threw = false;
  try { generateConservativePlan({ ...person } as any, ["parq_chest_pain"]); } catch { threw = true; }
  eq(threw, true, "chest pain confirmed but answers say no: refused");
  threw = false;
  try { generateConservativePlan({ ...person } as any, ["medication_disclosed"]); } catch { threw = true; }
  eq(threw, true, "medication confirmed but nothing typed: refused");
});
