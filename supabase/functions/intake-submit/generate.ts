// Coaching program generator — pure logic, no I/O.
// Grounded in Competition-Prep-Coaching-Philosophy.md (Helms/Aragon/Fitschen 2014)
// + shared coaching safety rules. Evidence-based, safe,
// injury-aware, conservative defaults. NO medical claims. Health-flag = hard gate.
//
// Macro math + the PAR-Q health gate live in ./mealMacros.ts (merged 2026-08-24 with
// the coach-side generator, src/lib/mealGen.js — that file's richer macro math now
// backs both, this file's safety gates are unchanged and unaffected).

import {
  missingBodyMetrics as sharedMissingBodyMetrics, computeMacros as sharedComputeMacros,
  missingParq, computeHealthFlags,
} from "./mealMacros.ts";

// Re-exported: intake-submit/index.ts imports missingParq from this file, not
// directly from mealMacros.ts.
export { missingParq };

export type Intake = {
  goal?: string;            // fat_loss | muscle_gain | recomp | maintain
  sex?: string;             // male | female
  age?: number;
  height_cm?: number;
  weight_kg?: number;
  goal_weight_kg?: number;  // optional coach target only — NEVER required, never blocks
  weekly_loss_lb?: number;  // coach: how much weight drop per week?
  client_class?: string;    // lifestyle | competitor
  experience?: string;      // beginner | intermediate | advanced
  days_per_week?: number;   // 3..6
  equipment?: string;       // full_gym | home_basic | bodyweight
  injuries?: string[];      // knee | shoulder | lower_back | elbow | wrist | none
  dietary_style?: string;   // omnivore | vegetarian | vegan | pescatarian | none
  allergies?: string;
  diet_notes?: string;
  // PAR-Q style health screen (booleans) + hard-gate fields
  parq_heart_condition?: boolean;
  parq_chest_pain?: boolean;
  parq_dizziness?: boolean;
  parq_bone_joint?: boolean;
  parq_bp_meds?: boolean;
  parq_other_reason?: boolean;
  pregnant?: boolean;
  eating_disorder_history?: boolean;
  medications?: string;     // free text; non-empty => flag (spec: medication is a hard gate)
};

const uuid = () => crypto.randomUUID();

// ---------- Nutrition (conservative, evidence-based) ----------
function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }

// Body facts required: sex, age, height, CURRENT weight. Goal weight is NEVER required.
// WHY: inventing 80 kg / 178 cm / age 30 for Cheryl Moye produced a stranger's plan.
// Goal weight as a blocker was also wrong — the client works TO a coach target; macros
// run off live weight + weekly rate of loss the coach sets.
export function missingBodyMetrics(i: Intake): string[] {
  return sharedMissingBodyMetrics({
    sex: i.sex, age: i.age, heightCm: i.height_cm, weightKg: i.weight_kg,
    daysPerWeek: i.days_per_week,
  });
}

// Thin wrapper over the shared macro core — maps this file's snake_case Intake shape
// onto the shared module's camelCase inputs, and back onto this file's field names
// (activity_factor, assumptions) so callers below don't need to change.
export function computeMacros(i: Intake) {
  const m = sharedComputeMacros({
    sex: i.sex, age: i.age, heightCm: i.height_cm, weightKg: i.weight_kg,
    daysPerWeek: i.days_per_week, goal: i.goal, weeklyLossLb: i.weekly_loss_lb,
    clientClass: i.client_class, goalWeightKg: i.goal_weight_kg,
  });
  return {
    calories: m.calories, protein_g: m.protein_g, fat_g: m.fat_g, carb_g: m.carb_g,
    tdee: m.tdee, bmr: m.bmr,
    activity_factor: m.activity_factor, assumptions: m.flags,
    weekly_loss_lb: m.weekly_loss_lb,
    client_class: m.client_class,
    protein_basis: m.protein_basis,
  };
}

