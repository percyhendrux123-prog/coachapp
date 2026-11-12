import { useEffect, useState } from "react";
import {
  getIntakeRawMetrics, getConfirmedMetrics, readRawMetrics,
  confirmBodyMetrics, inToFtIn, ftInToIn,
} from "../lib/bodyMetrics";

// Coach reviews raw intake strings, confirms sex/age/height/weight/goal.
// Twin-facts rule: absent intake ≠ unreadable; not_asked is a form gap.
export default function BodyMetricsConfirm({ clientId, onSaved }) {
  const [raw, setRaw] = useState(undefined);
  const [confirmed, setConfirmed] = useState(undefined);
  const [form, setForm] = useState({
    age: "", sex: "", heightFt: "", heightIn: "", weightLb: "", goalWeightLb: "",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [r, c] = await Promise.all([
          getIntakeRawMetrics(clientId),
          getConfirmedMetrics(clientId),
        ]);
        if (cancel) return;
        setRaw(r);
        setConfirmed(c);
        const parsed = readRawMetrics(r);
        const ftIn = inToFtIn(c?.height_in ?? parsed.height_in?.value);
        setForm({
          age: c?.age ?? parsed.age?.value ?? "",
          sex: c?.sex ?? parsed.sex?.value ?? "",
          heightFt: ftIn.ft === "" ? "" : String(ftIn.ft),
          heightIn: ftIn.in === "" ? "" : String(ftIn.in),
          weightLb: c?.weight_lb ?? parsed.weight_lb?.value ?? "",
          goalWeightLb: c?.goal_weight_lb ?? parsed.goal_weight_lb?.value ?? "",
        });
      } catch (e) {
        if (!cancel) setErr(e.message);
      }
    })();
    return () => { cancel = true; };
  }, [clientId]);

  if (err && !confirmed) return <p className="text-sm text-danger">{err}</p>;
  if (raw === undefined || confirmed === undefined) {
    return <p className="text-sm opacity-60">Loading body metrics…</p>;
  }

  const parsed = readRawMetrics(raw);

  async function save(e) {
    e.preventDefault();
    setBusy(true); setMsg(null); setErr(null);
    try {
      const heightIn = ftInToIn(form.heightFt, form.heightIn);
      const res = await confirmBodyMetrics(clientId, {
        age: form.age,
        sex: form.sex,
        heightIn,
        weightLb: form.weightLb,
        goalWeightLb: form.goalWeightLb,
      });
      if (res?.status === "refused") {
        setErr(res.reason || "Confirmation refused — check required fields.");
      } else {
        setMsg("Body metrics confirmed.");
        setConfirmed(await getConfirmedMetrics(clientId));
        onSaved?.();
      }
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="section-title">Body metrics</h3>
        <p className="mt-1 text-xs opacity-60">
          Confirm before trusting auto-macros. Raw intake text is shown as typed — nothing invented.
        </p>
      </div>

      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <RawField label="Age (raw)" value={raw?.age_raw} state={parsed.age} />
        <RawField label="Height (raw)" value={raw?.height_raw} state={parsed.height_in} />
        <RawField label="Weight (raw)" value={raw?.weight_raw} state={parsed.weight_lb} />
        <RawField label="Goal weight (raw)" value={raw?.goal_weight_raw} state={parsed.goal_weight_lb} />
        <RawField
          label="Sex"
          value={raw?.sex ? String(raw.sex) : null}
          state={parsed.sex}
        />
      </div>

      <form onSubmit={save} className="glass space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="opacity-60">Sex *</span>
            <select
              required
              value={form.sex}
              onChange={(e) => setForm((s) => ({ ...s, sex: e.target.value }))}
              className="mt-1 w-full rounded-xl border border-ink/15 px-3 py-2 text-sm"
            >
              <option value="" disabled>Choose…</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="opacity-60">Age *</span>
            <input
              required type="number" min={14} max={90} value={form.age}
              onChange={(e) => setForm((s) => ({ ...s, age: e.target.value }))}
              className="mt-1 w-full rounded-xl border border-ink/15 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="opacity-60">Height (ft)</span>
            <input
              type="number" min={3} max={8} value={form.heightFt}
              onChange={(e) => setForm((s) => ({ ...s, heightFt: e.target.value }))}
              className="mt-1 w-full rounded-xl border border-ink/15 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="opacity-60">Height (in)</span>
            <input
              type="number" min={0} max={11.9} step={0.1} value={form.heightIn}
              onChange={(e) => setForm((s) => ({ ...s, heightIn: e.target.value }))}
              className="mt-1 w-full rounded-xl border border-ink/15 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="opacity-60">Weight (lb) *</span>
            <input
              required type="number" min={70} max={550} step={0.1} value={form.weightLb}
              onChange={(e) => setForm((s) => ({ ...s, weightLb: e.target.value }))}
              className="mt-1 w-full rounded-xl border border-ink/15 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="opacity-60">Goal weight (lb) *</span>
            <input
              required type="number" min={70} max={550} step={0.1} value={form.goalWeightLb}
              onChange={(e) => setForm((s) => ({ ...s, goalWeightLb: e.target.value }))}
              className="mt-1 w-full rounded-xl border border-ink/15 px-3 py-2 text-sm"
            />
          </label>
        </div>
        {err && <p className="text-sm text-danger">{err}</p>}
        {msg && <p className="text-sm text-success">{msg}</p>}
        <button type="submit" disabled={busy} className="btn-primary disabled:opacity-50">
          {busy ? "Saving…" : "Confirm body metrics"}
        </button>
      </form>
    </div>
  );
}

function RawField({ label, value, state }) {
  const st = state?.state || "absent";
  let note = "";
  if (st === "not_asked") note = "Not on the form (platform gap).";
  else if (st === "absent") note = "Not provided.";
  else if (st === "unreadable") note = state.reason || "Unreadable.";
  else if (st === "ambiguous") note = "Ambiguous — coach must pick.";
  else if (st === "suggested") note = state.basis || "Suggested from raw.";
  return (
    <div className="rounded-xl border border-ink/10 px-3 py-2">
      <p className="font-semibold opacity-50">{label}</p>
      <p className="mt-0.5 font-mono text-sm">{value?.trim() ? value : "—"}</p>
      <p className="mt-0.5 opacity-50">{note}</p>
    </div>
  );
}
