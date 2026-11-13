// Editable meal-plan form. Every generated value is editable before the coach assigns:
// the macro header, each meal's name/note, and each food item (food, qty, kcal), plus
// add/remove for meals and items. Controlled — calls onChange with the updated plan.
export default function MealPlanEditor({ plan, onChange }) {
  const set = (patch) => onChange({ ...plan, ...patch });
  const meals = Array.isArray(plan.meals) ? plan.meals : [];

  const setMeal = (mi, patch) => set({ meals: meals.map((m, i) => (i === mi ? { ...m, ...patch } : m)) });
  const setItem = (mi, ii, patch) =>
    setMeal(mi, { items: meals[mi].items.map((it, i) => (i === ii ? { ...it, ...patch } : it)) });
  const addItem = (mi) => setMeal(mi, { items: [...(meals[mi].items ?? []), { food: "", qty: "", kcal: 0 }] });
  const removeItem = (mi, ii) => setMeal(mi, { items: meals[mi].items.filter((_, i) => i !== ii) });
  const addMeal = () => set({ meals: [...meals, { name: `Meal ${meals.length + 1}`, items: [], note: "" }] });
  const removeMeal = (mi) => set({ meals: meals.filter((_, i) => i !== mi) });

  const numOr = (v) => (v === "" ? 0 : Number(v));

  return (
    <div className="mt-2 space-y-3">
      <input value={plan.title ?? ""} onChange={(e) => set({ title: e.target.value })} placeholder="Plan title"
        className="w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm font-medium capitalize" />

      {/* Macro header */}
      <div className="grid grid-cols-4 gap-2">
        {[["calories", "kcal"], ["protein_g", "P (g)"], ["fat_g", "F (g)"], ["carb_g", "C (g)"]].map(([k, label]) => (
          <label key={k} className="text-[11px]">
            <span className="opacity-60">{label}</span>
            <input type="number" value={plan[k] ?? 0} onChange={(e) => set({ [k]: numOr(e.target.value) })}
              className="mt-0.5 w-full rounded-md border border-ink/15 px-2 py-1 text-sm" />
          </label>
        ))}
      </div>

      {/* Meals */}
      {meals.map((m, mi) => {
        const mealKcal = (m.items ?? []).reduce((s, it) => s + (Number(it.kcal) || 0), 0);
        return (
          <div key={mi} className="rounded-lg border border-ink/10 p-2.5">
            <div className="flex items-center gap-2">
              <input value={m.name ?? ""} onChange={(e) => setMeal(mi, { name: e.target.value })} placeholder="Meal name"
                className="min-w-0 flex-1 rounded-md border border-ink/10 px-2 py-1 text-sm font-medium" />
              <span className="text-xs opacity-50">{mealKcal} kcal</span>
              <button onClick={() => removeMeal(mi)} className="text-xs opacity-40 hover:opacity-100" title="Remove meal">✕</button>
            </div>
            <div className="mt-2 space-y-1">
              {(m.items ?? []).map((it, ii) => (
                <div key={ii} className="flex items-center gap-1.5">
                  <input value={it.food ?? ""} onChange={(e) => setItem(mi, ii, { food: e.target.value })} placeholder="Food"
                    className="min-w-0 flex-1 rounded-md border border-ink/10 px-2 py-1 text-sm" />
                  <input value={it.qty ?? ""} onChange={(e) => setItem(mi, ii, { qty: e.target.value })} placeholder="qty"
                    className="w-20 rounded-md border border-ink/10 px-2 py-1 text-sm" />
                  <input type="number" value={it.kcal ?? 0} onChange={(e) => setItem(mi, ii, { kcal: numOr(e.target.value) })}
                    className="w-16 rounded-md border border-ink/10 px-2 py-1 text-sm" title="kcal" />
                  <button onClick={() => removeItem(mi, ii)} className="px-1 text-xs opacity-40 hover:opacity-100" title="Remove item">✕</button>
                </div>
              ))}
              <button onClick={() => addItem(mi)} className="text-xs text-brand-fg hover:underline">+ item</button>
            </div>
            <input value={m.note ?? ""} onChange={(e) => setMeal(mi, { note: e.target.value })} placeholder="Note (optional)"
              className="mt-2 w-full rounded-md border border-ink/10 px-2 py-1 text-xs" />
          </div>
        );
      })}
      <button onClick={addMeal} className="text-xs text-brand-fg hover:underline">+ meal</button>

      <textarea value={plan.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} placeholder="Plan notes" rows={2}
        className="w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" />
    </div>
  );
}
