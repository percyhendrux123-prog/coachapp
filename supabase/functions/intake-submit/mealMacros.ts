// Shared macro/health-gate core — byte-for-byte-equivalent Deno twin of
// src/lib/mealMacros.js. Edge functions run in a separate bundler and can't import
// from src/lib directly, so the two are kept in sync by hand; mealMacros.test.js's
// parity test (in the frontend repo) catches drift between them. If you change one,
// change the other the same way.
//
// This module reconciles two generators that had quietly diverged (2026-08-24 audit):
// mealGen.js had richer macro math (LBM-aware protein, coach-settable fat%) but no
// safety gates; intake-submit/generate.ts had the PAR-Q health gate and goal
// validation but simpler, less capable macro math. Nothing here is a downgrade from
// either — the merge keeps the richer math AND the safety gates.

export type MacroInputs = {
  sex?: string;
  age?: number;
  heightCm?: number;
  weightKg?: number;
  activity?: string;        // sedentary|light|moderate|active|very_active — self-reported, primary
  daysPerWeek?: number;     // fallback activity-factor source, intake-only
  goal?: string;             // fat_loss | muscle_gain | recomp | maintain — invalid/missing throws
  weeklyLossLb?: number;
  clientClass?: string;      // lifestyle | competitor
  calorieOverride?: number;
  goalWeightKg?: number;
  bodyFatPct?: number;
  proteinPerKgLbm?: number;
  fatPct?: number;
};

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }
function round(n: number, step: number) { return Math.round(n / step) * step; }

export const ACTIVITY_FACTOR: Record<string, number> = {
  sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9,
};

const DAYS_ACTIVITY_FACTOR: Record<number, number> = { 3: 1.375, 4: 1.45, 5: 1.55, 6: 1.65 };
const DAYS_ACTIVITY_DEFAULT = 1.45;

export const WEEKLY_LOSS_BANDS: Record<string, { min: number; max: number; default: number }> = {
  lifestyle: { min: 0.5, max: 3.0, default: 1.0 },
  competitor: { min: 1.0, max: 4.0, default: 1.5 },
};
export const REFUSE_COACH_WEEKLY_LB = 4.0;
const KCAL_PER_LB = 3500;

export const PROTEIN_PER_KG_LBM_RANGE = { min: 2.3, max: 3.1, default: 2.6 };
export const FAT_PCT_FLOOR = 15;
export const FAT_PCT_DEFAULT = 20;
export const CALORIE_FLOOR_BY_SEX = { female: 1300, male: 1600 } as const;
// Protein floor for buyer-set targets (SYSTEM owner tools). 1.6 g/kg of CURRENT body weight:
// the Morton 2018 meta-regression breakpoint (49 RCTs, n=1863) below which resistance-trained
// adults measurably lose lean mass gains; also the lowest dose this generator ever prescribes
// (2.0 g/kg lifestyle maintain). Computed from the weight the buyer entered — never a fixed
// gram number, never invented when weight is unknown (callers refuse instead).
export const PROTEIN_FLOOR_PER_KG = 1.6;
export const proteinFloorG = (weightKg: unknown): number | null => {
  const kg = Number(weightKg);
  return Number.isFinite(kg) && kg > 0 ? Math.round(PROTEIN_FLOOR_PER_KG * kg) : null;
};
const COMPETITOR_WEEKLY_PCT_BW_BAND = { min: 0.5, max: 1.0 };

export function missingBodyMetrics(
  { sex, age, heightCm, weightKg, activity, daysPerWeek }:
  { sex?: string; age?: number; heightCm?: number; weightKg?: number; activity?: string; daysPerWeek?: number },
): string[] {
  const missing: string[] = [];
  const n = (v: unknown) => (v === null || v === undefined || v === ("" as unknown)) ? NaN : Number(v);
  const s = String(sex ?? "").toLowerCase();
  if (s !== "male" && s !== "female") missing.push("sex");
  const kg = n(weightKg);
  if (!Number.isFinite(kg) || kg < 35 || kg > 250) missing.push("weight_kg");
  const cm = n(heightCm);
  if (!Number.isFinite(cm) || cm < 120 || cm > 230) missing.push("height_cm");
  const yrs = n(age);
  if (!Number.isFinite(yrs) || yrs < 14 || yrs > 90) missing.push("age");
  const hasActivity = activity != null && Object.prototype.hasOwnProperty.call(ACTIVITY_FACTOR, activity);
  const hasDays = Number.isFinite(n(daysPerWeek));
  if (!hasActivity && !hasDays) missing.push("activity_level");
  return missing;
}

