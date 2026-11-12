import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import AppGate from "../components/AppGate";
import { peekIntake, submitScreen } from "../lib/intake";
import { PARQ_QUESTIONS } from "../content/parqQuestions";
import { LEGAL_DOCS, LEGAL_VERSION } from "../content/legalPack";
import { copyFor } from "../lib/systemMode";
import {
  answerParq, anyYes, buildScreenAnswers, clearProgress, emptyProgress, firstName, loadProgress,
  NOTES_STEP, PARQ_COUNT, parqComplete, resumeStep, saveProgress, SIGN_STEP, TOTAL_STEPS,
} from "../lib/screenFlow";

// /screen?token=… — health screen + waiver only, for clients who are already training.
// Built for a phone and a thumb: one question per screen, a tap answers and moves on,
// progress saves after every tap, one tap signs. The questions and the legal text are the
// same words as the full intake (src/content/parqQuestions.js, legalPack.js).
// Any yes, or anything written under medical notes, goes to the coach for review.

const storage = typeof window !== "undefined" ? window.localStorage : null;

const LIVE_API = { peek: peekIntake, submit: submitScreen };

// `api` is only ever swapped by the fixture preview (/__preview/screen), which never
// reaches the network. Production always uses the live intake-submit calls.
export default function Screen({ api = LIVE_API, fixedToken = null }) {
  const [params] = useSearchParams();
  const token = fixedToken ?? params.get("token");
  const [peek, setPeek] = useState({ state: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!token) return;
    let live = true;
    setPeek({ state: "loading" });
    api.peek(token)
      .then((r) => { if (live) setPeek({ state: r?.status ?? "invalid", name: r?.display_name ?? "" }); })
      .catch(() => { if (live) setPeek({ state: "failed" }); });
    return () => { live = false; };
  }, [token, reload, api]);

  if (!token || peek.state === "invalid") {
    return (
      <AppGate title="This link isn’t valid" kicker="HEALTH SCREEN" actionTo="/" actionLabel="Go home" secondaryTo="/login" secondaryLabel="Sign in">
        Ask your coach for a fresh link.
      </AppGate>
    );
  }
  if (peek.state === "expired") {
    return (
      <AppGate title="This link has expired" kicker="HEALTH SCREEN" actionTo="/client" actionLabel="Open the app">
        Links last 14 days. Message your coach and they’ll send a new one.
      </AppGate>
    );
  }
  if (peek.state === "submitted") {
    return <Done kicker="On file" title="Already done." body="Your health screen and waiver are on file. Nothing else needed." />;
  }
  if (peek.state === "failed") {
    return (
      <Shell>
        <p className="text-sm text-danger" role="alert">Couldn’t open your form. Check your connection and try again.</p>
        <button type="button" className="btn-primary mt-4 min-h-[48px] w-full" onClick={() => setReload((n) => n + 1)}>Try again</button>
      </Shell>
    );
  }
  if (peek.state === "loading") return <Shell><p className="text-sm opacity-60">Opening your form…</p></Shell>;

  return <ScreenFlow token={token} name={peek.name} submit={api.submit} />;
}

function ScreenFlow({ token, name, submit }) {
  const [saved] = useState(() => loadProgress(storage, token));
  const [p, setP] = useState(() => (saved ? { ...saved, step: resumeStep(saved) } : emptyProgress()));
  const resumed = parqCountStarted(saved);
  const [result, setResult] = useState(null);

  useEffect(() => { if (!result) saveProgress(storage, token, p); }, [p, token, result]);

  if (result) {
    const review = result.status === "screen_review";
    return review
      ? <Done kicker="Received" title="Done. Your coach will review it." body="Something you answered needs a look from your coach. They will reach out before anything changes. If you have chest pain, dizziness, or feel unwell, stop and contact a clinician." />
      : <Done kicker="On file" title="Done. Thank you." body="Your health screen and waiver are on file. Nothing about your program changes." />;
  }

  const step = p.step;
  const back = () => setP((s) => ({ ...s, step: Math.max(0, s.step - 1) }));
  const greet = firstName(name);

  return (
    <Shell>
      <Progress step={step} onBack={step > 0 ? back : null} />
      {step === 0 && (
        <p className="mt-5 text-sm opacity-75">
          {greet ? `${greet}, ` : ""}eight yes-or-no questions and one signature. About two minutes. Your answers save as you go.
        </p>
      )}
      {resumed && step > 0 && step < PARQ_COUNT && (
        <p className="mt-5 text-xs opacity-60">Picked up where you left off.</p>
      )}
      {step < PARQ_COUNT && (
        <Question index={step} value={p.parq[PARQ_QUESTIONS[step].key]} onAnswer={(v) => setP((s) => answerParq(s, step, v))} />
      )}
      {step === NOTES_STEP && <Notes p={p} setP={setP} />}
      {step === SIGN_STEP && <Sign p={p} name={name} token={token} submit={submit} onDone={(r) => { clearProgress(storage, token); setResult(r); }} />}
    </Shell>
  );
}

