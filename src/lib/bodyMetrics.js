// Reading the raw intake values a coach reviews, and writing the confirmed ones.
//
// The read side is deliberately dumb: it returns the raw strings exactly as the client
// typed them, alongside whatever is currently on the client record. It does not decide
// anything. The deciding happens in the UI, in front of a human, with the raw text visible.
import { supabase } from "./supabase";
import { parseAge, parseGoalWeightLb, parseHeightIn, parseWeightLb } from "./intakeUnits";

// Raw body strings for coach confirmation.
//
// Preferred source: tokenized app intake (`intake_forms.answers`) — this is what
// /intake?token=… writes after implementation (sex, units, height/weight raw strings).
// Fallback: legacy Netlify consultation rows on `intake_submissions`.
// A client may have several of either; the most recent is under review.
export async function getIntakeRawMetrics(clientId) {
  const { data: form, error: formErr } = await supabase
    .from("intake_forms")
    .select("id, submitted_at, answers")
    .eq("client_id", clientId)
    .eq("status", "submitted")
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (formErr) throw formErr;

  // A health-screen-only submission (intake_kind "screen") with no earlier intake carries no
  // body metrics; it must not hide a legacy consultation row that does.
  const hasMetrics = (a) => a && ["age", "age_raw", "height_raw", "weight_raw", "sex"].some((k) => a[k] != null && a[k] !== "");
  if (form?.answers && hasMetrics(form.answers)) {
    const a = form.answers;
    return {
      id: form.id,
      source: "intake_forms",
      submitted_at: form.submitted_at,
      age_raw: a.age_raw ?? (a.age != null ? String(a.age) : null),
      height_raw: a.height_raw ?? null,
      weight_raw: a.weight_raw ?? null,
      goal_weight_raw: a.goal_weight_raw ?? null,
      sex: a.sex ?? null,
      unit_pref: a.unit_pref ?? null,
    };
  }

  const { data, error } = await supabase
    .from("intake_submissions")
    .select("id, submitted_at, age_raw, height_raw, weight_raw, goal_weight_raw")
    .eq("client_id", clientId)
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? { ...data, source: "intake_submissions", sex: null, unit_pref: null } : null;
}

export async function getConfirmedMetrics(clientId) {
  const { data, error } = await supabase
    .from("clients")
    .select("age, sex, height_in, weight_lb, goal_weight_lb, height_cm, weight_kg, goal_weight_kg, unit_pref")
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// Reads each raw string and reports one of three states per field. `ambiguous` is the
// point of the whole exercise -- it is what "210.7" against a kilograms column should
// always have produced.
//
//   confirmed_needed : nothing on the form to read
//   ambiguous        : read two ways, both real; the coach picks
//   suggested        : one reading is possible; pre-filled, still editable
export function readRawMetrics(raw) {
  const out = {};

  const age = parseAge(raw?.age_raw);
  out.age = age.ok
    ? { state: "suggested", value: age.age, basis: `from "${raw.age_raw}"` }
    : { state: raw?.age_raw ? "unreadable" : "absent", reason: age.reason };

  const h = parseHeightIn(raw?.height_raw);
  out.height_in = h.ok
    ? { state: "suggested", value: h.inch, basis: h.unit_basis }
    : { state: h.candidates ? "ambiguous" : raw?.height_raw ? "unreadable" : "absent",
        reason: h.reason, candidates: h.candidates };

  const w = parseWeightLb(raw?.weight_raw);
  out.weight_lb = w.ok
    ? { state: "suggested", value: w.lb, basis: w.unit_basis }
    : { state: w.candidates ? "ambiguous" : raw?.weight_raw ? "unreadable" : "absent",
        reason: w.reason, candidates: w.candidates };

  const g = parseGoalWeightLb(raw?.goal_weight_raw);
  out.goal_weight_lb = g.ok
    ? { state: "suggested", value: g.lb, basis: g.unit_basis, range: g.range }
    : { state: g.candidates ? "ambiguous" : raw?.goal_weight_raw ? "unreadable" : "absent",
        reason: g.reason, candidates: g.candidates };

  // Sex is collected on tokenized intake as answers.sex (implementation). Older
  // intake_submissions rows have no sex field — coach must ask or confirm from answers JSON.
  const sexVal = String(raw?.sex ?? "").toLowerCase();
  if (sexVal === "male" || sexVal === "female" || sexVal === "other") {
    out.sex = {
      state: "suggested",
      value: sexVal,
      basis: raw?.source === "intake_forms"
        ? "from intake answers.sex"
        : `from intake ("${sexVal}")`,
    };
  } else if (raw?.source === "intake_forms") {
    out.sex = {
      state: "absent",
      reason: "Intake answers did not include sex — re-invite or ask the client.",
    };
  } else {
    out.sex = {
      state: "confirm_on_form",
      reason: "Confirm sex from intake answers or ask the client — not inferred.",
    };
  }

  return out;
}

// Writes the confirmed set. Refuses partial writes server-side; the returned object carries
// either status:'confirmed' or status:'refused' with what was wrong.
export async function confirmBodyMetrics(clientId, { age, sex, heightIn, weightLb, goalWeightLb }) {
  const num = (v) => (v === "" || v == null ? null : Number(v));
  const { data, error } = await supabase.rpc("confirm_client_body_metrics", {
    p_client_id: clientId,
    p_age: age === "" || age == null ? null : parseInt(age, 10),
    p_sex: sex || null,
    p_height_in: num(heightIn),
    p_weight_lb: num(weightLb),
    p_goal_weight_lb: num(goalWeightLb),
  });
  if (error) throw error;
  return data;
}

// ft/in <-> total inches, for the entry fields. Kept here rather than in units.js because
// this is a display concern: the stored value is always total inches.
export const inToFtIn = (inch) => {
  const n = Number(inch);
  if (!Number.isFinite(n)) return { ft: "", in: "" };
  return { ft: Math.floor(n / 12), in: Math.round((n % 12) * 10) / 10 };
};
export const ftInToIn = (ft, inch) => {
  const f = Number(ft), i = Number(inch === "" || inch == null ? 0 : inch);
  if (!Number.isFinite(f) && !Number.isFinite(i)) return null;
  if (!Number.isFinite(f)) return null;
  return Math.round((f * 12 + (Number.isFinite(i) ? i : 0)) * 100) / 100;
};
