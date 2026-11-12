// Client-side training-program generator — same movement-selection logic as the intake-flow
// generator (supabase/functions/intake-submit/generate.ts, "Training" section), ported to plain
// browser JS so a coach can generate a program on demand for an already-onboarded client. The
// intake generator is token-gated (authorizes by possession of a single-use intake token) and
// doesn't fit a coach clicking "generate" for an existing client at an arbitrary time — this
// mirrors how src/lib/mealGen.js already handles the equivalent situation for macros: compute
// client-side from the client's own data, no edge function involved.
//
// No goal_weight_kg (or any body-weight metric) is used here at all — training-day selection
// only ever depends on equipment, experience, days/week, and injuries.

const uuid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `id-${Math.random().toString(36).slice(2)}`;

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

const AVAIL = {
  full_gym: ["barbell", "machine", "cable", "db", "bodyweight", "band"],
  home_basic: ["db", "bodyweight", "band"],
  bodyweight: ["bodyweight", "band"],
};

const S = {
  chestPress: () => ({ role: "compound", muscle: "chest", cands: [
    { name: "Incline Barbell Press", equip: "barbell", contra: ["shoulder"] },
    { name: "Incline DB Press (neutral grip)", equip: "db" },
    { name: "Machine Chest Press", equip: "machine" },
    { name: "Push-Up (feet elevated)", equip: "bodyweight" },
  ] }),
  chestIso: () => ({ role: "isolation", muscle: "chest", cands: [
    { name: "Cable Fly", equip: "cable" },
    { name: "DB Fly", equip: "db", contra: ["shoulder"] },
    { name: "Band Fly", equip: "band" },
    { name: "Push-Up", equip: "bodyweight" },
  ] }),
  shoulderPress: () => ({ role: "secondary", muscle: "shoulders", cands: [
    { name: "Seated DB Shoulder Press (neutral)", equip: "db" },
    { name: "Landmine Press", equip: "barbell" },
    { name: "Machine Shoulder Press", equip: "machine" },
    { name: "Barbell Overhead Press", equip: "barbell", contra: ["shoulder", "lower_back"] },
    { name: "Band Overhead Press", equip: "band" },
  ] }),
  triceps: () => ({ role: "isolation", muscle: "triceps", cands: [
    { name: "Rope Triceps Pushdown", equip: "cable" },
    { name: "DB Overhead Extension", equip: "db", contra: ["elbow"] },
    { name: "Band Pushdown", equip: "band" },
    { name: "Bench Dip", equip: "bodyweight", contra: ["shoulder"] },
  ] }),
  vPull: () => ({ role: "compound", muscle: "back", cands: [
    { name: "Lat Pulldown", equip: "cable" },
    { name: "Assisted Pull-Up", equip: "machine" },
    { name: "Band Lat Pulldown", equip: "band" },
    { name: "Pull-Up", equip: "bodyweight" },
  ] }),
  hRow: () => ({ role: "secondary", muscle: "back", cands: [
    { name: "Chest-Supported Row", equip: "machine" },
    { name: "Seated Cable Row", equip: "cable" },
    { name: "Single-Arm DB Row (supported)", equip: "db" },
    { name: "Barbell Bent-Over Row", equip: "barbell", contra: ["lower_back"] },
    { name: "Band Row", equip: "band" },
  ] }),
  rearDelt: () => ({ role: "isolation", muscle: "rear delts", cands: [
    { name: "Reverse Pec-Deck", equip: "machine" },
    { name: "Cable Face Pull", equip: "cable" },
    { name: "DB Rear Delt Fly", equip: "db" },
    { name: "Band Face Pull", equip: "band" },
  ] }),
  biceps: () => ({ role: "isolation", muscle: "biceps", cands: [
    { name: "DB Curl (neutral/hammer)", equip: "db", contra: ["wrist"] },
    { name: "Cable Curl (EZ)", equip: "cable", contra: ["elbow"] },
    { name: "Band Curl", equip: "band" },
  ] }),
  squat: () => ({ role: "compound", muscle: "quads", cands: [
    { name: "Leg Press (controlled ROM)", equip: "machine", contra: [] },
    { name: "Goblet Box Squat", equip: "db", contra: [] },
    { name: "Back Squat", equip: "barbell", contra: ["knee", "lower_back"] },
    { name: "Bodyweight Box Squat", equip: "bodyweight" },
  ] }),
  hinge: () => ({ role: "compound", muscle: "hamstrings/glutes", cands: [
    { name: "Machine Hip Hinge / Back Extension", equip: "machine", contra: [] },
    { name: "DB Romanian Deadlift", equip: "db", contra: ["lower_back"] },
    { name: "Romanian Deadlift (barbell)", equip: "barbell", contra: ["lower_back"] },
    { name: "Glute Bridge", equip: "bodyweight" },
  ] }),
  quadIso: () => ({ role: "isolation", muscle: "quads", cands: [
    { name: "Leg Extension", equip: "machine", contra: [] },
    { name: "DB Step-Up (low box)", equip: "db", contra: ["knee"] },
    { name: "Wall Sit", equip: "bodyweight", contra: [] },
  ] }),
  hamCalf: () => ({ role: "isolation", muscle: "hamstrings/calves", cands: [
    { name: "Seated Leg Curl", equip: "machine" },
    { name: "DB Calf Raise", equip: "db" },
    { name: "Band Leg Curl", equip: "band" },
    { name: "Bodyweight Calf Raise", equip: "bodyweight" },
  ] }),
  core: () => ({ role: "isolation", muscle: "core", cands: [
    { name: "Cable Crunch", equip: "cable", contra: ["lower_back"] },
    { name: "Dead Bug", equip: "bodyweight" },
    { name: "Plank", equip: "bodyweight" },
  ] }),
};

