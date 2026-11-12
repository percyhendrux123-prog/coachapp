// Peak-week protocol generator — natural competitor, no bloodwork.
//
// Doctrine source: Competition-Prep-Protocol-Framework.md (Helms/Aragon/Fitschen 2014,
// explicitly natural-bodybuilding). Peak posture (how deep the deplete goes, how big the
// load is, and when) scales by division per that framework's table — Men's Physique,
// Bikini, Wellness and Figure are front-load/conservative; Classic Physique, Open
// Bodybuilding and Women's Physique/BB are back-load/aggressive.
//
// The safety block below (no diuretics, no aggressive dehydration, steady sodium, water
// taper only in the final 12-24h) is NON-NEGOTIABLE per that same framework's "Safety
// Guardrails" section — it is hard-coded, not a coach-editable field, and appears on every
// day of every protocol this module produces.
import { computeMacros } from "./mealGen";

export const DIVISIONS = [
  { value: "mens_physique", label: "Men's Physique", posture: "front" },
  { value: "bikini", label: "Bikini", posture: "front" },
  { value: "wellness", label: "Wellness", posture: "front" },
  { value: "figure", label: "Figure", posture: "front" },
  { value: "classic_physique", label: "Classic Physique", posture: "back" },
  { value: "open_bodybuilding", label: "Open Bodybuilding", posture: "back" },
  { value: "womens_physique", label: "Women's Physique / BB", posture: "back" },
];

const SAFETY_BLOCK = [
  "No diuretics.",
  "No aggressive dehydration or water cutting.",
  "Steady sodium every day — never cut it early; do not zero salt at any meal.",
  "Water tapers only in the final 12-24h if needed — never dry out.",
];

// Front-load (conservative): shallower deplete, load starts earlier, smaller peak swing.
// Back-load (aggressive): deeper deplete, load concentrated later, bigger peak swing.
const POSTURE = {
  front: { depleteFloorPct: 0.80, loadCeilingPct: 1.10, loadStartDaysOut: 2 },
  back: { depleteFloorPct: 0.70, loadCeilingPct: 1.20, loadStartDaysOut: 1 },
};

function divisionPosture(division) {
  return DIVISIONS.find((d) => d.value === division)?.posture ?? "front";
}

function daysUntil(showDateStr) {
  if (!showDateStr) return null;
  const show = new Date(`${showDateStr}T00:00:00`);
  if (Number.isNaN(show.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((show.getTime() - today.getTime()) / 86400000);
}

// opts: { sex, age, heightCm, weightKg, activity, division, showDate }
// Returns { held, missing, days_out, division_posture, safety, days } or a held/missing shape.
export function generatePeakWeekProtocol(opts = {}) {
  const daysOut = daysUntil(opts.showDate);
  if (daysOut == null) {
    return {
      held: true,
      reason: "missing_show_date",
      message: "This client has no show_date on file. Set it on the client's profile first — peak week is built off the real calendar, not a guessed countdown.",
    };
  }
  if (daysOut < 0) {
    return { held: true, reason: "show_date_past", message: "This client's show_date has already passed." };
  }

  const macros = computeMacros({
    sex: opts.sex, age: opts.age, heightCm: opts.heightCm, weightKg: opts.weightKg,
    activity: opts.activity, goal: "maintain", weeklyLossLb: 0, clientClass: "competitor",
  });
  const tdee = macros.tdee;
  const posture = POSTURE[divisionPosture(opts.division)];

  // Build the 6-day window (5 days out -> show day), or fewer if the show is closer than that.
  const windowLen = Math.min(6, daysOut + 1);
  const labels = [];
  for (let i = windowLen - 1; i >= 0; i--) labels.push(i === 0 ? "Show day" : `${i} day${i === 1 ? "" : "s"} out`);

  const days = labels.map((label, idx) => {
    const daysOutForRow = windowLen - 1 - idx;
    const isShowDay = daysOutForRow === 0;
    const isLoadPhase = daysOutForRow <= posture.loadStartDaysOut;

    let phase, calories, carbPct, guidance;
    if (isShowDay) {
      phase = "Show day";
      calories = Math.round(tdee * ((posture.depleteFloorPct + posture.loadCeilingPct) / 2));
      carbPct = 0.55;
      guidance = "Small carb+protein mini-meals through the day, timed around call times. Pump-up 10-15 min before stage, no failure, no legs. Sip water to thirst — never chug, never dry out.";
    } else if (isLoadPhase) {
      phase = "Load";
      const t = 1 - daysOutForRow / Math.max(posture.loadStartDaysOut, 1);
      calories = Math.round(tdee * (1 + (posture.loadCeilingPct - 1) * (0.5 + 0.5 * t)));
      carbPct = 0.60;
      guidance = "Light pump work only, done well before evening — no new soreness, no failure, no legs. Full water and normal salt. Posing after carb meals.";
    } else {
      phase = "Deplete";
      const t = daysOutForRow / windowLen;
      calories = Math.round(tdee * (posture.depleteFloorPct + (1 - posture.depleteFloorPct) * t));
      carbPct = 0.30;
      guidance = "Higher-rep pump-style training, stop well before failure or new soreness. Easy cardio or steps only. Full water, steady normal sodium — do not cut salt.";
    }
    const carb_g = Math.round((calories * carbPct) / 4);
    const protein_g = macros.protein_g;
    const fat_g = Math.max(Math.round((calories - protein_g * 4 - carb_g * 4) / 9), 20);

    return { label, phase, calories, protein_g, carb_g, fat_g, guidance };
  });

  return {
    held: false,
    days_out: daysOut,
    division_posture: divisionPosture(opts.division),
    tdee,
    safety: SAFETY_BLOCK,
    days,
    note: "Percentage-of-TDEE scaling from this athlete's own stats — not a copy of anyone else's numbers. The coach must review the athlete each day and decide whether to hold or adjust carbs. Never trade the safety block above for a better look.",
  };
}
