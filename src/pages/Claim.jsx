import { useEffect, useState, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { claimInvite } from "../lib/claim";
import { CONFIRMATION_SENT_HINT, friendlyAuthError } from "../lib/emailAuth";

// Account-claim landing for a coach-generated invite link (/claim?token=…).
// Not authenticated → verify an emailed code HERE (token preserved), so the
// installed app owns the session. Authenticated → call the claim RPC,
// which links the clients row + mints role='client' (never a lockout). Also covers the
// case where the email-match trigger already linked them (→ "already_yours").
const OK = new Set(["claimed", "already_yours"]);
const MESSAGES = {
  claimed: "You're all set — your coaching account is ready.",
  already_yours: "You're all set — your coaching account is ready.",
  expired: "This invite link has expired. Ask your coach to send a new one.",
  invalid: "This invite link is invalid or has already been used. Ask your coach for a fresh link.",
  already_claimed: "This invite has already been claimed by another account.",
  other_client: "You're already linked to a different client account.",
  role_conflict: "This email is registered as a coach, so it can't claim a client invite. Use a different email.",
  unconfirmed: "Please confirm your email first, then reopen this link.",
  not_authenticated: "Please sign in to claim your account.",
};

export default function Claim() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const { user, requestEmailCode, verifyEmailCode } = useAuth();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [status, setStatus] = useState(null); // claim RPC result
  const [err, setErr] = useState(null);
  const [hint, setHint] = useState(null);

  // Once authenticated, attempt the claim exactly once.
  const runClaim = useCallback(async () => {
    try { setStatus(await claimInvite(token)); }
    catch (e) { setErr(e.message); }
  }, [token]);

  useEffect(() => { if (user && token) runClaim(); }, [user, token, runClaim]);

  if (!token) {
    return <Shell><p className="text-sm opacity-70">This link is missing its invite token. Ask your coach to resend it.</p></Shell>;
  }

  // Authenticated → show claim result.
  if (user) {
    if (status == null && !err) return <Shell><p className="text-sm opacity-70">Linking your account…</p></Shell>;
    const ok = OK.has(status);
    return (
      <Shell>
        <p className={`text-sm ${ok ? "text-success" : "text-danger"}`}>
          {err || MESSAGES[status] || "Something went wrong claiming this invite."}
        </p>
        {ok && (
          <>
            <a href="/client" className="btn-primary mt-4 inline-block">
              Open the app
            </a>
            <p className="mt-3 text-xs opacity-60">
              Next screen is a short briefing. If this opened in Safari from your email, add it to your Home Screen so alerts can reach you.
            </p>
          </>
        )}
      </Shell>
    );
  }

  // Not authenticated → verify the email code in this same app container. The claim
  // token stays on this page, and the installed app owns the resulting session.
  async function submit(e) {
    e.preventDefault();
    setErr(null);
    const redirect = `${window.location.origin}/claim?token=${encodeURIComponent(token)}`;
    const { error, via } = await requestEmailCode(email.trim(), redirect);
    if (error) setErr(friendlyAuthError(error));
    else { setSent(true); setHint(via === "confirmation" ? CONFIRMATION_SENT_HINT : null); }
  }

  async function confirm(e) {
    e.preventDefault();
    setErr(null);
    try {
      const { error } = await verifyEmailCode(email, code);
      if (error) setErr(error.message);
    } catch (error) {
      setErr(error.message);
    }
  }

  return (
    <Shell>
      <p className="text-sm opacity-70">Your coach invited you. Sign in with your email to claim your account.</p>
      {sent ? (
        <form onSubmit={confirm} className="mt-6 space-y-3">
          <p className="text-sm opacity-70">Enter the code from your email here. Keep this coaching app open.</p>
          {hint && <p className="text-xs leading-relaxed opacity-60">{hint}</p>}
          <label className="block text-sm">
            <span className="mb-1 block opacity-60">Email code</span>
            <input
              id="claim-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={12}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="12345678"
              className="w-full rounded-xl border border-ink/15 px-3 py-2.5 text-center text-xl tracking-[0.3em]"
            />
          </label>
          <button className="btn-primary w-full py-2.5">Claim my account</button>
          <button type="button" className="btn-ghost w-full py-2 text-xs" onClick={() => { setSent(false); setCode(""); setErr(null); }}>
            Use a different email
          </button>
          {err && <p className="text-sm text-danger">{err}</p>}
        </form>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-3">
          <p className="text-xs leading-relaxed opacity-60">
            If the coaching app is on your Home Screen, open the invite from inside that app before requesting the code. The code keeps this app signed in.
          </p>
          <label className="block text-sm">
            <span className="mb-1 block opacity-60">Email</span>
            <input
              id="claim-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-xl border border-ink/15 px-3 py-2.5"
            />
          </label>
          <button className="btn-primary w-full py-2.5">Send sign-in code</button>
          {err && <p className="text-sm text-danger">{err}</p>}
        </form>
      )}
      <p className="mt-6 text-xs opacity-50"><Link to="/login" className="underline">Already have an account? Sign in</Link></p>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <main className="mx-auto max-w-sm px-5 py-24">
      <div className="glass p-6">
        <h1 className="display text-2xl">Claim your account</h1>
        <div className="mt-4">{children}</div>
      </div>
    </main>
  );
}