// ---------- Training ----------
type Equip = "barbell" | "machine" | "cable" | "db" | "bodyweight" | "band";
type Cand = { name: string; equip: Equip; contra?: string[] };
type Slot = { role: "compound" | "secondary" | "isolation"; muscle: string; cands: Cand[] };

const AVAIL: Record<string, Equip[]> = {
  full_gym: ["barbell", "machine", "cable", "db", "bodyweight", "band"],
  home_basic: ["db", "bodyweight", "band"],
  bodyweight: ["bodyweight", "band"],
};

const S = {
  chestPress: (): Slot => ({ role: "compound", muscle: "chest", cands: [
    { name: "Incline Barbell Press", equip: "barbell", contra: ["shoulder"] },
    { name: "Incline DB Press (neutral grip)", equip: "db" },
    { name: "Machine Chest Press", equip: "machine" },
    { name: "Push-Up (feet elevated)", equip: "bodyweight" },
  ]}),
  chestIso: (): Slot => ({ role: "isolation", muscle: "chest", cands: [
    { name: "Cable Fly", equip: "cable" },
    { name: "DB Fly", equip: "db", contra: ["shoulder"] },
    { name: "Band Fly", equip: "band" },
    { name: "Push-Up", equip: "bodyweight" },
  ]}),
  shoulderPress: (): Slot => ({ role: "secondary", muscle: "shoulders", cands: [
    { name: "Seated DB Shoulder Press (neutral)", equip: "db" },
    { name: "Landmine Press", equip: "barbell" },
    { name: "Machine Shoulder Press", equip: "machine" },
    { name: "Barbell Overhead Press", equip: "barbell", contra: ["shoulder", "lower_back"] },
    { name: "Band Overhead Press", equip: "band" },
  ]}),
  triceps: (): Slot => ({ role: "isolation", muscle: "triceps", cands: [
    { name: "Rope Triceps Pushdown", equip: "cable" },
    { name: "DB Overhead Extension", equip: "db", contra: ["elbow"] },
    { name: "Band Pushdown", equip: "band" },
    { name: "Bench Dip", equip: "bodyweight", contra: ["shoulder"] },
  ]}),
  vPull: (): Slot => ({ role: "compound", muscle: "back", cands: [
    { name: "Lat Pulldown", equip: "cable" },
    { name: "Assisted Pull-Up", equip: "machine" },
    { name: "Band Lat Pulldown", equip: "band" },
    { name: "Pull-Up", equip: "bodyweight" },
  ]}),
  hRow: (): Slot => ({ role: "secondary", muscle: "back", cands: [
    { name: "Chest-Supported Row", equip: "machine" },
    { name: "Seated Cable Row", equip: "cable" },
    { name: "Single-Arm DB Row (supported)", equip: "db" },
    { name: "Barbell Bent-Over Row", equip: "barbell", contra: ["lower_back"] },
    { name: "Band Row", equip: "band" },
  ]}),
  rearDelt: (): Slot => ({ role: "isolation", muscle: "rear delts", cands: [
    { name: "Reverse Pec-Deck", equip: "machine" },
    { name: "Cable Face Pull", equip: "cable" },
    { name: "DB Rear Delt Fly", equip: "db" },
    { name: "Band Face Pull", equip: "band" },
  ]}),
  biceps: (): Slot => ({ role: "isolation", muscle: "biceps", cands: [
    { name: "DB Curl (neutral/hammer)", equip: "db", contra: ["wrist"] },
    { name: "Cable Curl (EZ)", equip: "cable", contra: ["elbow"] },
    { name: "Band Curl", equip: "band" },
  ]}),
  squat: (): Slot => ({ role: "compound", muscle: "quads", cands: [
    { name: "Leg Press (controlled ROM)", equip: "machine", contra: [] },
    { name: "Goblet Box Squat", equip: "db", contra: [] },
    { name: "Back Squat", equip: "barbell", contra: ["knee", "lower_back"] },
    { name: "Bodyweight Box Squat", equip: "bodyweight" },
  ]}),
  hinge: (): Slot => ({ role: "compound", muscle: "hamstrings/glutes", cands: [
    { name: "Machine Hip Hinge / Back Extension", equip: "machine", contra: [] },
    { name: "DB Romanian Deadlift", equip: "db", contra: ["lower_back"] },
    { name: "Romanian Deadlift (barbell)", equip: "barbell", contra: ["lower_back"] },
    { name: "Glute Bridge", equip: "bodyweight" },
  ]}),
  quadIso: (): Slot => ({ role: "isolation", muscle: "quads", cands: [
    { name: "Leg Extension", equip: "machine", contra: [] },
    { name: "DB Step-Up (low box)", equip: "db", contra: ["knee"] },
    { name: "Wall Sit", equip: "bodyweight", contra: [] },
  ]}),
  hamCalf: (): Slot => ({ role: "isolation", muscle: "hamstrings/calves", cands: [
    { name: "Seated Leg Curl", equip: "machine" },
    { name: "DB Calf Raise", equip: "db" },
    { name: "Band Leg Curl", equip: "band" },
    { name: "Bodyweight Calf Raise", equip: "bodyweight" },
  ]}),
  core: (): Slot => ({ role: "isolation", muscle: "core", cands: [
    { name: "Cable Crunch", equip: "cable", contra: ["lower_back"] },
    { name: "Dead Bug", equip: "bodyweight" },
    { name: "Plank", equip: "bodyweight" },
  ]}),
};

