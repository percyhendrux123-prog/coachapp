import { customMealRow, macroTargetsOrError } from "./ownerTools.ts";

const floors = { kcal: 1200, protein_g: 100 };
const fail = (m: string): never => { throw new Error(m); };

Deno.test("targets below a floor are refused and the floor is named — never silently clamped", () => {
  const r = macroTargetsOrError({ target_calories: 900, target_protein_g: 150, target_fat_g: 50, target_carb_g: 100 }, floors);
  if (r.ok === true) { fail("should refuse"); return; }
  if (!/1200/.test(r.error)) fail("floor not named");
});

Deno.test("a null protein floor skips the protein check — none exists in the codebase", () => {
  const r = macroTargetsOrError({ target_calories: 2000, target_protein_g: 10, target_fat_g: 50, target_carb_g: 200 }, { kcal: 1200, protein_g: null });
  // 10*4 + 200*4 + 50*9 = 40 + 800 + 450 = 1290; within 15% of 2000? |1290-2000|=710 > 300 -> refused on the macro-math check, not protein.
  if (r.ok === true) { fail("should refuse on macro math, not protein"); return; }
  if (/protein_g.*floor/.test(r.error)) fail("must not invoke a protein floor that doesn't exist");
});

Deno.test("all four targets required", () => {
  const r = macroTargetsOrError({ target_calories: 2000, target_protein_g: 150 }, floors);
  if (r.ok === true) { fail("should refuse"); return; }
  if (!/fat/.test(r.error) || !/carb/.test(r.error)) fail("missing fields not named");
});

Deno.test("a custom meal with all four macros is manual; missing any → incomplete, never estimated", () => {
  const ctx = { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222" };
  const full = customMealRow({ name: "Big Mac + medium fry", category: "no_cook", kcal: 900, protein_g: 30, fat_g: 45, carb_g: 90 }, ctx);
  if (full.macro_state !== "manual") fail("manual");
  if (full.row.owner_client_id !== ctx.clientId) fail("owner");
  if (full.row.photo_source !== null) fail("photo_source must be null, not a placeholder value");
  const part = customMealRow({ name: "Something", category: "freezer", kcal: 500 }, ctx);
  if (part.macro_state !== "incomplete") fail("incomplete");
  if (part.row.protein_g !== null) fail("must not invent protein");
});

Deno.test("category must be a real meals.category value — not a meal-time slot", () => {
  const ctx = { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222" };
  let threw = false;
  try { customMealRow({ name: "x", category: "lunch" }, ctx); } catch { threw = true; }
  if (!threw) fail("lunch is not a meals.category value and must be refused");
});

Deno.test("a custom meal with no category is filed as custom — the AI is never asked to pick a library type", () => {
  const ctx = { tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222" };
  const r = customMealRow({ name: "Chipotle bowl", kcal: 800, protein_g: 45, fat_g: 30, carb_g: 80 }, ctx);
  if (r.row.category !== "custom") fail("default category");
  if (r.row.photo_source !== null) fail("no photo source is ever set on a custom meal");
});

Deno.test("a sub-floor protein target is refused with the floor AND its basis named", () => {
  const r = macroTargetsOrError(
    { target_calories: 2000, target_protein_g: 120, target_fat_g: 60, target_carb_g: 245 },
    { kcal: 1600, protein_g: 156, protein_basis: "1.6 g per kg of your 97.5 kg" },
  );
  if (r.ok === true) { fail("should refuse"); return; }
  if (!/156 g/.test(r.error)) fail("floor not named");
  if (!/1\.6 g per kg of your 97\.5 kg/.test(r.error)) fail("basis not named — the buyer must see WHY");
});
