// Wave 2 #3 — Deterministic meal-plan generator (no hosted model).
//
// Doctrine (2026-08-10): calories from CURRENT metrics + coach-set WEEKLY LOSS RATE.
// Goal weight is never required and never blocks generation — the client earns that
// number through work; the coach may store it as a target but macros do not wait on it.
// Protein is always off CURRENT weight (higher on deficit / competitor peel).
//
// Macro math and the missing-metrics gate live in ./mealMacros.js (merged 2026-08-24
// with intake-submit/generate.ts's safety gates) — this file re-exports them so
// existing callers (CoachClients.jsx) don't need to change their imports.

import {
  WEEKLY_LOSS_BANDS, REFUSE_COACH_WEEKLY_LB, PROTEIN_PER_KG_LBM_RANGE,
  FAT_PCT_FLOOR, FAT_PCT_DEFAULT, missingBodyMetrics, computeMacros,
} from "./mealMacros";

export { WEEKLY_LOSS_BANDS, REFUSE_COACH_WEEKLY_LB, PROTEIN_PER_KG_LBM_RANGE, FAT_PCT_FLOOR, FAT_PCT_DEFAULT, missingBodyMetrics, computeMacros };

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n, step) => Math.round(n / step) * step;

// Per-100g macros + diet/allergen tags. veg items are near-zero-cal fillers.
// diet flags: vegan implies vegetarian+pescatarian+omnivore ok, etc.
const FOOD_DB = [
  // proteins
  { food: "Chicken breast",     kind: "protein", p: 31, f: 3.6, c: 0,  veg: false, pesc: false, vegan: false, allergens: [] },
  { food: "Lean beef (90/10)",  kind: "protein", p: 26, f: 10,  c: 0,  veg: false, pesc: false, vegan: false, allergens: [] },
  { food: "Salmon",             kind: "protein", p: 20, f: 13,  c: 0,  veg: false, pesc: true,  vegan: false, allergens: ["fish"] },
  { food: "Whole eggs",         kind: "protein", p: 13, f: 11,  c: 1,  veg: true,  pesc: true,  vegan: false, allergens: ["egg"] },
  { food: "Nonfat Greek yogurt", kind: "protein", p: 10, f: 0.4, c: 4, veg: true,  pesc: true,  vegan: false, allergens: ["dairy"] },
  { food: "Firm tofu",          kind: "protein", p: 12, f: 7,   c: 2,  veg: true,  pesc: true,  vegan: true,  allergens: ["soy"] },
  { food: "Whey isolate",       kind: "protein", p: 90, f: 1,   c: 2,  veg: true,  pesc: true,  vegan: false, allergens: ["dairy"] },
  // carbs
  { food: "White rice (cooked)", kind: "carb", p: 2.7, f: 0.3, c: 28, veg: true, pesc: true, vegan: true, allergens: [] },
  { food: "Sweet potato",        kind: "carb", p: 1.6, f: 0.1, c: 20, veg: true, pesc: true, vegan: true, allergens: [] },
  { food: "Oats (dry)",          kind: "carb", p: 13,  f: 7,   c: 67, veg: true, pesc: true, vegan: true, allergens: ["gluten"] },
  { food: "Banana",              kind: "carb", p: 1.1, f: 0.3, c: 23, veg: true, pesc: true, vegan: true, allergens: [] },
  { food: "Whole-wheat bread",   kind: "carb", p: 9,   f: 3,   c: 49, veg: true, pesc: true, vegan: true, allergens: ["gluten"] },
  // fats
  { food: "Olive oil",     kind: "fat", p: 0,  f: 100, c: 0,  veg: true, pesc: true, vegan: true, allergens: [] },
  { food: "Almonds",       kind: "fat", p: 21, f: 49,  c: 22, veg: true, pesc: true, vegan: true, allergens: ["nut"] },
  { food: "Avocado",       kind: "fat", p: 2,  f: 15,  c: 9,  veg: true, pesc: true, vegan: true, allergens: [] },
  { food: "Peanut butter", kind: "fat", p: 25, f: 50,  c: 20, veg: true, pesc: true, vegan: true, allergens: ["nut"] },
  // veg
  { food: "Broccoli",    kind: "veg", p: 2.8, f: 0.4, c: 7,   veg: true, pesc: true, vegan: true, allergens: [] },
  { food: "Spinach",     kind: "veg", p: 2.9, f: 0.4, c: 3.6, veg: true, pesc: true, vegan: true, allergens: [] },
  { food: "Green beans", kind: "veg", p: 1.8, f: 0.1, c: 7,   veg: true, pesc: true, vegan: true, allergens: [] },
  { food: "Mixed greens", kind: "veg", p: 1.5, f: 0.2, c: 3,  veg: true, pesc: true, vegan: true, allergens: [] },
];

