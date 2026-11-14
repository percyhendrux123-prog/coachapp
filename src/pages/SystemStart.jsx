import { useState } from "react";
import { Link } from "react-router-dom";
import AppGate from "../components/AppGate";
import { startSystemSignup } from "../lib/system";

// SELF-SERVE PLAN signup (P33: free). Email only. The health screen is asked once, inside the
// intake the email links to. The page says the same thing for a new address and one that
// already has a plan, because the server does.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELD = "w-full rounded-xl border border-ink/15 px-3 py-2.5 text-sm";

export default function SystemStart() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [state, setState] = useState("form"); // form | sent | paused

  const complete = EMAIL_RE.test(email.trim());

  async function submit(e) {
    e.preventDefault();
    if (!complete || busy) return;
    setErr(null); setBusy(true);
    try {
      const r = await startSystemSignup({ email: email.trim() });
      if (r?.paused) { setState("paused"); return; }
      if (r?.ok) { setState("sent"); return; }
      throw new Error("Something went wrong. Try again in a few minutes.");
    } catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  }

  if (state === "sent") return <SignupSent />;
  if (state === "paused") return <SignupPaused />;

  return (
    <main className="mx-auto max-w-md px-5 py-12 md:py-16">
      <span className="kicker">SELF-SERVE PLAN</span>
      <h1 className="display mt-2 text-3xl">Start with your email.</h1>
      <p className="mt-3 text-sm opacity-80">We email you a link to a short intake: a health screen, your numbers, your training days. Your week and your targets are built from what you enter.</p>
      <form onSubmit={submit} className="mt-6">
        <label className="mb-1 block text-sm font-medium" htmlFor="system-email">Email</label>
        <input id="system-email" type="email" autoComplete="email" inputMode="email" required className={FIELD}
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        <p className="mt-1 text-xs opacity-50">Your intake link and your sign-in both use this address.</p>
        {err && <p className="mt-3 text-xs text-danger">{err}</p>}
        <button type="submit" disabled={!complete || busy} className="btn-primary mt-6 block w-full py-3 text-center text-base disabled:opacity-40">
          {busy ? "One moment…" : "Email me my link"}
        </button>
      </form>
      <p className="mt-8 text-xs opacity-50"><Link to="/system" className="underline">Back</Link></p>
    </main>
  );
}

export function SignupSent() {
  return (
    <AppGate kicker="SELF-SERVE PLAN" title="Check your email." actionTo="/system" actionLabel="Back">
      If that address can get a plan, a link is on its way. It can take a minute; check spam if it is not there. One email per address per day.
    </AppGate>
  );
}

export function SignupPaused() {
  return (
    <AppGate kicker="SELF-SERVE PLAN" title="Signups are paused for today." actionTo="/system" actionLabel="Back">
      This app has reached its daily limit for new signups. Try again tomorrow.
    </AppGate>
  );
}
