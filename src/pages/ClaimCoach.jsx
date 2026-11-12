import { useEffect, useState, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { claimCoachInvite } from "../lib/claimCoach";

// Account-claim landing for a coach invite minted by admin-provision-coach
// (/claim-coach?token=…). Mirrors Claim.jsx (the client-invite claim page)
// structurally — not authenticated → verify an emailed code HERE (token
// preserved); authenticated → call the claim RPC, which attaches coach_user_id
// on the tenant and mints profiles.role='coach'.
const OK = new Set(["claimed", "already_yours"]);
const MESSAGES = {
  claimed: "You're all set — your coaching app is ready.",
  already_yours: "This account is already linked to you.",
  expired: "This invite link has expired. Ask the person who invited you for a new one.",
  invalid: "This invite link is invalid or has already been used. Ask the person who invited you for a fresh link.",
  already_claimed: "This invite has already been claimed by another account.",
  already_has_account: "This email already has a coaching or client account, so it can't claim a new one. Use a different email.",
  unconfirmed: "Please confirm your email first, then reopen this link.",
  not_authenticated: "Please sign in to claim your account.",
};

export default function ClaimCoach() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const { user, requestEmailCode, verifyEmailCode } = useAuth();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [status, setStatus] = useState(null); // claim RPC result
  const [err, setErr] = useState(null);

  const runClaim = useCallback(async () => {
    try { setStatus(await claimCoachInvite(token)); }
    catch (e) { setErr(e.message); }
  }, [token]);

  useEffect(() => { if (user && token) runClaim(); }, [user, token, runClaim]);

  if (!token) {
    return <Shell><p className="text-sm opacity-70">This link is missing its invite token. Ask the person who invited you to resend it.</p></Shell>;
  }

  if (user) {
    if (status == null && !err) return <Shell><p className="text-sm opacity-70">Setting up your app…</p></Shell>;
    const ok = OK.has(status);
    return (
      <Shell>
        <p className={`text-sm ${ok ? "text-success" : "text-danger"}`}>
          {err || MESSAGES[status] || "Something went wrong claiming this invite."}
        </p>
        {ok && (
          <a href="/coach/brief" className="btn-primary mt-4 inline-block">
            Open your coach dashboard
          </a>
        )}
      </Shell>
    );
  }

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    const redirect = `${window.location.origin}/claim-coach?token=${encodeURIComponent(token)}`;
    const { error } = await requestEmailCode(email.trim(), redirect);
    if (error) setErr(error.message);
    else setSent(true);
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
      <p className="text-sm opacity-70">You've been invited to run your own coaching app. Sign in with your email to claim it.</p>
      {sent ? (
        <form onSubmit={confirm} className="mt-6 space-y-3">
          <p className="text-sm opacity-70">Enter the 6-digit code from your email here.</p>
          <label className="block text-sm">
            <span className="mb-1 block opacity-60">Email code</span>
            <input type="text" inputMode="numeric" autoComplete="one-time-code" required maxLength={8}
              value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456"
              className="w-full rounded-xl border border-ink/15 px-3 py-2.5 text-center text-xl tracking-[0.3em]" />
          </label>
          <button className="btn-primary w-full py-2.5">Claim my app</button>
          <button type="button" className="btn-ghost w-full py-2 text-xs" onClick={() => { setSent(false); setCode(""); setErr(null); }}>
            Use a different email
          </button>
          {err && <p className="text-sm text-danger">{err}</p>}
        </form>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-3">
          <label className="block text-sm">
            <span className="mb-1 block opacity-60">Email</span>
            <input type="email" autoComplete="email" required value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
              className="w-full rounded-xl border border-ink/15 px-3 py-2.5" />
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
        <h1 className="display text-2xl">Claim your coaching app</h1>
        <div className="mt-4">{children}</div>
      </div>
    </main>
  );
}
