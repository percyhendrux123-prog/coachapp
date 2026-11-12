import { useState, useEffect } from "react";
import { createProgram, updateProgram, newId } from "../lib/programs";

// Program structure editor (Day → Group → Exercise → Sets).
// THE rule of this file: existing day_id / group_id / exercise_id uuids are the linkage
// keys client workout history hangs off — they are minted ONCE for new nodes and must
// survive every edit untouched. Only structural helpers below create ids; nothing
// rewrites one.
const blankSet = () => ({ set_index: 0, target_reps: "8-10", target_weight: null, notes: null });
const blankExercise = () => ({ exercise_id: newId(), name: "", type: "strength", demo_media_url: null, sets: [blankSet()] });
// Cardio has one synthetic set (set_index 0), not a rep-set list — this is what keeps it
// walking the same exercise_id:set_index step iteration strength exercises use, in both
// the client session runner and log_workout_on_behalf. See validateStructure server-side
// (supabase/functions/mcp/index.ts) for the mirror of this shape on the AI-agent write path.
const blankCardioExercise = () => ({
  exercise_id: newId(), name: "", type: "cardio", demo_media_url: null,
  cardio: { modality: "", target_duration_min: null, target_distance: null, target_distance_unit: "mi", target_intensity_rpe: null },
  sets: [{ set_index: 0, target_reps: null, target_weight: null, notes: null }],
});
const blankGroup = () => ({ group_id: newId(), type: "straight", exercises: [blankExercise()] });
const blankDay = (kind) => ({ day_id: newId(), kind, label: kind === "rest" ? "Rest" : "", groups: kind === "rest" ? [] : [blankGroup()] });

const reindex = (sets) => sets.map((s, i) => ({ ...s, set_index: i }));