const parqCountStarted = (p) => !!p && Object.keys(p.parq ?? {}).length > 0;

function Shell({ children }) {
  return (
    <main className="mx-auto flex max-w-md flex-col px-5 pb-10 pt-6">
      <span className="kicker">Health screen + waiver</span>
      {children}
    </main>
  );
}

function Progress({ step, onBack }) {
  const pct = Math.round(((step + 1) / TOTAL_STEPS) * 100);
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-xs opacity-60">
        {onBack
          ? <button type="button" onClick={onBack} className="-ml-2 min-h-[44px] px-2">← Back</button>
          : <span />}
        <span>{step + 1} of {TOTAL_STEPS}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
        <div className="h-full bg-ink transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Question({ index, value, onAnswer }) {
  const q = PARQ_QUESTIONS[index];
  return (
    <section className="mt-6" aria-live="polite">
      <p className="text-xs uppercase tracking-wide opacity-50">Question {index + 1} of {PARQ_COUNT}</p>
      <h1 className="display mt-2 text-2xl leading-tight">{q.label}</h1>
      <div className="mt-8 grid grid-cols-2 gap-3">
        {[["No", false], ["Yes", true]].map(([t, v]) => (
          <button key={t} type="button" onClick={() => onAnswer(v)} aria-pressed={value === v}
            className={`min-h-[64px] rounded-2xl text-lg font-semibold transition ${value === v ? "bg-ink text-paper" : "border border-ink/20 active:bg-ink/[0.06]"}`}>
            {t}
          </button>
        ))}
      </div>
    </section>
  );
}

function Notes({ p, setP }) {
  const set = (k, v) => setP((s) => ({ ...s, [k]: v }));
  const medsReady = p.hasMeds === false || (p.hasMeds === true && p.medications.trim());
  return (
    <section className="mt-6">
      {anyYes(p) && (
        <p className="rounded-xl border border-ink/15 bg-ink/[0.03] px-3 py-2 text-xs">
          You answered yes to at least one question. That’s fine. Your coach reviews it personally.
        </p>
      )}
      <h1 className="display mt-4 text-2xl leading-tight">{copyFor("coached", "intake_meds_label")}</h1>
      <p className="mt-1 text-xs opacity-60">Medications, conditions, doctor guidance.</p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {[["No", false], ["Yes", true]].map(([t, v]) => (
          <button key={t} type="button" onClick={() => set("hasMeds", v)} aria-pressed={p.hasMeds === v}
            className={`min-h-[56px] rounded-2xl text-base font-semibold ${p.hasMeds === v ? "bg-ink text-paper" : "border border-ink/20"}`}>
            {t}
          </button>
        ))}
      </div>
      {p.hasMeds === true && (
        <label className="mt-4 block text-sm font-medium">
          What should your coach know?
          <textarea rows={3} value={p.medications} onChange={(e) => set("medications", e.target.value)}
            className="mt-1 w-full rounded-xl border border-ink/15 px-3 py-2.5 text-base" placeholder="e.g. lisinopril 10mg daily" />
          <span className="mt-1 block text-xs font-normal opacity-55">{copyFor("coached", "intake_meds_hint")}</span>
        </label>
      )}
      <label className="mt-6 block text-sm font-medium">
        Injuries or surgeries, with dates <span className="font-normal opacity-50">(optional)</span>
        <textarea rows={2} value={p.injury_notes} onChange={(e) => set("injury_notes", e.target.value)}
          className="mt-1 w-full rounded-xl border border-ink/15 px-3 py-2.5 text-base" placeholder="e.g. knee surgery, March 2025 — or leave blank" />
      </label>
      <div className="mt-6">
        <button type="button" disabled={!medsReady} onClick={() => setP((s) => ({ ...s, step: SIGN_STEP }))}
          className="btn-primary min-h-[56px] w-full text-base disabled:opacity-40">
          Next
        </button>
      </div>
    </section>
  );
}