function pick(slot: Slot, equip: string, injuries: string[]): Cand | null {
  const avail = AVAIL[equip] || AVAIL.full_gym;
  for (const c of slot.cands) {
    if (!avail.includes(c.equip)) continue;
    if ((c.contra || []).some((x) => injuries.includes(x))) continue;
    return c;
  }
  for (const c of slot.cands) {
    if (c.equip === "bodyweight" && !(c.contra || []).some((x) => injuries.includes(x))) return c;
  }
  return null;
}

function repScheme(role: string, exp: string) {
  const sets = exp === "advanced" ? 4 : 3;
  const reps = role === "compound" ? (exp === "beginner" ? "8-10" : "6-8")
    : role === "secondary" ? "8-12" : "12-15";
  return { sets, reps };
}

function buildDay(label: string, slots: Slot[], i: Intake, injuries: string[], subs: string[]) {
  const exp = (i.experience || "beginner").toLowerCase();
  const exercises: any[] = [];
  for (const slot of slots) {
    const c = pick(slot, i.equipment || "full_gym", injuries);
    if (!c) { subs.push(`${label}: no safe option for ${slot.muscle} — slot removed (injury/equipment)`); continue; }
    const { sets, reps } = repScheme(slot.role, exp);
    const setArr = Array.from({ length: sets }, (_, k) => ({
      set_index: k, target_reps: reps, target_weight: null,
      notes: k === sets - 1 ? "Leave 1-2 reps in reserve (RIR)." : null,
    }));
    if (slot.cands[0] && c.name !== slot.cands[0].name && (slot.cands[0].contra || []).some((x) => injuries.includes(x))) {
      subs.push(`${label}: ${slot.cands[0].name} → ${c.name} (injury-aware substitution)`);
    }
    exercises.push({ name: c.name, sets: setArr, exercise_id: uuid(), demo_media_url: null });
  }
  return { kind: "training", label, day_id: uuid(), groups: [{ type: "straight", group_id: uuid(), exercises }] };
}

function buildRestDay(label = "Rest") {
  return { kind: "rest", label, day_id: uuid(), groups: [] };
}

