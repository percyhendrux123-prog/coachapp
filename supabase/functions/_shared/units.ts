// Reading a height or a weight out of free text, and refusing when the text does not
// say enough to know.
//
// WHY THIS FILE EXISTS
//
// Cheryl Moye's intake carried the weight "210.7" and nothing else. The column it was
// headed for is `weight_kg`. 210.7 lb is 95.6 kg; 210.7 kg is a different person who does
// not exist. Both readings parse. Only one is true, and the form did not say which.
//
// Software's instinct here is to pick the likely one. That instinct is the whole defect:
// picking answers the question, so nobody asks it again, and a 95 kg woman is programmed
// as a 210 kg man for as long as the record survives.
//
// So this module resolves a measurement ONLY when the text is explicit about its unit, or
// when exactly one reading is physically possible for a human being. Anything else comes
// back `ambiguous` with both candidate readings named, so a human can spend four seconds
// resolving what the software would have spent zero seconds inventing.
//
// IMPERIAL IS THE HOUSE STANDARD. Pounds and inches are what get stored and shown; the
// metric value is derived for the arithmetic. That direction matters: converting lb -> kg
// is lossless bookkeeping, while storing kg and rendering lb re-rounds a number the coach
// typed.

export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;

export const lbToKg = (lb: number) => Math.round(lb * KG_PER_LB * 1000) / 1000;
export const inToCm = (inch: number) => Math.round(inch * CM_PER_IN * 100) / 100;

export type Measure =
  | { ok: true; lb: number; unit_basis: string }
  | { ok: true; inch: number; unit_basis: string }
  | { ok: false; reason: string; candidates?: string[] };

// A weight in pounds is a real adult weight; the same figure read as kilograms may or may
// not be. These bounds are deliberately generous — they exist to rule out the impossible,
// not to judge whether a body is typical.
const LB_MIN = 70, LB_MAX = 600;   // ~32-272 kg
const IN_MIN = 48, IN_MAX = 90;    // 4'0" - 7'6"

const numbersIn = (s: string): number[] =>
  [...s.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));

