import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getPublishedChallenge, getStandards, getMyRun, enroll } from "../lib/participant";
import ChallengeRun from "../components/ChallengeRun";
import ChallengeOverview from "../components/ChallengeOverview";
import AppGate from "../components/AppGate";

// Public challenge funnel: view → (sign in) → enroll (free) → daily run.
// Three reads, each with its own failed state — a failed read never renders as
// "not published" or "not enrolled".
export default function Challenge() {
  const { slug } = useParams();
  const { user, requestEmailCode, verifyEmailCode } = useAuth();
  const [challenge, setChallenge] = useState(null);
  const [standards, setStandards] = useState([]);
  const [state, setState] = useState("loading");   // loading | failed | not-found | ready
  const [attempt, setAttempt] = useState(0);
  const [run, setRun] = useState(null);
  const [runState, setRunState] = useState("idle"); // idle | loading | failed | ready

  useEffect(() => {
    let active = true;
    (async () => {
      setState("loading");
      try {
        const ch = await getPublishedChallenge(slug);
        if (!active) return;
        if (!ch) return setState("not-found");
        setChallenge(ch);
        setStandards(await getStandards(ch.id));
        if (active) setState("ready");
      } catch { if (active) setState("failed"); }
    })();
    return () => { active = false; };
  }, [slug, attempt]);

  const loadRun = useCallback(async ({ initial = false } = {}) => {
    if (!challenge || !user) return;
    if (initial) setRunState("loading");
    try { setRun(await getMyRun(challenge.id)); setRunState("ready"); }
    catch { setRunState("failed"); }
  }, [challenge, user]);

  useEffect(() => {
    if (challenge && user) loadRun({ initial: true });
    else { setRun(null); setRunState("idle"); }
  }, [challenge, user, loadRun]);

  const refetchRun = useCallback(() => loadRun(), [loadRun]);

  if (state === "loading") {
    return <AppGate title="Loading challenge…" kicker="CHALLENGE">Pulling the standards and schedule.</AppGate>;
  }
  if (state === "failed") {
    return (
      <AppGate title="Couldn’t load this challenge" kicker="CHALLENGE" secondaryTo="/" secondaryLabel="Go home">
        <p>This is a failed read, not a missing challenge. Check your connection and try again.</p>
        <button type="button" onClick={() => setAttempt((n) => n + 1)} className="btn-primary mt-4 min-h-[44px] px-4">Try again</button>
      </AppGate>
    );
  }
  if (state === "not-found") {
    return (
      <AppGate
        title="This challenge isn’t available"
        kicker="CHALLENGE"
        actionTo="/"
        actionLabel="Go home"
        secondaryTo="/login"
        secondaryLabel="Sign in"
      >
        The link may be wrong, expired, or not published yet. Ask your coach for a fresh invite if you were expecting one.
      </AppGate>
    );
  }

  if (user && runState === "loading") {
    return (
      <Wrap>
        <p className="kicker">{challenge.title}</p>
        <p className="mt-4 text-sm opacity-60">Checking your enrollment…</p>
      </Wrap>
    );
  }
  if (user && runState === "failed") {
    return (
      <Wrap>
        <p className="kicker">{challenge.title}</p>
        <div className="mt-4 rounded-xl border border-dashed border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger">
          <p>Could not check your enrollment — failed read, not “not enrolled.”</p>
          <button type="button" onClick={() => loadRun({ initial: true })} className="btn-ghost mt-3 min-h-[44px] px-4">Try again</button>
        </div>
      </Wrap>
    );
  }

  // Enrolled → the daily run experience.
  if (user && run) {
    return (
      <Wrap>
        <p className="kicker">{challenge.title}</p>
        <ChallengeRun challenge={challenge} standards={standards} run={run} onRunChange={refetchRun} />
      </Wrap>
    );
  }

  // Overview + call to action.
  return (
    <Wrap>
      <ChallengeOverview challenge={challenge} standards={standards} footer={`Free · ${challenge.duration_days} days`}>
        {user ? <StartButton challenge={challenge} onEnrolled={setRun} /> : (
          <SignInToStart requestEmailCode={requestEmailCode} verifyEmailCode={verifyEmailCode} />
        )}
      </ChallengeOverview>
    </Wrap>
  );
}

function StartButton({ challenge, onEnrolled }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function start() {
    setErr(null); setBusy(true);
    try { await enroll(challenge.id); onEnrolled(await getMyRun(challenge.id)); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <>
      <button onClick={start} disabled={busy} className="btn-primary min-h-[44px] w-full py-3 text-base">
        {busy ? "Starting…" : "Start the challenge — free"}
      </button>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </>
  );
}

function SignInToStart({ requestEmailCode, verifyEmailCode }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState(null);
  async function submit(e) {
    e.preventDefault(); setErr(null);
    const { error } = await requestEmailCode(email.trim());
    if (error) setErr(error.message); else setSent(true);
  }
  async function confirm(e) {
    e.preventDefault(); setErr(null);
    try {
      const { error } = await verifyEmailCode(email, code);
      if (error) setErr(error.message);
    } catch (error) {
      setErr(error.message);
    }
  }
  if (sent) {
    return (
      <form onSubmit={confirm} className="space-y-3">
        <p className="text-sm opacity-70">Enter the code from your email here. Keep this app open.</p>
        <label className="block text-sm font-medium">
          Email code
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            maxLength={12}
            id="challenge-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="12345678"
            className="mt-1 min-h-[44px] w-full rounded-xl border border-ink/15 px-3 py-2.5 text-center text-xl tracking-[0.3em]"
          />
        </label>
        <button type="submit" className="btn-primary min-h-[44px] w-full py-3 text-base">Continue</button>
        {err && <p className="text-sm text-danger">{err}</p>}
      </form>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs leading-relaxed opacity-60">
        If this coaching app is on your Home Screen, open it before continuing. Entering the emailed code here keeps that app signed in.
      </p>
      <label className="block text-sm font-medium">
        Email
        <input
          type="email"
          required
          id="challenge-email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          className="mt-1 min-h-[44px] w-full rounded-xl border border-ink/15 px-3 py-2.5 text-sm font-normal"
        />
      </label>
      <button type="submit" className="btn-primary min-h-[44px] w-full py-3 text-base">
        Start free — send me a code
      </button>
      {err && <p className="text-sm text-danger">{err}</p>}
    </form>
  );
}

function Wrap({ children }) {
  return <main className="mx-auto max-w-2xl px-5 py-14">{children}</main>;
}
