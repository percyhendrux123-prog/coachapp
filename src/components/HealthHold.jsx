import { useCallback, useEffect, useState } from "react";
import { HEALTH_STATEMENT_LINES, HEALTH_STATEMENT_VERSION, canConfirm, flagItems } from "../lib/healthHold";
import { W4, W7_BUILT, W8_REMINDER, W10_BANNER, blockedCopy } from "../content/healthHoldCopy";
import { confirmMyClearance, getMyHealthHold } from "../lib/healthHoldApi";

// P33 — the hold card at the top of Program for a self-serve person whose latest health
// screen has a yes on it. Doctor-first: the approved W4 text, three boxes, a typed name, one
// button. Not eligible: W5 or W6, no controls. A failed read is a failed read, never "no hold".
// An existing plan is left exactly as it is (D4); W10 sits above it.
export default function HealthHold({ onBuilt }) {
  const [hold, setHold] = useState(undefined);
  const [failed, setFailed] = useState(false);
  const [checks, setChecks] = useState(() => HEALTH_STATEMENT_LINES.map(() => false));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [built, setBuilt] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    return getMyHealthHold().then((h) => setHold(h)).catch(() => { setFailed(true); setHold(null); });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function submit(e) {
    e.preventDefault();
    if (busy || !hold || !canConfirm({ checks, name })) return;
    setErr(null); setBusy(true);
    try {
      await confirmMyClearance({ intake_id: hold.intake_id, seen_flags: hold.flags, statement_version: HEALTH_STATEMENT_VERSION, typed_name: name });
      setBuilt(true);
      onBuilt?.();
    } catch (ex) {
      setErr(ex.message);
      // The screen may have changed (stale) or a build is already running: read it again.
      load();
    } finally { setBusy(false); }
  }

  return (
    <HealthHoldView hold={hold} failed={failed} onRetry={load} checks={checks}
      onCheck={(i, v) => setChecks((c) => c.map((x, k) => (k === i ? v : x)))}
      name={name} onName={setName} busy={busy} err={err} built={built} onSubmit={submit} />
  );
}

// Pure view, rendered directly by the tests.
export function HealthHoldView({ hold, failed, onRetry, checks = HEALTH_STATEMENT_LINES.map(() => false), onCheck, name = "", onName, busy = false, err = null, built = false, onSubmit }) {
  if (failed) {
    return (
      <section className="glass mb-6 p-5" role="alert" data-health-hold="failed">
        <p className="text-sm font-semibold">Could not load your health screen</p>
        <p className="mt-2 text-xs opacity-60">This is a failed read, not &ldquo;nothing on hold.&rdquo; Refresh or try again.</p>
        <button type="button" onClick={onRetry} className="btn-ghost mt-3 min-h-[44px] px-4 text-sm">Retry</button>
      </section>
    );
  }
  if (hold === undefined) return null; // loading: the program below shows its own loading line
  if (built) {
    return (
      <section className="glass mb-6 p-5" data-health-hold="built">
        <p className="text-sm">{W7_BUILT}</p>
      </section>
    );
  }
  if (!hold || hold.state === "none") return null;

  const banner = hold.has_live_plan
    ? <p className="mb-3 rounded-lg border border-danger/30 bg-danger/[0.04] px-3 py-2 text-sm" data-health-hold="banner">{W10_BANNER}</p>
    : null;

  if (hold.state === "blocked") {
    const c = blockedCopy(hold.reason);
    return (
      <div className="mb-6">
        {banner}
        <section className="glass p-5" data-health-hold="blocked">
          <span className="kicker">{c.kicker}</span>
          <h2 className="display mt-1 text-xl">{c.title}</h2>
          {c.body.map((p) => <p key={p} className="mt-3 text-sm opacity-80">{p}</p>)}
          <p className="mt-4 text-xs opacity-50">{W8_REMINDER}</p>
        </section>
      </div>
    );
  }

  // needs_clearance, or building (confirmed earlier, the build did not finish: confirm again
  // and the same confirmation is reused).
  const ready = canConfirm({ checks, name });
  return (
    <div className="mb-6">
      {banner}
      <section className="glass p-5" data-health-hold="needs_clearance">
        <span className="kicker">{W4.kicker}</span>
        <h2 className="display mt-1 text-xl">{W4.title}</h2>
        <p className="mt-3 text-sm opacity-80">{W4.lead}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {flagItems(hold.flags).map((it) => <li key={it}>{it}</li>)}
        </ul>
        {W4.body.map((p) => <p key={p} className="mt-3 text-sm opacity-80">{p}</p>)}

        <form onSubmit={onSubmit} className="mt-5 border-t border-ink/10 pt-4">
          <h3 className="text-sm font-semibold">{W4.section}</h3>
          {HEALTH_STATEMENT_LINES.map((line, i) => (
            <label key={line} className="mt-3 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={!!checks[i]} onChange={(e) => onCheck?.(i, e.target.checked)} />
              <span>{line}</span>
            </label>
          ))}
          <label htmlFor="health-hold-name" className="mb-1 mt-4 block text-sm font-medium">{W4.name_label}</label>
          <input id="health-hold-name" autoComplete="name" maxLength={120} value={name} onChange={(e) => onName?.(e.target.value)}
            className="w-full rounded-xl border border-ink/15 px-3 py-2.5 text-sm" />
          {err && <p className="mt-3 text-xs text-danger">{err}</p>}
          <button type="submit" disabled={!ready || busy} className="btn-primary mt-4 block w-full py-3 text-center text-base disabled:opacity-40">
            {busy ? "One moment…" : W4.button}
          </button>
          <p className="mt-2 text-xs opacity-60">{W4.under_button}</p>
        </form>
        <p className="mt-4 text-xs opacity-50">{W8_REMINDER}</p>
      </section>
    </div>
  );
}
