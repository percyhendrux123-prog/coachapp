import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getCoachBrandingBySlug } from "../lib/coachBranding";
import { applyTheme } from "../lib/theme";
import { DEFAULT_BRAND_COLOR } from "../lib/settings";
import { readableTextOn, accessibleForegroundOn } from "../lib/colorContrast";
import AppGate from "../components/AppGate";

// Turn raw Supabase auth errors into calm, honest copy. The email-send rate limit
// (project-wide, HTTP 429) is the one a real user is most likely to hit.
function friendlyAuthError(error) {
  if (error?.code === "over_email_send_rate_limit" || error?.status === 429) {
    return "We've hit our email limit for the moment — please wait a few minutes and try again. This is a temporary limit, not a problem with your account.";
  }
  return error?.message || "Something went wrong — please try again.";
}

export default function Login() {
  const navigate = useNavigate();
  const { slug } = useParams();
  const { requestEmailCode, verifyEmailCode } = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  // undefined = no slug in the URL (plain /login); null = slug given but no such
  // active coach — those are different facts and must not collapse into one screen.
  const [brand, setBrand] = useState(slug ? undefined : null);

  // A vanity URL (/:slug) shows that coach's own logo/color before sign-in, using
  // the exact same --brand-color mechanism App.jsx's Nav applies post-login — so a
  // coach's branding looks identical whether the visitor is signed in yet or not.
  useEffect(() => {
    if (!slug) return undefined;
    let cancelled = false;
    const root = document.documentElement;
    getCoachBrandingBySlug(slug)
      .then((b) => {
        if (cancelled) return;
        setBrand(b);
        if (b?.brand_color && b.brand_color !== DEFAULT_BRAND_COLOR) {
          root.style.setProperty("--brand-color", b.brand_color);
          root.style.setProperty("--brand-text", readableTextOn(b.brand_color) || "#fafafa");
          root.style.setProperty("--brand-fg-light", accessibleForegroundOn(b.brand_color, "#fafafa"));
          root.style.setProperty("--brand-fg-dark", accessibleForegroundOn(b.brand_color, "#0d0d0d"));
        }
        applyTheme(b?.theme_key);
        if (b?.app_name) document.title = b.app_name;
      })
      .catch(() => { if (!cancelled) setBrand(null); });
    return () => {
      cancelled = true;
      root.style.removeProperty("--brand-color");
      root.style.removeProperty("--brand-text");
      root.style.removeProperty("--brand-fg-light");
      root.style.removeProperty("--brand-fg-dark");
      applyTheme(null);
    };
  }, [slug]);

  async function submit(e) {
    e.preventDefault();
    setErr(null); setBusy(true);
    const { error } = await requestEmailCode(email.trim());
    if (error) setErr(friendlyAuthError(error));
    else setSent(true);
    setBusy(false);
  }

  async function confirm(e) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const { error } = await verifyEmailCode(email, code);
      if (error) setErr(friendlyAuthError(error));
      else navigate("/auth/callback", { replace: true });
    } catch (error) {
      setErr(friendlyAuthError(error));
    }
    setBusy(false);
  }

  // /:slug also catches every unmatched single-segment URL, not just dead coach
  // links — a plain typo and a cancelled vanity link look identical to this route
  // (both resolve to no active coach), so this must not assert one and be wrong
  // about the other. Reusing the app's own generic 404 keeps it honest either way.
  if (slug && brand === null) {
    return (
      <AppGate title="Page not found" actionTo="/" actionLabel="Go home" secondaryTo="/login" secondaryLabel="Sign in">
        That link doesn’t match anything in the app. Check the URL or head home.
      </AppGate>
    );
  }

  return (
    <main className="mx-auto max-w-sm px-5 py-24">
      <div className="glass p-6">
        {brand ? (
          <>
            {brand.logo_url && (
              <img src={brand.logo_url} alt="" className="mb-3 h-10 w-auto" />
            )}
            <span className="kicker">{brand.coach_display_name || brand.app_name}</span>
          </>
        ) : (
          <span className="kicker">Members</span>
        )}
        <h1 className="display mt-2 text-3xl">Sign in</h1>
        {sent ? (
          <form onSubmit={confirm} className="mt-6 space-y-3">
            <p className="text-sm opacity-70">
              Enter the 6-digit code for <strong>{email.trim()}</strong> — from your email, or the one your coach gave you. Keep this coaching app window open.
            </p>
            <label className="block text-sm">
              <span className="mb-1 block opacity-60">Email code</span>
              <input
                id="login-code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className="w-full rounded-xl border border-ink/15 px-3 py-2.5 text-center text-xl tracking-[0.3em]"
              />
            </label>
            <button disabled={busy} className="btn-primary w-full py-2.5 disabled:opacity-50">Open my account</button>
            <button type="button" className="btn-ghost w-full py-2 text-xs" onClick={() => { setSent(false); setCode(""); setErr(null); }}>
              Use a different email
            </button>
            {err && <p className="text-sm text-danger">{err}</p>}
          </form>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-3">
            <p className="text-xs leading-relaxed opacity-60">
              If you installed the coaching app on your Home Screen, open that app before continuing. Your code will be entered here so this app—not your email browser—keeps you signed in.
            </p>
            <label className="block text-sm">
              <span className="mb-1 block opacity-60">Email</span>
              <input
                id="login-email"
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
            <button disabled={busy} className="btn-primary w-full py-2.5 disabled:opacity-50">Send sign-in code</button>
            {/* A code the coach read out over the phone. Goes straight to the code screen
                WITHOUT requesting a new one — a fresh request would replace the code the
                coach just gave. See supabase/functions/client-signin-code/index.ts. */}
            <button
              type="button"
              className="btn-ghost w-full py-2 text-xs"
              onClick={() => {
                if (!email.trim()) { setErr("Enter your email first, then tap this."); return; }
                setErr(null); setSent(true);
              }}
            >
              I already have a code
            </button>
            {err && <p className="text-sm text-danger">{err}</p>}
          </form>
        )}
      </div>
    </main>
  );
}
