import { useEffect, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import AppGate from "../components/AppGate";
import { redeemCoachingSession } from "../lib/coaching";
import { neutralBrand } from "../lib/whiteLabelPolicy";

// Stripe's coaching Payment Links return here after payment (/welcome?session_id=…). The page
// redeems the session server-side and hands over the intake link. Four truths, four renderings —
// never a claimed email that did not send. Twin of SystemWelcome; here "your coach" is correct.
const RETRY_MS = 3000, MAX_RETRIES = 5;

export default function CoachingWelcome() {
  const [params] = useSearchParams();
  const sessionId = params.get("session_id");
  const [state, setState] = useState(sessionId ? "redeeming" : "failed");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(sessionId ? null : "No payment session in this link.");
  const tries = useRef(0);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    async function go() {
      try {
        const r = await redeemCoachingSession(sessionId);
        if (cancelled) return;
        setData(r); setState("done");
      } catch (ex) {
        if (cancelled) return;
        const pending = /not completed/i.test(ex.message);
        if (pending && tries.current < MAX_RETRIES) { tries.current += 1; setState("pending"); setTimeout(go, RETRY_MS); return; }
        setErr(pending ? "Stripe has not confirmed this payment yet. Refresh in a minute. Your link is also being emailed." : ex.message);
        setState("failed");
      }
    }
    go();
    return () => { cancelled = true; };
  }, [sessionId]);

  if (state === "redeeming" || state === "pending") {
    return <AppGate kicker={neutralBrand().appName} title="Confirming your payment…">{state === "pending" ? "Stripe is still finishing. Checking again." : "One moment."}</AppGate>;
  }
  if (state === "failed") {
    return (
      <AppGate kicker={neutralBrand().appName} title="We could not finish this." actionTo="/" actionLabel="Back">
        {err}
        <span className="mt-3 block text-xs opacity-60">If you paid and see this, contact your coach using the details on your Stripe receipt.</span>
      </AppGate>
    );
  }
  return (
    <main className="mx-auto max-w-md px-5 py-16">
      <span className="kicker">{neutralBrand().appName}</span>
      <h1 className="display mt-2 text-3xl">You're in.</h1>
      <p className="mt-3 text-sm opacity-80">Next is a short intake. Your first week and your targets are built from what you enter. About eight minutes.</p>
      <Link to={data.intake_path} className="btn-primary mt-6 block py-3 text-center text-base">Open your intake</Link>
      {data.email_sent
        ? <p className="mt-3 text-xs opacity-60">We also emailed this link to {data.email}. Check spam if it is not there.</p>
        : <p className="mt-3 text-xs text-danger">The email did not send{data.email_error ? `: ${data.email_error}` : ""}. Use the button above.</p>}
      <p className="mt-3 text-xs opacity-60">Your coach reads every intake before anything is built. You hear from your coach, then your program lands in the app.</p>
      {data.account === "failed" && (
        <p className="mt-2 text-xs text-danger">Your sign-in account could not be prepared. Finish the intake, then use the sign-in code at /login; if that fails, reply to your receipt email.</p>
      )}
    </main>
  );
}