function dietOk(food, style) {
  switch ((style || "omnivore").toLowerCase()) {
    case "vegan": return food.vegan;
    case "vegetarian": return food.veg;
    case "pescatarian": return food.pesc;
    default: return true; // omnivore
  }
}

// Free-text allergies → excluded allergen keywords present in any food.
function allergenExcluded(food, allergies) {
  const a = (allergies || "").toLowerCase();
  if (!a.trim()) return false;
  return food.allergens.some((al) => a.includes(al) || (al === "nut" && a.includes("peanut")));
}

function pool(kind, style, allergies) {
  return FOOD_DB.filter((f) => f.kind === kind && dietOk(f, style) && !allergenExcluded(f, allergies));
}

const kcalOf = (p, f, c) => Math.round(p * 4 + c * 4 + f * 9);
const gramsFor = (targetMacro, per100) => (per100 <= 0 ? 0 : round((targetMacro / per100) * 100, 5));

// Build one item: `grams` of `food`, with its resulting macros + kcal.
function itemFromGrams(food, grams) {
  const s = grams / 100;
  const p = food.p * s, f = food.f * s, c = food.c * s;
  return { food: food.food, qty: `${grams} g`, grams, kcal: kcalOf(p, f, c), protein_g: Math.round(p), fat_g: Math.round(f), carb_g: Math.round(c) };
}

// Solve a 3x3 linear system (Cramer's rule) for the grams of a protein/carb/fat food
// that jointly hit a meal's (protein, carb, fat) targets — accounting for every food's
// full macro profile, so cross-contributions don't compound into overshoot. Returns
// per-100g multipliers [xP, xC, xF]; null if the system is degenerate.
function solve3(P, C, F, tp, tc, tf) {
  const A = [[P.p, C.p, F.p], [P.c, C.c, F.c], [P.f, C.f, F.f]];
  const det = (m) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(A);
  if (Math.abs(d) < 1e-6) return null;
  const col = (m, i, v) => m.map((row, r) => row.map((x, cc) => (cc === i ? v[r] : x)));
  const b = [tp, tc, tf];
  return [det(col(A, 0, b)) / d, det(col(A, 1, b)) / d, det(col(A, 2, b)) / d];
}