// ---------- Health screen (hard gate) ----------
const PARQ_FIELDS = [
  "parq_heart_condition", "parq_chest_pain", "parq_dizziness", "parq_bone_joint",
  "parq_bp_meds", "parq_other_reason", "pregnant", "eating_disorder_history",
] as const;

export function missingParq(i: Record<string, unknown>): string[] {
  return PARQ_FIELDS.filter((f) => (i as any)[f] == null);
}

export function computeHealthFlags(i: Record<string, unknown>): string[] {
  const f: string[] = [];
  if (i.parq_heart_condition) f.push("parq_heart_condition");
  if (i.parq_chest_pain) f.push("parq_chest_pain");
  if (i.parq_dizziness) f.push("parq_dizziness");
  if (i.parq_bone_joint) f.push("parq_bone_joint_worsened_by_activity");
  if (i.parq_bp_meds) f.push("parq_bp_or_heart_medication");
  if (i.parq_other_reason) f.push("parq_other_reason_not_to_exercise");
  if (i.pregnant) f.push("pregnancy");
  if (i.eating_disorder_history) f.push("eating_disorder_history");
  if (i.medications && String(i.medications).trim().length > 0) f.push("medication_disclosed");
  return f;
}

export function computeMacros({
  sex, age, heightCm, weightKg, activity, daysPerWeek, goal, weeklyLossLb, clientClass,
  calorieOverride, goalWeightKg, bodyFatPct, proteinPerKgLbm, fatPct,
}: MacroInputs) {
  const missing = missingBodyMetrics({ sex, age, heightCm, weightKg, activity, daysPerWeek });
  if (missing.length > 0) {
    throw new Error(
      `Missing body metrics: ${missing.join(", ")}. Current sex, age, height, weight, and an ` +
      `activity signal (self-reported level, or training days/week) are required — goal weight is never required.`,
    );
  }

  const goalRaw = String(goal ?? "").toLowerCase();
  const GOAL_OK = new Set(["fat_loss", "muscle_gain", "recomp", "maintain"]);
  if (!GOAL_OK.has(goalRaw)) {
    throw new Error(
      `computeMacros: refusing to compute. goal is missing or not one of fat_loss|muscle_gain|recomp|maintain (got "${goal ?? ""}").`,
    );
  }
  const goalKey = goalRaw;

  const s = String(sex).toLowerCase();
  const kg = Number(weightKg);
  const cm = Number(heightCm);
  const yrs = Number(age);
  const klass = clientClass === "competitor" ? "competitor" : "lifestyle";
  const band = WEEKLY_LOSS_BANDS[klass];
  const flags: string[] = [];

  const bmr = 10 * kg + 6.25 * cm - 5 * yrs + (s === "female" ? -161 : 5);

  let af: number, activitySource: string;
  if (activity != null && Object.prototype.hasOwnProperty.call(ACTIVITY_FACTOR, activity)) {
    af = ACTIVITY_FACTOR[activity];
    activitySource = "reported";
  } else {
    const days = clamp(Number(daysPerWeek) || 4, 3, 6);
    af = DAYS_ACTIVITY_FACTOR[days] || DAYS_ACTIVITY_DEFAULT;
    activitySource = "days_derived";
    flags.push(`No self-reported activity level — activity factor derived from ${days} training days/week instead.`);
  }
  const tdee = bmr * af;

  let weekly = Number(weeklyLossLb);
  if (!Number.isFinite(weekly) || weekly <= 0) {
    if (goalKey === "fat_loss") {
      weekly = band.default;
      flags.push(`weekly_loss_lb not set — used ${klass} default ${band.default} lb/wk. Coach should set the real rate.`);
    } else {
      weekly = 0;
    }
  }

  if (goalKey === "fat_loss" || weekly > 0) {
    if (weekly < band.min) {
      flags.push(`Weekly rate ${weekly} lb is below the ${klass} band (${band.min}–${band.max}). Still computing.`);
    }
    if (weekly > band.max && weekly < REFUSE_COACH_WEEKLY_LB) {
      flags.push(`Weekly rate ${weekly} lb is above the usual ${klass} band (${band.min}–${band.max}). Still computing.`);
    }
    if (weekly >= REFUSE_COACH_WEEKLY_LB) {
      flags.push(
        `REFUSE_TO_COACH: ${weekly} lb/wk is at or above ${REFUSE_COACH_WEEKLY_LB} lb/wk. ` +
        `The coach must review and decide whether to proceed. Numbers below show the challenge only.`,
      );
    }
  }

  const weightLb = kg / 0.45359237;
  const weeklyLossPctBw = weightLb > 0 ? round((weekly / weightLb) * 100, 0.1) : 0;
  if (klass === "competitor" && weekly > 0 &&
    (weeklyLossPctBw < COMPETITOR_WEEKLY_PCT_BW_BAND.min || weeklyLossPctBw > COMPETITOR_WEEKLY_PCT_BW_BAND.max)) {
    flags.push(
      `${weeklyLossPctBw}% bodyweight/week is outside the evidence-based competitor band ` +
      `(${COMPETITOR_WEEKLY_PCT_BW_BAND.min}–${COMPETITOR_WEEKLY_PCT_BW_BAND.max}%/wk). Still computing.`,
    );
  }

  let calories: number;
  if (Number(calorieOverride) > 0) {
    calories = Number(calorieOverride);
  } else if (goalKey === "fat_loss" || weekly > 0) {
    const dailyDeficit = (weekly * KCAL_PER_LB) / 7;
    calories = tdee - dailyDeficit;
  } else if (goalKey === "muscle_gain") {
    calories = tdee * 1.1;
  } else if (goalKey === "maintain") {
    calories = tdee;
  } else {
    calories = tdee * 0.95;
  }

  const floor = CALORIE_FLOOR_BY_SEX[s === "female" ? "female" : "male"];
  if (calories < floor) {
    flags.push(`Hit calorie floor ${floor} — requested weekly rate would go lower; floor wins.`);
  }
  calories = clamp(calories, floor, tdee * 1.25);

  const bf = Number(bodyFatPct);
  const hasBf = Number.isFinite(bf) && bf > 0 && bf < 60;
  let protein_g: number;
  let proteinBasisNote: string;
  if (hasBf) {
    const lbmKg = kg * (1 - bf / 100);
    const perKgLbm = clamp(
      Number.isFinite(Number(proteinPerKgLbm)) ? Number(proteinPerKgLbm) : PROTEIN_PER_KG_LBM_RANGE.default,
      PROTEIN_PER_KG_LBM_RANGE.min, PROTEIN_PER_KG_LBM_RANGE.max,
    );
    protein_g = perKgLbm * lbmKg;
    proteinBasisNote = `${perKgLbm} g/kg lean body mass (${round(lbmKg, 0.1)} kg LBM from ${bf}% body fat). ` +
      `Goal weight never blocks and is not the protein base.`;
  } else {
    const proteinPerKg = klass === "competitor" && (goalKey === "fat_loss" || weekly > 0)
      ? 2.4
      : (goalKey === "fat_loss" || weekly > 0 ? 2.2 : 2.0);
    protein_g = proteinPerKg * kg;
    proteinBasisNote = `${proteinPerKg} g/kg CURRENT weight (${kg} kg) — no body-fat estimate given, so LBM-based ` +
      `dosing wasn't used. Add one to switch to lean-mass protein.`;
  }

  const requestedFatPct = Number.isFinite(Number(fatPct)) ? Number(fatPct) : FAT_PCT_DEFAULT;
  if (requestedFatPct < FAT_PCT_FLOOR) {
    flags.push(`Fat % requested (${requestedFatPct}%) is below the ${FAT_PCT_FLOOR}% floor — using ${FAT_PCT_FLOOR}%.`);
  }
  const effectiveFatPct = Math.max(requestedFatPct, FAT_PCT_FLOOR);
  let fat_g = Math.max((calories * (effectiveFatPct / 100)) / 9, 0.5 * kg);
  let carb_g = Math.max((calories - protein_g * 4 - fat_g * 9) / 4, 0);

  protein_g = round(protein_g, 5);
  fat_g = round(fat_g, 5);
  carb_g = round(carb_g, 5);
  calories = round(protein_g * 4 + fat_g * 9 + carb_g * 4, 10);

  const gw = Number(goalWeightKg);
  const goalNote = Number.isFinite(gw) && gw >= 35 && gw <= 250
    ? ` Coach stage/goal target on file: ${gw} kg (not used in this calculation).`
    : "";

  return {
    calories,
    protein_g,
    fat_g,
    carb_g,
    tdee: round(tdee, 10),
    bmr: round(bmr, 10),
    activity_factor: af,
    activity_source: activitySource,
    weekly_loss_lb: weekly,
    weekly_loss_pct_bw: weeklyLossPctBw,
    client_class: klass,
    protein_basis: `${proteinBasisNote}${goalNote}`,
    fat_pct: effectiveFatPct,
    flags,
    refuse_to_coach: weekly >= REFUSE_COACH_WEEKLY_LB,
  };
}