// Training days only. Rest is added by expandToWeek — never emit a zero-rest plan.
function trainingDaysForFreq(freq: number) {
  const P = () => [S.chestPress(), S.shoulderPress(), S.chestIso(), S.triceps()];
  const L = () => [S.squat(), S.hinge(), S.quadIso(), S.hamCalf(), S.core()];
  const U = () => [S.chestPress(), S.hRow(), S.shoulderPress(), S.vPull(), S.biceps(), S.triceps()];
  const PULL = () => [S.vPull(), S.hRow(), S.rearDelt(), S.biceps()];
  const FULL_A = () => [S.squat(), S.chestPress(), S.hRow(), S.core()];
  const FULL_B = () => [S.hinge(), S.shoulderPress(), S.vPull(), S.hamCalf()];
  const FULL_C = () => [S.squat(), S.chestIso(), S.rearDelt(), S.biceps(), S.triceps()];
  switch (freq) {
    case 3: return [["Full Body A", FULL_A()], ["Full Body B", FULL_B()], ["Full Body C", FULL_C()]];
    case 5: return [["Push", P()], ["Pull", PULL()], ["Legs", L()], ["Upper", U()], ["Lower", L()]];
    case 6: return [["Push A", P()], ["Pull A", PULL()], ["Legs A", L()], ["Push B", P()], ["Pull B", PULL()], ["Legs B", L()]];
    case 4:
    default: return [["Upper A", U()], ["Lower A", L()], ["Upper B", U()], ["Lower B", L()]];
  }
}

/**
 * Expand into a 7-day week with explicit rest days.
 * 3d: T R T R T R R · 4d: T R T R T R T · 5d: T T R T T R T · 6d: T T T R T T T
 */
function expandToWeek(training: Array<[string, any[]]>, i: Intake, injuries: string[], subs: string[]) {
  const built = training.map(([label, slots]) => buildDay(label, slots, i, injuries, subs));
  const n = built.length;
  const R = () => buildRestDay("Rest");
  if (n === 3) return [built[0], R(), built[1], R(), built[2], R(), R()];
  if (n === 4) return [built[0], R(), built[1], R(), built[2], R(), built[3]];
  if (n === 5) return [built[0], built[1], R(), built[2], built[3], R(), built[4]];
  if (n === 6) return [built[0], built[1], built[2], R(), built[3], built[4], built[5]];
  const out: any[] = [];
  for (const d of built) {
    out.push(d);
    if (out.length < 7) out.push(R());
  }
  while (out.length < 7) out.push(R());
  return out.slice(0, 7);
}

/** Cap claimed availability — "all 7 days available" is not a prescription. */
function resolveTrainingFrequency(i: Intake): { freq: number; note: string } {
  const claimed = clamp(Number(i.days_per_week) || 4, 1, 7);
  let freq = clamp(claimed, 3, 6);
  let note = `Training frequency set to ${freq} lifting days / week (${7 - freq} rest day(s) in the week structure).`;
  if (claimed >= 7) {
    freq = 5;
    note = "Client marked 7 days available — capped at 5 lifting + 2 rest. Availability is not recovery capacity.";
  }
  return { freq, note };
}