export default function ProgramBuilder({ program, tenantId, onDone, onDirtyChange }) {
  const [name, setName] = useState(program?.name ?? "");
  const [days, setDays] = useState(() =>
    (Array.isArray(program?.structure?.days) ? program.structure.days : []).map((d) => ({ ...d })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const nActive = program?.active_client_ids?.length ?? 0;

  // Tell parents (Programs page, client Program tab) so SPA nav can block leave.
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  // Browser tab close / refresh while dirty — SPA Links need the parent shield.
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // All edits funnel through one immutable day-updater; ids are never touched.
  const patchDay = (i, patch) => {
    setDirty(true);
    setDays((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  };

  function requestClose() {
    if (!dirty) return onDone();
    setConfirmLeave(true);
  }

  async function save() {
    setErr(null);
    if (!name.trim()) return setErr("Give the program a name.");
    if (days.length === 0) return setErr("Add at least one day.");
    for (const d of days) {
      if (d.kind !== "training") continue;
      const exs = (d.groups ?? []).flatMap((g) => g.exercises ?? []);
      if (exs.some((ex) => !ex.name.trim()))
        return setErr(`Every exercise needs a name (check "${d.label || "unnamed day"}").`);
      const badCardio = exs.find((ex) =>
        ex.type === "cardio" && (!ex.cardio?.modality?.trim() || (ex.cardio?.target_duration_min == null && ex.cardio?.target_distance == null)));
      if (badCardio)
        return setErr(`"${badCardio.name}" needs a modality and a duration or distance target (check "${d.label || "unnamed day"}").`);
    }
    setBusy(true);
    try {
      const structure = { ...(program?.structure ?? {}), days };
      if (program?.id) await updateProgram(program.id, { name: name.trim(), structure });
      else await createProgram({ tenantId, name: name.trim(), structure });
      setDirty(false);
      await onDone();
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="kicker">Programs</span>
          <h1 className="display mt-1 text-2xl">{program?.id ? "Edit program" : "New program"}</h1>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={requestClose} className="btn-ghost min-h-[44px] px-3 text-sm">Cancel</button>
          <button type="button" onClick={save} disabled={busy} className="btn-primary min-h-[44px] px-3 text-sm">{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
      {confirmLeave && (
        <div className="mt-3 rounded-xl border border-dashed border-ink/25 p-4 text-sm" role="alertdialog" aria-label="Discard unsaved changes">
          <p className="font-semibold">You have unsaved changes.</p>
          <p className="mt-1 text-xs opacity-60">Leave without saving and this edit is gone.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => { setConfirmLeave(false); onDone(); }} className="btn-primary min-h-[44px] px-3 text-sm">
              Discard changes
            </button>
            <button type="button" onClick={() => setConfirmLeave(false)} className="btn-ghost min-h-[44px] px-3 text-sm">
              Keep editing
            </button>
          </div>
        </div>
      )}

      {nActive > 0 && (
        <p className="mt-3 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-sm text-ink">
          {nActive} client{nActive > 1 ? "s are" : " is"} mid-cycle on this program — edits show up for them immediately.
          Removing days or exercises can strand a client’s current day; prefer duplicating if this is a one-off tweak.
        </p>
      )}
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}

      <label className="mt-4 block text-xs font-semibold uppercase tracking-wide opacity-60">
        Program name
        <input
          value={name}
          onChange={(e) => { setDirty(true); setName(e.target.value); }}
          placeholder="e.g. Push Pull Legs — Intermediate"
          className="mt-1 min-h-[44px] w-full rounded-xl border border-ink/15 px-3 py-2 text-sm font-normal normal-case tracking-normal opacity-100"
        />
      </label>

      {days.map((d, i) => (
        <DayEditor key={d.day_id} day={d} index={i}
          onPatch={(patch) => patchDay(i, patch)}
          onRemove={() => { setDirty(true); setDays((ds) => ds.filter((_, j) => j !== i)); }}
          onMove={(dir) => {
            setDirty(true);
            setDays((ds) => {
              const j = i + dir;
              if (j < 0 || j >= ds.length) return ds;
              const next = [...ds]; [next[i], next[j]] = [next[j], next[i]]; return next;
            });
          }} />
      ))}

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => { setDirty(true); setDays((ds) => [...ds, blankDay("training")]); }} className="btn-ghost min-h-[44px] px-3 text-sm">+ Training day</button>
        <button type="button" onClick={() => { setDirty(true); setDays((ds) => [...ds, blankDay("rest")]); }} className="btn-ghost min-h-[44px] px-3 text-sm">+ Rest day</button>
      </div>
    </div>
  );
}

function DayEditor({ day, index, onPatch, onRemove, onMove }) {
  const patchGroup = (gi, patch) =>
    onPatch({ groups: day.groups.map((g, j) => (j === gi ? { ...g, ...patch } : g)) });

  return (
    <div className="mt-4 rounded-xl border border-ink/10 p-4">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium opacity-50">Day {index + 1}</span>
        {day.kind === "rest" && <span className="text-xs uppercase opacity-40">rest</span>}
        <input value={day.label ?? ""} onChange={(e) => onPatch({ label: e.target.value })}
          placeholder={day.kind === "rest" ? "Rest" : "e.g. Push A — Chest & Shoulders"}
          className="flex-1 rounded-md border border-ink/15 px-2 py-1 text-sm" />
        <button onClick={() => onMove(-1)} className="px-1 text-xs opacity-50 hover:opacity-100">↑</button>
        <button onClick={() => onMove(1)} className="px-1 text-xs opacity-50 hover:opacity-100">↓</button>
        <button onClick={onRemove} className="px-1 text-xs text-danger opacity-70 hover:opacity-100">remove</button>
      </div>

      {day.kind === "training" && (
        <>
          {(day.groups ?? []).map((g, gi) => (
            <GroupEditor key={g.group_id} group={g}
              onPatch={(patch) => patchGroup(gi, patch)}
              onRemove={() => onPatch({ groups: day.groups.filter((_, j) => j !== gi) })} />
          ))}
          <button onClick={() => onPatch({ groups: [...(day.groups ?? []), blankGroup()] })}
            className="mt-2 text-xs underline opacity-60 hover:opacity-100">+ group</button>
        </>
      )}
    </div>
  );
}

function GroupEditor({ group, onPatch, onRemove }) {
  const patchEx = (ei, patch) =>
    onPatch({ exercises: group.exercises.map((ex, j) => (j === ei ? { ...ex, ...patch } : ex)) });

  return (
    <div className="mt-3 rounded-lg border border-ink/5 bg-ink/[0.015] p-3">
      <div className="flex items-center gap-2 text-xs">
        <select value={group.type ?? "straight"} onChange={(e) => onPatch({ type: e.target.value })}
          className="rounded-md border border-ink/15 px-1.5 py-1">
          <option value="straight">straight sets</option>
          <option value="superset">superset</option>
          <option value="circuit">circuit</option>
        </select>
        <button onClick={onRemove} className="ml-auto text-danger opacity-70 hover:opacity-100">remove group</button>
      </div>

      {(group.exercises ?? []).map((ex, ei) => (
        <ExerciseEditor key={ex.exercise_id} ex={ex}
          onPatch={(patch) => patchEx(ei, patch)}
          onRemove={() => onPatch({ exercises: group.exercises.filter((_, j) => j !== ei) })} />
      ))}
      <div className="mt-2 flex gap-3">
        <button onClick={() => onPatch({ exercises: [...(group.exercises ?? []), blankExercise()] })}
          className="text-xs underline opacity-60 hover:opacity-100">+ exercise</button>
        <button onClick={() => onPatch({ exercises: [...(group.exercises ?? []), blankCardioExercise()] })}
          className="text-xs underline opacity-60 hover:opacity-100">+ cardio</button>
      </div>
    </div>
  );
}

function ExerciseEditor({ ex, onPatch, onRemove }) {
  const patchSet = (si, patch) =>
    onPatch({ sets: ex.sets.map((s, j) => (j === si ? { ...s, ...patch } : s)) });
  const patchCardio = (patch) => onPatch({ cardio: { ...ex.cardio, ...patch } });

  if (ex.type === "cardio") {
    return (
      <div className="mt-2 rounded-md border border-ink/10 bg-paper p-2.5">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink opacity-70">cardio</span>
          <input value={ex.name} onChange={(e) => onPatch({ name: e.target.value })}
            placeholder="e.g. Incline walk finisher" className="flex-1 rounded-md border border-ink/15 px-2 py-1 text-sm" />
          <button onClick={onRemove} className="text-xs text-danger opacity-70 hover:opacity-100">×</button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
          <input value={ex.cardio?.modality ?? ""} onChange={(e) => patchCardio({ modality: e.target.value })}
            placeholder="modality (run, bike, incline walk...)" className="w-48 rounded-md border border-ink/15 px-2 py-1" />
          <input type="number" min="0" value={ex.cardio?.target_duration_min ?? ""}
            onChange={(e) => patchCardio({ target_duration_min: e.target.value === "" ? null : Number(e.target.value) })}
            placeholder="minutes" className="w-20 rounded-md border border-ink/15 px-2 py-1" />
          <input type="number" min="0" step="0.1" value={ex.cardio?.target_distance ?? ""}
            onChange={(e) => patchCardio({ target_distance: e.target.value === "" ? null : Number(e.target.value) })}
            placeholder="distance" className="w-20 rounded-md border border-ink/15 px-2 py-1" />
          <select value={ex.cardio?.target_distance_unit ?? "mi"} onChange={(e) => patchCardio({ target_distance_unit: e.target.value })}
            className="rounded-md border border-ink/15 px-1.5 py-1">
            <option value="mi">mi</option>
            <option value="km">km</option>
          </select>
          <input type="number" min="1" max="10" value={ex.cardio?.target_intensity_rpe ?? ""}
            onChange={(e) => patchCardio({ target_intensity_rpe: e.target.value === "" ? null : Number(e.target.value) })}
            placeholder="RPE 1-10" className="w-24 rounded-md border border-ink/15 px-2 py-1" />
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-ink/10 bg-paper p-2.5">
      <div className="flex items-center gap-2">
        <input value={ex.name} onChange={(e) => onPatch({ name: e.target.value })} placeholder="Exercise name"
          className="flex-1 rounded-md border border-ink/15 px-2 py-1 text-sm" />
        <input value={ex.demo_media_url ?? ""} onChange={(e) => onPatch({ demo_media_url: e.target.value || null })}
          placeholder="demo URL (optional)" className="w-44 rounded-md border border-ink/15 px-2 py-1 text-xs" />
        <button onClick={onRemove} className="text-xs text-danger opacity-70 hover:opacity-100">×</button>
      </div>
      {(ex.sets ?? []).map((s, si) => (
        <div key={si} className="mt-1.5 flex items-center gap-2 text-xs">
          <span className="w-10 opacity-50">Set {si + 1}</span>
          <input value={s.target_reps ?? ""} onChange={(e) => patchSet(si, { target_reps: e.target.value })}
            placeholder="reps (6-8)" className="w-20 rounded-md border border-ink/15 px-2 py-1" />
          <input type="number" step="0.5" value={s.target_weight ?? ""}
            onChange={(e) => patchSet(si, { target_weight: e.target.value === "" ? null : Number(e.target.value) })}
            placeholder="weight" className="w-20 rounded-md border border-ink/15 px-2 py-1" />
          <input value={s.notes ?? ""} onChange={(e) => patchSet(si, { notes: e.target.value || null })}
            placeholder="notes" className="flex-1 rounded-md border border-ink/15 px-2 py-1" />
          <button onClick={() => onPatch({ sets: reindex(ex.sets.filter((_, j) => j !== si)) })}
            className="text-danger opacity-70 hover:opacity-100">×</button>
        </div>
      ))}
      <button onClick={() => onPatch({ sets: reindex([...(ex.sets ?? []), blankSet()]) })}
        className="mt-1.5 text-xs underline opacity-60 hover:opacity-100">+ set</button>
    </div>
  );
}