// Per-meal allocator: a fixed veg filler plus a protein/carb/fat trio solved to hit the
// meal's macro share. Foods rotate by meal index for variety. Deterministic.
export function buildMealPlan({ protein_g, fat_g, carb_g, mealsPerDay, dietaryStyle, allergies }) {
  const N = clamp(Number(mealsPerDay) || 4, 2, 6);
  const proteins = pool("protein", dietaryStyle, allergies);
  const carbs = pool("carb", dietaryStyle, allergies);
  const fats = pool("fat", dietaryStyle, allergies);
  const vegs = pool("veg", dietaryStyle, allergies);

  const VEG_G = 100;
  const meals = [];

  // Only proteins lean/dense enough to anchor a meal's protein target without their
  // fat blowing the budget (excludes e.g. eggs when the target is high). Leanest-first
  // fallback so there's always at least one.
  const pPer = protein_g / N, fPer = fat_g / N;
  const anchorPool = proteins.filter((f) => f.f * (pPer / f.p) <= fPer * 1.6);
  const anchors = anchorPool.length
    ? anchorPool
    : [...proteins].sort((a, b) => b.p / (b.f + 0.1) - a.p / (a.f + 0.1)).slice(0, 1);

  for (let m = 0; m < N; m++) {
    const items = [];
    // Fixed veg first; subtract its macros from this meal's targets.
    let tp = protein_g / N, tc = carb_g / N, tf = fat_g / N;
    if (vegs.length) {
      const v = vegs[m % vegs.length];
      const it = itemFromGrams(v, VEG_G);
      items.push(it); tp -= it.protein_g; tc -= it.carb_g; tf -= it.fat_g;
    }

    const P = anchors[m % (anchors.length || 1)];
    const C = carbs[m % (carbs.length || 1)];
    const F = fats[m % (fats.length || 1)];
    const sol = P && C && F ? solve3(P, C, F, tp, tc, tf) : null;

    if (sol) {
      const [xP, xC, xF] = sol;
      const push = (food, x) => {
        const grams = clamp(round(x * 100, 5), 0, 600);
        if (grams >= 10) items.push(itemFromGrams(food, grams));
      };
      push(P, xP); push(C, xC); push(F, xF);
    } else {
      // Degenerate/missing pool — fall back to hitting protein then carbs directly.
      if (P) { const it = itemFromGrams(P, gramsFor(tp, P.p)); items.push(it); tc -= it.carb_g; }
      if (C && tc > 3) items.push(itemFromGrams(C, gramsFor(tc, C.c)));
    }

    meals.push({
      name: N <= 3 ? ["Breakfast", "Lunch", "Dinner"][m] : `Meal ${m + 1}`,
      items,
      kcal: items.reduce((s, i) => s + i.kcal, 0),
      note: "",
    });
  }
  return meals;
}

// End-to-end: profile + options → a full editable plan object.
export function generateMealPlan({
  profile, goal, mealsPerDay, calorieOverride, dietaryStyle, allergies,
  weeklyLossLb, clientClass, bodyFatPct, proteinPerKgLbm, fatPct,
}) {
  const num = (v) => (v === "" || v == null ? undefined : Number(v));
  const macros = computeMacros({
    sex: profile?.sex,
    age: profile?.age,
    heightCm: profile?.height_cm,
    weightKg: profile?.weight_kg,
    activity: profile?.activity_level,
    goal,
    calorieOverride: num(calorieOverride),
    weeklyLossLb: num(weeklyLossLb),
    clientClass: clientClass || (profile?.client_type === "prep" ? "competitor" : "lifestyle"),
    goalWeightKg: profile?.goal_weight_kg, // optional target only
    bodyFatPct: num(bodyFatPct),
    proteinPerKgLbm: num(proteinPerKgLbm),
    fatPct: num(fatPct),
  });
  const meals = buildMealPlan({ ...macros, mealsPerDay, dietaryStyle, allergies });
  const flagLine = (macros.flags || []).length ? ` Flags: ${macros.flags.join(" · ")}` : "";
  return {
    title: `${(goal || "recomp").replace("_", " ")} plan`,
    calories: macros.calories,
    protein_g: macros.protein_g,
    fat_g: macros.fat_g,
    carb_g: macros.carb_g,
    meals,
    notes:
      `Generated · BMR ${macros.bmr} · TDEE ${macros.tdee} · weekly loss ${macros.weekly_loss_lb} lb (${macros.client_class}). ` +
      `${macros.protein_basis} Targets are a starting point — adjust off weekly average weight + photos.${flagLine}`,
    _meta: {
      weekly_loss_lb: macros.weekly_loss_lb,
      client_class: macros.client_class,
      refuse_to_coach: macros.refuse_to_coach,
      flags: macros.flags,
    },
  };
}
