// The structured meal-plan surface (client_meal_plans / _slots / _slot_options), separate
// from the legacy meal_plans table in mealPlan.js. Conventions mirrored deliberately: same
// error handling, same shape of return, same comment density. RLS already restricts every
// read here to the caller's own tenant/client — this file never re-implements that check.
import { supabase } from "./supabase";

// Coach: the client's one current plan row, or null. A client can have several rows
// (drafts and archived history) and a draft can share its `updated_at` with the archived
// row it superseded — sorting on that column alone can silently surface stale history
// instead of live work. Status order is the real precedence: an assigned plan is what the
// client sees today, a draft is what the coach is actively building, and only when neither
// exists is an archived row (most recent) shown at all. Coach-scoped by RLS (cmp_coach_all).
export async function getStructuredPlanRecord(clientId) {
  const { data, error } = await supabase
    .from("client_meal_plans")
    .select(
      "id, client_id, title, status, target_calories, target_protein_g, target_fat_g, target_carb_g, meals_per_day, notes, assigned_at, updated_at"
    )
    .eq("client_id", clientId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  if (!data || data.length === 0) return null;
  const byStatus = (status) => data.find((r) => r.status === status);
  return byStatus("assigned") ?? byStatus("draft") ?? data[0];
}

// Client: their own plan, only once released. RLS also restricts this to their own
// assigned row (cmp_client_read) — this is a convenience filter, not the security boundary.
export async function getAssignedStructuredPlan(clientId) {
  const { data, error } = await supabase
    .from("client_meal_plans")
    .select(
      "id, client_id, title, target_calories, target_protein_g, target_fat_g, target_carb_g, meals_per_day, assigned_at"
    )
    .eq("client_id", clientId)
    .eq("status", "assigned")
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// The meal columns every slot/fallback/swap read needs. One constant so a base meal, a
// fallback meal, and a swap option are never accidentally read with different shapes.
const MEAL_COLUMNS =
  "id, slug, name, summary, kcal, protein_g, fat_g, carb_g, prep_time_min, cook_time_min, disruption_floor, downgrade_to_meal_id, macro_lesson, photo_path, photo_alt, owner_client_id";

// Slots for ONE day of a plan (default day_index 0), each carrying its base meal, that
// meal's fallback (or null if the meal already holds — nothing to downgrade to), and its
// swap options. Scoped to a single day deliberately, per D2 in the implementation specification
// surface-build.md: every stored day is currently byte-identical, so leading with a 7-day
// calendar would imply variety that doesn't exist. Pulling all days here instead of one
// silently multiplies every macro total by the day count — that bug shipped once already
// (a 1,864 kcal day read back as ~13,000 across 7 identical days) and was caught only by
// checking real numbers against the approved mockup, not by the app building cleanly.
//
// Built from flat queries rather than a nested embed: `downgrade_to_meal_id` is a second,
// self-referencing pointer into the same `meals` table as the slot's own meal, and
// PostgREST needs an explicit FK alias to embed two relationships to one table in a single
// call — a name that can silently go stale if the constraint is ever renamed. Three flat
// `.in()` reads and an in-memory join avoid that fragility, at the cost of a few more round
// trips (one day is at most a handful of slots).
export async function getPlanSlotsWithMeals(planId, dayIndex = 0) {
  const { data: slots, error: slotsErr } = await supabase
    .from("client_meal_plan_slots")
    .select("id, plan_id, day_index, slot_index, slot_label, meal_id, servings, is_locked, note")
    .eq("plan_id", planId)
    .eq("day_index", dayIndex)
    .order("day_index", { ascending: true })
    .order("slot_index", { ascending: true });
  if (slotsErr) throw slotsErr;
  if (!slots || slots.length === 0) return [];

  const baseMealIds = [...new Set(slots.map((s) => s.meal_id).filter(Boolean))];
  const { data: baseMeals, error: baseErr } = await supabase
    .from("meals")
    .select(MEAL_COLUMNS)
    .in("id", baseMealIds);
  if (baseErr) throw baseErr;
  const mealById = new Map((baseMeals ?? []).map((m) => [m.id, m]));

  const fallbackIds = [...new Set(
    (baseMeals ?? []).map((m) => m.downgrade_to_meal_id).filter((id) => id && !mealById.has(id))
  )];
  if (fallbackIds.length > 0) {
    const { data: fallbackMeals, error: fbErr } = await supabase
      .from("meals")
      .select(MEAL_COLUMNS)
      .in("id", fallbackIds);
    if (fbErr) throw fbErr;
    for (const m of fallbackMeals ?? []) mealById.set(m.id, m);
  }

  const slotIds = slots.map((s) => s.id);
  const { data: options, error: optErr } = await supabase
    .from("client_meal_plan_slot_options")
    .select("slot_id, meal_id, position")
    .in("slot_id", slotIds)
    .order("position", { ascending: true });
  if (optErr) throw optErr;

  const optionMealIds = [...new Set((options ?? []).map((o) => o.meal_id).filter((id) => !mealById.has(id)))];
  if (optionMealIds.length > 0) {
    const { data: optionMeals, error: omErr } = await supabase
      .from("meals")
      .select(MEAL_COLUMNS)
      .in("id", optionMealIds);
    if (omErr) throw omErr;
    for (const m of optionMeals ?? []) mealById.set(m.id, m);
  }

  const optionsBySlot = new Map();
  for (const o of options ?? []) {
    const meal = mealById.get(o.meal_id);
    if (!meal) continue;
    if (!optionsBySlot.has(o.slot_id)) optionsBySlot.set(o.slot_id, []);
    optionsBySlot.get(o.slot_id).push(meal);
  }

  return slots.map((s) => {
    const meal = mealById.get(s.meal_id) ?? null;
    // A meal "holds" — nothing to downgrade to on a bad week — when it has no
    // downgrade target. Whether that's because it's already the library's floor for
    // its category, or because no fallback was ever set, the client-facing fact is the
    // same: this meal is served as-is regardless of week.
    const fallbackMeal = meal?.downgrade_to_meal_id ? mealById.get(meal.downgrade_to_meal_id) ?? null : null;
    return { ...s, meal, fallbackMeal, swapOptions: optionsBySlot.get(s.id) ?? [] };
  });
}

// Public CDN URL for a meal's hero photo (bucket is public — see the implementation specification
// §8). Returns null when the meal has no photo yet, so callers render the honest empty
// state instead of a broken image tag.
export function getMealPhotoUrl(photoPath) {
  if (!photoPath) return null;
  return supabase.storage.from("meal-photos").getPublicUrl(photoPath).data.publicUrl;
}

// Publish a drafted structured plan to its client's Nutrition tab. Deliberately a targeted
// UPDATE of two columns, not an upsert of the whole row — mirrors releaseMealPlan() in
// mealPlan.js exactly, and for the same reason: the plan's contents are not in scope here,
// and this must never be able to null out an assigned_at that already exists. The status
// guard makes the call idempotent and keeps a re-click from refreshing the date on an
// already-live plan.
export async function releaseStructuredPlan(planId) {
  const { data, error } = await supabase
    .from("client_meal_plans")
    .update({ status: "assigned", assigned_at: new Date().toISOString() })
    .eq("id", planId)
    .eq("status", "draft")
    .select("id, client_id, status, assigned_at")
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Good-week vs bad-week macro totals for a set of slots. Good week always uses the base
// meal at the slot's own `servings` — that coefficient was fit to make *that* meal hit the
// target. Bad week either repeats the same meal at the same servings (nothing changed,
// "holds") or serves the fallback meal exactly as written, at its own base servings — never
// the original slot's coefficient, which was never fit to the fallback (see D4 in
// the implementation specification). The delta against target is always shown,
// including when it runs over — a bad week costs something, and hiding that would mean the
// client finds out by gaining weight instead of by reading the screen.
export function summarizePlanMacros(slots) {
  const zero = { kcal: 0, protein_g: 0, fat_g: 0, carb_g: 0 };
  const add = (totals, meal, multiplier) => {
    if (!meal) return totals;
    return {
      kcal: totals.kcal + (Number(meal.kcal) || 0) * multiplier,
      protein_g: totals.protein_g + (Number(meal.protein_g) || 0) * multiplier,
      fat_g: totals.fat_g + (Number(meal.fat_g) || 0) * multiplier,
      carb_g: totals.carb_g + (Number(meal.carb_g) || 0) * multiplier,
    };
  };
  let good = zero, bad = zero;
  for (const s of slots) {
    const servings = Number(s.servings) || 1;
    good = add(good, s.meal, servings);
    bad = s.fallbackMeal ? add(bad, s.fallbackMeal, 1) : add(bad, s.meal, servings);
  }
  const round = (t) => ({
    kcal: Math.round(t.kcal), protein_g: Math.round(t.protein_g), fat_g: Math.round(t.fat_g), carb_g: Math.round(t.carb_g),
  });
  return { good: round(good), bad: round(bad) };
}