function Sign({ p, name, token, submit, onDone }) {
  const [sig, setSig] = useState(name || "");
  const [editing, setEditing] = useState(!name);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const today = useMemo(() => new Date().toLocaleDateString(), []);
  const ready = parqComplete(p) && sig.trim().length > 1;

  async function sign() {
    if (!ready || busy) return;
    setErr(null); setBusy(true);
    try { onDone(await submit({ token, answers: buildScreenAnswers(p, sig) })); }
    catch (e) { setErr(e.message || "Couldn’t save. Your answers are still here — try again."); }
    finally { setBusy(false); }
  }

  return (
    <section className="mt-6">
      <h1 className="display text-2xl leading-tight">Sign the waiver.</h1>
      <p className="mt-1 text-xs opacity-60">Version {LEGAL_VERSION}. Tap any document to read it in full.</p>
      <ul className="mt-4 divide-y divide-ink/10 rounded-2xl border border-ink/10">
        {LEGAL_DOCS.map((doc) => (
          <li key={doc.id}>
            <button type="button" onClick={() => setOpen(open === doc.id ? null : doc.id)} aria-expanded={open === doc.id}
              className="flex min-h-[52px] w-full items-center justify-between gap-3 px-3 py-2 text-left">
              <span>
                <span className="block text-sm font-semibold">{doc.title}</span>
                <span className="block text-xs opacity-55">{doc.summary}</span>
              </span>
              <span className="shrink-0 text-xs opacity-50">{open === doc.id ? "Hide" : "Read"}</span>
            </button>
            {open === doc.id && (
              <pre className="mx-3 mb-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl bg-ink/[0.03] p-3 text-xs leading-relaxed opacity-80">{doc.body}</pre>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-5 text-sm">
        {editing ? (
          <label className="block font-medium">
            Your full legal name
            <input value={sig} onChange={(e) => setSig(e.target.value)} autoComplete="name" placeholder="Full name"
              className="mt-1 w-full rounded-xl border border-ink/15 px-3 py-2.5 text-base" />
          </label>
        ) : (
          <p>
            Signing as <strong>{sig}</strong>.{" "}
            <button type="button" onClick={() => setEditing(true)} className="min-h-[44px] underline underline-offset-2 opacity-70">Not your full legal name?</button>
          </p>
        )}
      </div>

      {err && <p className="mt-3 text-sm text-danger" role="alert">{err}</p>}
      <div className="mt-5">
        <button type="button" onClick={sign} disabled={!ready || busy} className="btn-primary min-h-[56px] w-full text-base disabled:opacity-40">
          {busy ? "Saving…" : "Agree and sign"}
        </button>
        <p className="mt-2 text-center text-xs opacity-55">
          Tapping Agree and sign is your electronic signature on all {LEGAL_DOCS.length} documents above, as {sig.trim() || "the name above"}, on {today}.
        </p>
      </div>
    </section>
  );
}

function Done({ kicker, title, body }) {
  return (
    <main className="mx-auto max-w-md px-5 py-16">
      <span className="kicker">{kicker}</span>
      <h1 className="display mt-2 text-3xl">{title}</h1>
      <p className="mt-3 text-sm opacity-80">{body}</p>
      <p className="mt-4 text-xs opacity-50">This is fitness coaching, not medical care. If symptoms arise, stop and contact a clinician.</p>
      <a href="/client" className="btn-primary mt-6 inline-flex min-h-[48px] items-center">Back to the app</a>
    </main>
  );
}
