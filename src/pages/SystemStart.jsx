import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import AppGate from "../components/AppGate";
import YesNo from "../components/YesNo";
import { COACHING_APPLICATION_URL } from "../lib/systemMode";
import { SCREEN_QUESTIONS, startSystemCheckout } from "../lib/system";

// SELF-SERVE PLAN pre-pay screen: email + the eight health questions + medications. The
// server decides clear/flagged; this page only refuses to submit an incomplete screen.
// A flagged screen is never charged — the calm card below is the whole outcome.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD = "w-full rounded-xl border border-ink/15 px-3 py-2.5 text-sm";

export default function SystemStart() {
  const [email, setEmail] = useState("");
  const [answers, setAnswers] = useState({});
  const [medications, setMedications] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [flagged, setFlagged] = useState(false);
  // Hidden promo path for internal walkthroughs: /system/start?code=… — no field on the page.
  const [params] = useSearchParams();
  const promo = (params.get("code") || "").trim();

  const complete = EMAIL_RE.test(email.trim()) && SCREEN_QUESTIONS.every(([k]) => answers[k] === true || answers[k] === false);

  async function submit(e) {
    e.preventDefault();
    if (!complete || busy) return;
    setErr(null); setBusy(true);
    try {
      const r = await startSystemCheckout({ email: email.trim(), answers: { ...answers, medications }, promo });
      if (r?.flagged) { setFlagged(true); return; }
      if (r?.checkout_url) { window.location.assign(r.checkout_url); return; }
      throw new Error("no checkout link returned");
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  if (flagged) {
    return (
      <AppGate kicker="SELF-SERVE PLAN" title="Not this one. Coaching instead." actionTo="/system" actionLabel="Back">
        Something on your health screen means a self-serve plan is the wrong tool. You have not been charged.
        {COACHING_APPLICATION_URL ? (
          <a className="btn-ghost mt-4 inline-flex min-h-[44px] items-center" href={COACHING_APPLICATION_URL}>Apply for coaching</a>
        ) : null}
      </AppGate>
    );
  }

  return (
    <main className="mx-auto max-w-md px-5 py-12 md:py-16">
      <span className="kicker">SELF-SERVE PLAN</span>
      <h1 className="display mt-2 text-3xl">Health screen first.</h1>
      <p className="mt-3 text-sm opacity-80">Eight questions. Honest answers. A yes on any of them means this is not the right tool for you, and you are not charged.</p>
      <form onSubmit={submit} className="mt-6">
        <label className="mb-1 block text-sm font-medium" htmlFor="system-email">Email</label>
        <input id="system-email" type="email" autoComplete="email" inputMode="email" required className={FIELD}
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        <p className="mt-1 text-xs opacity-50">Your receipt, your intake link, and your sign-in all use this address.</p>
        <div className="mt-6">
          {SCREEN_QUESTIONS.map(([k, label]) => (
            <YesNo key={k} label={label} value={answers[k]} onChange={(v) => setAnswers((a) => ({ ...a, [k]: v }))} />
          ))}
        </div>
        <label className="mb-1 mt-5 block text-sm font-medium" htmlFor="system-meds">Medications</label>
        <input id="system-meds" type="text" className={FIELD} maxLength={400} value={medications}
          onChange={(e) => setMedications(e.target.value)} placeholder="Leave blank if none" />
        {err && <p className="mt-3 text-xs text-danger">{err}</p>}
        <button type="submit" disabled={!complete || busy} className="btn-primary mt-6 block w-full py-3 text-center text-base disabled:opacity-40">
          {busy ? "One moment…" : "Continue to payment"}
        </button>
        <p className="mt-3 text-xs opacity-50">Payment is handled by Stripe.</p>
      </form>
      <p className="mt-8 text-xs opacity-50"><Link to="/system" className="underline">Back</Link></p>
    </main>
  );
}