// ── Weight ────────────────────────────────────────────────────────────────────────────
// Returns pounds. Accepts "210.7 lb", "95.6kg", "15 st 4", or a bare number ONLY when one
// of the two readings is outside the range a human body occupies.
export function parseWeightLb(raw: string | null | undefined): Measure {
  const s = (raw ?? "").trim();
  if (!s) return { ok: false, reason: "no weight was given" };

  // Stone-and-pounds, before the bare-number path — "15 st 4" is two numbers, not one.
  const st = s.match(/(\d+(?:\.\d+)?)\s*(?:st|stone)\b\s*(\d+(?:\.\d+)?)?/i);
  if (st) {
    const lb = Number(st[1]) * 14 + Number(st[2] ?? 0);
    return { ok: true, lb: Math.round(lb * 10) / 10, unit_basis: `stated in stone ("${s}")` };
  }

  const nums = numbersIn(s);
  if (nums.length === 0) return { ok: false, reason: `no number could be read from "${s}"` };
  const n = nums[0];

  if (/\b(lbs?|pounds?|#)\b/i.test(s) || /\d\s*#/.test(s)) {
    return { ok: true, lb: n, unit_basis: `stated in pounds ("${s}")` };
  }
  if (/\b(kgs?|kilos?|kilogram)/i.test(s)) {
    return { ok: true, lb: Math.round((n / KG_PER_LB) * 10) / 10, unit_basis: `stated in kilograms ("${s}") = ${n} kg` };
  }

  // Bare number. Resolve only if one reading is impossible for a person.
  const asLbPlausible = n >= LB_MIN && n <= LB_MAX;
  const asKgPlausible = n / KG_PER_LB >= LB_MIN && n / KG_PER_LB <= LB_MAX;

  if (asLbPlausible && asKgPlausible) {
    return {
      ok: false,
      reason:
        `"${s}" carries no unit, and both readings describe a real person. ` +
        `The form must capture the unit, or a human must state it.`,
      candidates: [`${n} lb (${lbToKg(n)} kg)`, `${n} kg (${Math.round((n / KG_PER_LB) * 10) / 10} lb)`],
    };
  }
  if (asLbPlausible) return { ok: true, lb: n, unit_basis: `"${s}" has no unit; read as pounds because ${n} kg is not a human weight` };
  if (asKgPlausible) {
    const lb = Math.round((n / KG_PER_LB) * 10) / 10;
    return { ok: true, lb, unit_basis: `"${s}" has no unit; read as kilograms because ${n} lb is not a human weight` };
  }
  return { ok: false, reason: `"${s}" is not a human weight in either pounds or kilograms` };
}

// ── Height ────────────────────────────────────────────────────────────────────────────
// Returns inches. Accepts 5'4", 5’4”, 5 ft 4, 64", 163 cm, 1.63 m, or a bare number when
// only one reading is possible.
export function parseHeightIn(raw: string | null | undefined): Measure {
  const s = (raw ?? "").trim();
  if (!s) return { ok: false, reason: "no height was given" };

  // Feet-and-inches. Curly quotes are what phone keyboards actually produce, so they are
  // first-class here rather than an afterthought — Cheryl's own answer was 5’4”.
  const ftin = s.match(/(\d+)\s*(?:'|’|ft|feet|foot)\s*(\d+(?:\.\d+)?)?\s*(?:"|”|''|in|inch(?:es)?)?/i);
  if (ftin) {
    const inch = Number(ftin[1]) * 12 + Number(ftin[2] ?? 0);
    return { ok: true, inch, unit_basis: `stated in feet and inches ("${s}")` };
  }

  const nums = numbersIn(s);
  if (nums.length === 0) return { ok: false, reason: `no number could be read from "${s}"` };
  const n = nums[0];

  if (/\bcm\b|centimet/i.test(s)) {
    return { ok: true, inch: Math.round((n / CM_PER_IN) * 100) / 100, unit_basis: `stated in centimetres ("${s}") = ${n} cm` };
  }
  if (/\bm\b|met(er|re)s?\b/i.test(s) && n < 3) {
    return { ok: true, inch: Math.round(((n * 100) / CM_PER_IN) * 100) / 100, unit_basis: `stated in metres ("${s}")` };
  }
  if (/"|”|\bin\b|inch/i.test(s)) return { ok: true, inch: n, unit_basis: `stated in inches ("${s}")` };

  const asInPlausible = n >= IN_MIN && n <= IN_MAX;
  const asCmPlausible = n / CM_PER_IN >= IN_MIN && n / CM_PER_IN <= IN_MAX;

  if (asInPlausible && asCmPlausible) {
    return {
      ok: false,
      reason: `"${s}" carries no unit and reads as a real height either way.`,
      candidates: [`${n} in`, `${n} cm`],
    };
  }
  if (asInPlausible) return { ok: true, inch: n, unit_basis: `"${s}" has no unit; read as inches because ${n} cm is not a human height` };
  if (asCmPlausible) {
    return { ok: true, inch: Math.round((n / CM_PER_IN) * 100) / 100, unit_basis: `"${s}" has no unit; read as centimetres because ${n} inches is not a human height` };
  }
  return { ok: false, reason: `"${s}" is not a human height in either inches or centimetres` };
}

// ── Age ───────────────────────────────────────────────────────────────────────────────
export function parseAge(raw: string | null | undefined): { ok: true; age: number } | { ok: false; reason: string } {
  const s = (raw ?? "").trim();
  if (!s) return { ok: false, reason: "no age was given" };
  const nums = numbersIn(s);
  if (nums.length === 0) return { ok: false, reason: `no number could be read from "${s}"` };
  const n = nums[0];
  if (!Number.isInteger(n) || n < 14 || n > 90) {
    return { ok: false, reason: `"${s}" is not an age this system will program for (14-90)` };
  }
  return { ok: true, age: n };
}

// ── Goal weight ───────────────────────────────────────────────────────────────────────
// A range ("165-170") is a real answer, not a malformed one: the client is naming a band
// they would be happy inside. The midpoint is the one number the arithmetic needs, and the
// band is reported alongside so the coach sees what was collapsed.
export function parseGoalWeightLb(
  raw: string | null | undefined,
): (Measure & { ok: true; lb: number; range?: [number, number] }) | { ok: false; reason: string; candidates?: string[] } {
  const s = (raw ?? "").trim();
  if (!s) return { ok: false, reason: "no goal weight was given" };

  const nums = numbersIn(s);
  if (nums.length >= 2 && /[-–—]|to\b/i.test(s)) {
    const lo = Math.min(...nums), hi = Math.max(...nums);
    // Whatever unit words the string carries apply to the whole range, so each endpoint is
    // resolved against the same suffix. If the range has no unit, both ends land ambiguous
    // together and the refusal below is the one the caller sees.
    const suffix = s.replace(/[\d.,]|[-–—]|\bto\b/gi, " ").trim();
    const loRead = parseWeightLb(`${lo} ${suffix}`.trim());
    const hiRead = parseWeightLb(`${hi} ${suffix}`.trim());
    if (!loRead.ok) return loRead;
    if (!hiRead.ok) return hiRead;
    const loLb = (loRead as { lb: number }).lb, hiLb = (hiRead as { lb: number }).lb;
    return {
      ok: true,
      lb: Math.round(((loLb + hiLb) / 2) * 10) / 10,
      range: [loLb, hiLb],
      unit_basis: `${(loRead as { unit_basis: string }).unit_basis}; range ${loLb}-${hiLb} lb collapsed to its midpoint`,
    };
  }
  return parseWeightLb(s) as (Measure & { ok: true; lb: number }) | { ok: false; reason: string; candidates?: string[] };
}
