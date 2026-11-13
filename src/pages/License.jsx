import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { startLicenseCheckout, provisionLicense } from "../lib/license";

// White-label storefront: overview → sign in → license checkout → name your
// app → provision (tenant + coach profile + tenant_config, gated on verified payment).
export default function License() {
  const { user, role, requestEmailCode, verifyEmailCode, loading } = useAuth();
  const [params] = useSearchParams();
  const sessionId = params.get("session_id");
  const canceled = params.get("canceled");

  if (loading) return <Wrap><p className="text-sm opacity-60">Loading…</p></Wrap>;

  // Already a member (coach or client) → nothing to buy here.
  if (user && role) {
    return (
      <Wrap>
        <h1 className="display text-4xl">You're all set</h1>
        <p className="mt-3 opacity-70 text-sm">This account already belongs to a coaching app{role === "coach" ? " you run" : ""}.</p>
      </Wrap>
    );
  }

  // Returned from Stripe → name the app and provision.
  if (user && sessionId) return <ProvisionStep sessionId={sessionId} />;

  return (
    <Wrap>
      <span className="kicker">White label · Your brand</span>
      <h1 className="display mt-3 text-4xl md:text-5xl">Run your own<br />coaching app</h1>
      <p className="mt-4 text-lg leading-snug opacity-70">
        Your brand. Your clients. Your business. A coaching platform licensed and hosted for you.
      </p>

      <ul className="mt-10 grid gap-3 text-sm sm:grid-cols-2">
        {[
          ["Branded client app", "Your name, your welcome, your framework — configured, not coded."],
          ["Full coaching toolkit", "Programs, check-ins, messaging, resources, community, challenges."],
          ["7-day challenge funnel", "Run your own 7-Day Challenge to acquire clients."],
          ["Your plan", "Review the license and hosting fees at checkout."],
        ].map(([t, d]) => (
          <li key={t} className="glass p-4">
            <span className="font-bold">{t}</span>
            <span className="block text-xs leading-relaxed opacity-60 mt-1">{d}</span>
          </li>
        ))}
      </ul>

      {canceled && <p className="mt-6 text-sm text-ink/70">Checkout canceled — no charge was made.</p>}

      <div className="mt-8">
        {user ? <BuyButton /> : (
          <SignInFirst requestEmailCode={requestEmailCode} verifyEmailCode={verifyEmailCode} />
        )}
      </div>
      <p className="mt-3 text-center text-xs opacity-50">License and hosting fees are shown at checkout.</p>
    </Wrap>
  );
}

function BuyButton() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [coupon, setCoupon] = useState("");
  async function buy() {
    setErr(null); setBusy(true);
    try {
      const { checkout_url } = await startLicenseCheckout({ coupon });
      window.location.assign(checkout_url);
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <>
      <label className="mb-3 block text-sm">
        <span className="mb-1 block opacity-60">Coupon (optional)</span>
        <input
          type="text"
          value={coupon}
          onChange={(e) => setCoupon(e.target.value)}
          placeholder="If the app owner gave you a code"
          autoComplete="off"
          className="w-full rounded-xl border border-ink/15 px-3 py-2.5"
        />
      </label>
      <button onClick={buy} disabled={busy} className="btn-primary w-full py-3 text-base">
        {busy ? "Opening checkout…" : "Get your license"}
      </button>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </>
  );
}

function SignInFirst({ requestEmailCode, verifyEmailCode }) {
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
      <form onSubmit={confirm} className="space-y-2">
        <p className="text-sm opacity-70">Enter the code from your email here.</p>
        <label className="block text-sm">
          <span className="mb-1 block opacity-60">Email code</span>
          <input type="text" inputMode="numeric" autoComplete="one-time-code" required maxLength={12}
            value={code} onChange={(e) => setCode(e.target.value)} placeholder="12345678"
            className="w-full rounded-xl border border-ink/15 px-3 py-2.5 text-center text-xl tracking-[0.3em]" />
        </label>
        <button className="btn-primary w-full py-3 text-base">Continue</button>
        {err && <p className="text-sm text-danger">{err}</p>}
      </form>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <label className="block text-sm">
        <span className="mb-1 block opacity-60">Email</span>
        <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com"
          className="w-full rounded-xl border border-ink/15 px-3 py-2.5" />
      </label>
      <button className="btn-primary w-full py-3 text-base">Send sign-in code</button>
      {err && <p className="text-sm text-danger">{err}</p>}
    </form>
  );
}

function ProvisionStep({ sessionId }) {
  const [appName, setAppName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);

  async function go(e) {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const res = await provisionLicense({ sessionId, appName, displayName });
      setDone(res);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  if (done) {
    return (
      <Wrap>
        <div className="text-center">
          <span className="kicker">Live</span>
          <h1 className="display mt-2 text-3xl">Your app is live.</h1>
          <p className="mt-3 text-sm opacity-70">Provisioned as <span className="font-mono">{done.slug}</span>{done.already_provisioned ? " (already set up)" : ""}.</p>
          <button onClick={() => { window.location.assign("/coach/brief"); }} className="btn-primary mt-6 px-5 py-2.5">
            Open your coach dashboard
          </button>
        </div>
      </Wrap>
    );
  }

  return (
    <Wrap>
      <span className="kicker">Payment received</span>
      <h1 className="display mt-3 text-3xl">Name your app</h1>
      <form onSubmit={go} className="mt-6 space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block opacity-60">App name</span>
          <input required value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="e.g. IronWorks Coaching"
            className="w-full rounded-xl border border-ink/15 px-3 py-2.5" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block opacity-60">Your coach display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Jamie Rivera"
            className="w-full rounded-xl border border-ink/15 px-3 py-2.5" />
        </label>
        {err && <p className="text-sm text-danger">{err}</p>}
        <button disabled={busy} className="btn-primary w-full py-3 text-base">
          {busy ? "Provisioning…" : "Create my app"}
        </button>
      </form>
    </Wrap>
  );
}

function Wrap({ children }) {
  return <main className="mx-auto max-w-xl px-5 py-14">{children}</main>;
}