export function generatePlan(i: Intake) {
  const health_flags = computeHealthFlags(i);
  const held = health_flags.length > 0;

  if (held) {
    return {
      held: true,
      health_flags,
      training: { days: [] },
      meal_plan: {
        held_for_medical_review: true,
        disclaimer:
          "A health-screen flag was raised. The agent does not auto-generate a plan when a medical flag is present. The coach must review and decide whether to onboard, modify, or refer out. This is fitness coaching, not medical advice.",
      },
      macros: {},
      rationale:
        "HELD FOR HUMAN REVIEW — health-screen flag(s): " + health_flags.join(", ") +
        ". No automated training/nutrition prescription generated. Routed to the coach for a human decision.",
    };
  }

  // Body metrics gate. Same shape as the health-flag hold above: a structured
  // refusal naming exactly what is missing, not an exception and not a guess.
  // This mirrors Gate D in assemble_client_meal_plan() so the two paths cannot
  // disagree about whether a plan is safe to compute.
  const missing = missingBodyMetrics(i);
  if (missing.length > 0) {
    return {
      held: true,
      health_flags,
      blocked_reason: "missing_body_metrics",
      missing_body_metrics: missing,
      training: { days: [] },
      meal_plan: {
        held_for_missing_metrics: true,
        disclaimer:
          "No calorie or macro target was produced. These body metrics are missing or out of range: " +
          missing.join(", ") +
          ". They are facts about this specific person. Supply them and re-run — nothing here is defaulted.",
      },
      macros: {},
      rationale:
        "NOT GENERATED — missing body metrics: " + missing.join(", ") +
        ". A target computed without these would be arithmetic on a stranger's body wearing this client's name.",
    };
  }

  const injuries = (i.injuries || []).filter((x) => x && x !== "none");
  const subs: string[] = [];
  const { freq, note: freqNote } = resolveTrainingFrequency(i);
  const split = trainingDaysForFreq(freq);
  const days = expandToWeek(split, i, injuries, subs);
  const trainingCount = days.filter((d) => d.kind === "training").length;
  const restCount = days.filter((d) => d.kind === "rest").length;

  const macros = computeMacros({ ...i, days_per_week: freq });
  const goal = String(i.goal).toLowerCase();

  const cardio = goal === "fat_loss"
    ? "Start with 2×20 min low-intensity (zone 2) on rest days. Increase only enough to hold the target rate of loss — do not max it early."
    : "Optional: 1-2×20 min low-intensity on rest days for heart health. Not required for the goal.";

  const rate = goal === "fat_loss" ? "Target 0.5–1.0% bodyweight/week. Go more gradual near the end, not more aggressive." : null;

  const meal_plan = {
    calories: macros.calories,
    protein_g: macros.protein_g,
    fat_g: macros.fat_g,
    carb_g: macros.carb_g,
    method: "Mifflin-St Jeor BMR × activity factor, goal-adjusted, safety-floored.",
    goal,
    rate_of_loss_target: rate,
    meal_structure: [
      { meal: "Meal 1", focus: "protein + carbs around the day's start" },
      { meal: "Meal 2", focus: "protein + veg + fats" },
      { meal: "Meal 3 (pre/post training)", focus: "protein + the bulk of carbs" },
      { meal: "Meal 4", focus: "protein + veg" },
    ],
    dietary_style: i.dietary_style || "omnivore",
    allergies: i.allergies || "",
    notes: i.diet_notes || "",
    cardio,
    principles: [
      "Protein is the anchor — hit it daily.",
      "Keep carbs functional (training + fullness) as long as the deficit allows.",
      "Gradual and repeatable beats aggressive.",
      "Weigh-in + check-in weekly; targets are starting points, adjusted off real data.",
    ],
    disclaimer:
      "Fitness coaching, not medical advice. These are starting targets, reviewed and adjusted weekly off your check-in data.",
  };

  const trainingLabels = split.map((s: any) => s[0]).join(", ");
  const rationale = [
    `Goal: ${goal}. Week structure: ${trainingCount} training + ${restCount} rest (${trainingLabels}). Experience: ${i.experience || "beginner"}. Equipment: ${i.equipment || "full_gym"}.`,
    freqNote,
    "Movement selection biases basic patterns (squat/hinge/press/pull/carry-core) — simplicity increases consistency even for advanced lifters.",
    `Nutrition: BMR ${macros.bmr} × ${macros.activity_factor} = TDEE ${macros.tdee}; target ${macros.calories} kcal (P ${macros.protein_g} / F ${macros.fat_g} / C ${macros.carb_g}).`,
    injuries.length ? `Injuries noted: ${injuries.join(", ")}.` : "No injuries reported.",
    subs.length ? "Substitutions: " + subs.join("; ") + "." : "No substitutions required.",
    "Method: fixed structure, reviewed and adjusted weekly from client data. Evidence base: progressive overload, RIR 1-2 on compounds, recovery days required.",
  ].join(" ");

  return {
    held: false,
    health_flags,
    training: { days },
    meal_plan,
    macros,
    rationale,
    substitutions: subs,
    frequency: { training_days: trainingCount, rest_days: restCount },
  };
}