function pick(slot, equip, injuries) {
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

function repScheme(role, exp) {
  const sets = exp === "advanced" ? 4 : 3;
  const reps = role === "compound" ? (exp === "beginner" ? "8-10" : "6-8")
    : role === "secondary" ? "8-12" : "12-15";
  return { sets, reps };
}

function buildDay(label, slots, opts, injuries, subs, supersetIndices) {
  const exp = (opts.experience || "beginner").toLowerCase();
  // Index-aligned with `slots` (including removed slots as `null`) so supersetIndices,
  // written against the original slot positions, still points at the right exercise
  // after a slot fails to resolve.
  const built = slots.map((slot) => {
    const c = pick(slot, opts.equipment || "full_gym", injuries);
    if (!c) { subs.push(`${label}: no safe option for ${slot.muscle} — slot removed (injury/equipment)`); return null; }
    const { sets, reps } = repScheme(slot.role, exp);
    const setArr = Array.from({ length: sets }, (_, k) => ({
      set_index: k, target_reps: reps, target_weight: null,
      notes: k === sets - 1 ? "Leave 1-2 reps in reserve (RIR)." : null,
    }));
    if (slot.cands[0] && c.name !== slot.cands[0].name && (slot.cands[0].contra || []).some((x) => injuries.includes(x))) {
      subs.push(`${label}: ${slot.cands[0].name} → ${c.name} (injury-aware substitution)`);
    }
    return { name: c.name, sets: setArr, exercise_id: uuid(), demo_media_url: null };
  });

  // Slots meant to pair as a superset (e.g. an isolation finisher pair) — only paired
  // when BOTH resolved to an exercise; a single survivor falls back to the straight
  // group rather than being "supersetted" with nothing.
  const supersetSet = new Set(supersetIndices ?? []);
  const supersetExercises = [...supersetSet].map((i) => built[i]).filter(Boolean);
  const pairIsComplete = supersetSet.size > 0 && supersetExercises.length === supersetSet.size;

  const groups = [];
  const straightExercises = built.filter((ex, i) => ex && !(pairIsComplete && supersetSet.has(i)));
  if (straightExercises.length) groups.push({ type: "straight", group_id: uuid(), exercises: straightExercises });
  if (pairIsComplete) groups.push({ type: "superset", group_id: uuid(), exercises: supersetExercises });

  return { kind: "training", label, day_id: uuid(), groups };
}

function buildRestDay(label = "Rest") {
  return { kind: "rest", label, day_id: uuid(), groups: [] };
}

// Each split names which of its own slot positions pair as a superset finisher — the
// generator already knows which slots are meant to go together (isolation exercises
// sharing a muscle group / antagonist pair), so this is declared here rather than
// guessed later from exercise names.
function trainingDaysForFreq(freq) {
  const P = () => [S.chestPress(), S.shoulderPress(), S.chestIso(), S.triceps()];
  const L = () => [S.squat(), S.hinge(), S.quadIso(), S.hamCalf(), S.core()];
  const U = () => [S.chestPress(), S.hRow(), S.shoulderPress(), S.vPull(), S.biceps(), S.triceps()];
  const PULL = () => [S.vPull(), S.hRow(), S.rearDelt(), S.biceps()];
  const FULL_A = () => [S.squat(), S.chestPress(), S.hRow(), S.core()];
  const FULL_B = () => [S.hinge(), S.shoulderPress(), S.vPull(), S.hamCalf()];
  const FULL_C = () => [S.squat(), S.chestIso(), S.rearDelt(), S.biceps(), S.triceps()];
  switch (freq) {
    case 3: return [
      ["Full Body A", FULL_A(), null],
      ["Full Body B", FULL_B(), null],
      ["Full Body C", FULL_C(), [3, 4]], // biceps + triceps
    ];
    case 5: return [
      ["Push", P(), [2, 3]],   // chest isolation + triceps
      ["Pull", PULL(), [2, 3]], // rear delt + biceps
      ["Legs", L(), [2, 3]],   // quad isolation + ham/calf
      ["Upper", U(), [4, 5]],  // biceps + triceps
      ["Lower", L(), [2, 3]],
    ];
    case 6: return [
      ["Push A", P(), [2, 3]], ["Pull A", PULL(), [2, 3]], ["Legs A", L(), [2, 3]],
      ["Push B", P(), [2, 3]], ["Pull B", PULL(), [2, 3]], ["Legs B", L(), [2, 3]],
    ];
    case 4:
    default: return [
      ["Upper A", U(), [4, 5]], ["Lower A", L(), [2, 3]],
      ["Upper B", U(), [4, 5]], ["Lower B", L(), [2, 3]],
    ];
  }
}

// Expand into a 7-day week with explicit rest days.
// 3d: T R T R T R R · 4d: T R T R T R T · 5d: T T R T T R T · 6d: T T T R T T T
function expandToWeek(training, opts, injuries, subs) {
  const built = training.map(([label, slots, supersetIndices]) => buildDay(label, slots, opts, injuries, subs, supersetIndices));
  const n = built.length;
  const R = () => buildRestDay("Rest");
  if (n === 3) return [built[0], R(), built[1], R(), built[2], R(), R()];
  if (n === 4) return [built[0], R(), built[1], R(), built[2], R(), built[3]];
  if (n === 5) return [built[0], built[1], R(), built[2], built[3], R(), built[4]];
  if (n === 6) return [built[0], built[1], built[2], R(), built[3], built[4], built[5]];
  const out = [];
  for (const d of built) {
    out.push(d);
    if (out.length < 7) out.push(R());
  }
  while (out.length < 7) out.push(R());
  return out.slice(0, 7);
}

// Cap claimed availability — "all 7 days available" is not a prescription.
function resolveTrainingFrequency(daysPerWeek) {
  const claimed = clamp(Number(daysPerWeek) || 4, 1, 7);
  let freq = clamp(claimed, 3, 6);
  let note = `Training frequency set to ${freq} lifting days / week (${7 - freq} rest day(s) in the week structure).`;
  if (claimed >= 7) {
    freq = 5;
    note = "Client marked 7 days available — capped at 5 lifting + 2 rest. Availability is not recovery capacity.";
  }
  return { freq, note };
}

// opts: { daysPerWeek, experience, equipment, injuries } — no body-weight metrics of any kind.
// Returns { days, frequency: {training_days, rest_days}, rationale, substitutions }.
export function generateTrainingProgram(opts = {}) {
  const injuries = (opts.injuries || []).filter((x) => x && x !== "none");
  const subs = [];
  const { freq, note: freqNote } = resolveTrainingFrequency(opts.daysPerWeek);
  const split = trainingDaysForFreq(freq);
  const days = expandToWeek(split, opts, injuries, subs);
  const trainingCount = days.filter((d) => d.kind === "training").length;
  const restCount = days.filter((d) => d.kind === "rest").length;
  const trainingLabels = split.map((s) => s[0]).join(", ");

  const rationale = [
    `Week structure: ${trainingCount} training + ${restCount} rest (${trainingLabels}). Experience: ${opts.experience || "beginner"}. Equipment: ${opts.equipment || "full_gym"}.`,
    freqNote,
    "Movement selection biases basic patterns (squat/hinge/press/pull/carry-core) — simplicity increases consistency even for advanced lifters.",
    injuries.length ? `Injuries noted: ${injuries.join(", ")}.` : "No injuries reported.",
    subs.length ? "Substitutions: " + subs.join("; ") + "." : "No substitutions required.",
  ].join(" ");

  return { days, frequency: { training_days: trainingCount, rest_days: restCount }, rationale, substitutions: subs };
}
