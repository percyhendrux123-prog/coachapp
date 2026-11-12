// Pure validation for the five owner-scope tools. No I/O here — index.ts does the reads and
// writes; this file decides what is allowed to be written. THE GATE lives here: nothing is
// estimated, clamped, or defaulted. A sub-floor target is refused with the floor named.
export type Floors = {
  kcal: number;
  // Protein floor: proteinFloorG(weight_kg) from mealMacros.ts — 1.6 g/kg of the buyer's own
  // current weight. null only when weight is unknown, and callers refuse before reaching here.
  protein_g: number | null;
  // Plain-language basis shown in the refusal, e.g. "1.6 g per kg of your 97.5 kg".
  protein_basis?: string;
};
type Targets = { target_calories: number; target_protein_g: number; target_fat_g: number; target_carb_g: number };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function macroTargetsOrError(a: Record<string, unknown>, floors: Floors): { ok: true; targets: Targets } | { ok: false; error: string } {
  const keys = ["target_calories", "target_protein_g", "target_fat_g", "target_carb_g"] as const;
  const missing = keys.filter((k) => num(a?.[k]) === null);
  if (missing.length) return { ok: false, error: `all four targets are required as numbers — missing: ${missing.join(", ")}` };
  const t = Object.fromEntries(keys.map((k) => [k, num(a[k]) as number])) as Targets;
  if (t.target_calories < floors.kcal) return { ok: false, error: `target_calories ${t.target_calories} is below the floor of ${floors.kcal} kcal — not applied` };
  if (floors.protein_g !== null && t.target_protein_g < floors.protein_g)
    return { ok: false, error: `target_protein_g ${t.target_protein_g} is below the floor of ${floors.protein_g} g${floors.protein_basis ? ` (${floors.protein_basis})` : ""} — not applied` };
  const fromMacros = t.target_protein_g * 4 + t.target_carb_g * 4 + t.target_fat_g * 9;
  if (Math.abs(fromMacros - t.target_calories) > 0.15 * t.target_calories)
    return { ok: false, error: `macros add up to ${Math.round(fromMacros)} kcal, target_calories is ${t.target_calories} — more than 15% apart; fix one` };
  return { ok: true, targets: t };
}

// meals.category CHECK uses a food-type taxonomy, not a meal-time slot.
// Buyer-created meals default to `custom`; library types stay allowed if given.
export const CATEGORIES = new Set(["breakfast", "chicken", "beef", "fish", "eggs", "carb_side", "vegetable", "no_cook", "freezer", "custom"]);
export const CUSTOM_CATEGORY = "custom";

export function customMealRow(a: Record<string, unknown>, ctx: { tenantId: string; clientId: string }) {
  const name = String(a?.name ?? "").trim().slice(0, 120);
  if (!name) throw new Error("name is required");
  const rawCat = typeof a?.category === "string" ? a.category.trim().toLowerCase() : "";
  const category = rawCat === "" ? CUSTOM_CATEGORY : rawCat;
  if (!CATEGORIES.has(category)) throw new Error(`category must be one of ${[...CATEGORIES].join(", ")}`);
  const kcal = num(a?.kcal), protein_g = num(a?.protein_g), fat_g = num(a?.fat_g), carb_g = num(a?.carb_g);
  const complete = [kcal, protein_g, fat_g, carb_g].every((v) => v !== null);
  const slug = `custom-${ctx.clientId.slice(0, 8)}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-${Date.now().toString(36)}`;
  return {
    macro_state: complete ? "manual" : "incomplete",
    row: {
      tenant_id: ctx.tenantId, owner_client_id: ctx.clientId, slug, name, category,
      kcal, protein_g, fat_g, carb_g, macro_state: complete ? "manual" : "incomplete",
      status: "published", serves_lifestyle: true, serves_prep: false,
      summary: typeof a?.summary === "string" ? a.summary.slice(0, 300) : null,
      photo_source: null,
    },
  };
}
