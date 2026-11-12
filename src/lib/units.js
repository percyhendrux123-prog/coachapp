// Unit conversion for the client stats block. DB stores canonical metric
// (height_cm, weight_kg); these convert to/from the coach's chosen display units so a
// future meal-plan calculator always reads clean metric numbers regardless of UI toggle.
export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;

const round1 = (n) => Math.round(n * 10) / 10;
const num = (v) => (v === "" || v == null ? null : Number(v));

export const lbToKg = (lb) => (num(lb) == null ? null : round1(num(lb) * KG_PER_LB));
export const kgToLb = (kg) => (num(kg) == null ? "" : round1(num(kg) / KG_PER_LB));
export const inToCm = (i) => (num(i) == null ? null : round1(num(i) * CM_PER_IN));
export const cmToIn = (cm) => (num(cm) == null ? "" : round1(num(cm) / CM_PER_IN));

// Height in imperial is entered as feet + inches; store/read as total centimeters.
export const ftInToCm = (ft, inch) => {
  const f = num(ft) ?? 0;
  const i = num(inch) ?? 0;
  if (num(ft) == null && num(inch) == null) return null;
  return round1((f * 12 + i) * CM_PER_IN);
};
export const cmToFtIn = (cm) => {
  if (num(cm) == null) return { ft: "", in: "" };
  const totalIn = Math.round(num(cm) / CM_PER_IN);
  return { ft: Math.floor(totalIn / 12), in: totalIn % 12 };
};

export const ACTIVITY_LEVELS = [
  { value: "sedentary", label: "Sedentary" },
  { value: "light", label: "Lightly active" },
  { value: "moderate", label: "Moderately active" },
  { value: "active", label: "Active" },
  { value: "very_active", label: "Very active" },
];
