import { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route, Link, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { getTenantBranding } from "./lib/license";
import { applyTheme, getMode, setMode } from "./lib/theme";
import { DEFAULT_BRAND_COLOR } from "./lib/settings";
import { readableTextOn, accessibleForegroundOn } from "./lib/colorContrast";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import ClientPreview from "./pages/ClientPreview";
import { CoachGate, ReadOnlyBanner } from "./components/SubscriptionGate";
import { PREVIEW_ROUTES_ENABLED } from "./lib/previewFlag";
import AppGate from "./components/AppGate";
import TenantMark from "./components/TenantMark";
import { isOwnerTenant } from "./lib/tenantIdentity";
import { neutralBrand, ownerRouteDecision } from "./lib/whiteLabelPolicy";
import { isSelfServe } from "./lib/systemMode";

const Knowledge = lazy(() => import("./pages/Knowledge"));
const Framework = lazy(() => import("./pages/Framework"));
const Coach = lazy(() => import("./pages/Coach"));
const CoachBrief = lazy(() => import("./pages/CoachBrief"));
const CoachHome = lazy(() => import("./pages/CoachHome"));
const CoachCockpit = lazy(() => import("./pages/CoachCockpit"));
const CoachActivity = lazy(() => import("./pages/CoachActivity"));
const CoachClients = lazy(() => import("./pages/CoachClients"));
const CoachInbox = lazy(() => import("./pages/CoachInbox"));
const CoachCalendar = lazy(() => import("./pages/CoachCalendar"));
const CoachPrograms = lazy(() => import("./pages/CoachPrograms"));
const Client = lazy(() => import("./pages/Client"));
const CoachAI = lazy(() => import("./pages/CoachAI"));
const Community = lazy(() => import("./pages/Community"));
const Challenge = lazy(() => import("./pages/Challenge"));
const ChallengePreview = lazy(() => import("./pages/ChallengePreview"));
const License = lazy(() => import("./pages/License"));
const Intake = lazy(() => import("./pages/Intake"));
const Screen = lazy(() => import("./pages/Screen"));
const ScreenPreview = lazy(() => import("./pages/ScreenPreview"));
const System = lazy(() => import("./pages/System"));
const SystemStart = lazy(() => import("./pages/SystemStart"));
const SystemWelcome = lazy(() => import("./pages/SystemWelcome"));
const CoachingWelcome = lazy(() => import("./pages/CoachingWelcome"));
const Claim = lazy(() => import("./pages/Claim"));
const ClaimCoach = lazy(() => import("./pages/ClaimCoach"));
const CoachSettings = lazy(() => import("./pages/CoachSettings"));
const CoachAbout = lazy(() => import("./pages/CoachAbout"));
const AuthCallback = lazy(() => import("./pages/AuthCallback"));

function Nav() {
  const { user, role, profile, tenant, signOut } = useAuth();
  // White-label branding: members see their tenant's app_name instead of the default.
  const [brand, setBrand] = useState(null);
  const [brandStatus, setBrandStatus] = useState("loading");
  useEffect(() => {
    const root = document.documentElement;
    if (profile?.tenant_id) {
      setBrandStatus("loading");
      getTenantBranding().then((b) => {
        setBrand(b);
        setBrandStatus("ready");
        // Drive the app-wide --brand-color from this tenant's config. If unset/absent —
        // or stored as the neutral default (#0a0a0a, what every pre-picker tenant has) —
        // remove it so bg-brand falls back to ink, which flips correctly in dark mode.
        // A pinned #0a0a0a would otherwise render dark-on-dark brand fills there.
        if (b?.brand_color && b.brand_color !== DEFAULT_BRAND_COLOR) {
          root.style.setProperty("--brand-color", b.brand_color);
          // A coach's chosen accent can land anywhere on the lightness scale, so the
          // text that sits on it (buttons, filled badges) is picked for contrast, not
          // assumed to be white. See colorContrast.js.
          root.style.setProperty("--brand-text", readableTextOn(b.brand_color) || "#fafafa");
          // Same idea for accent-as-text (labels, links) — darkened/lightened per theme
          // rather than assumed legible at the raw hue. See index.css's --brand-fg split.
          root.style.setProperty("--brand-fg-light", accessibleForegroundOn(b.brand_color, "#fafafa"));
          root.style.setProperty("--brand-fg-dark", accessibleForegroundOn(b.brand_color, "#0d0d0d"));
        } else {
          root.style.removeProperty("--brand-color");
          root.style.removeProperty("--brand-text");
          root.style.removeProperty("--brand-fg-light");
          root.style.removeProperty("--brand-fg-dark");
        }
        // Tenant theme (neutral palette) + browser-tab identity follow the same load.
        applyTheme(b?.theme_key);
        document.title = b?.app_name || neutralBrand().title;
      }).catch(() => {
        setBrand(null);
        setBrandStatus("failed");
        root.style.removeProperty("--brand-color");
        root.style.removeProperty("--brand-text");
        root.style.removeProperty("--brand-fg-light");
        root.style.removeProperty("--brand-fg-dark");
        applyTheme(null);
        document.title = neutralBrand().title;
      });
    } else {
      setBrand(null);
      setBrandStatus("ready");
      root.style.removeProperty("--brand-color");
      root.style.removeProperty("--brand-text");
      root.style.removeProperty("--brand-fg-light");
      root.style.removeProperty("--brand-fg-dark");
      applyTheme(null);
      document.title = neutralBrand().title;
    }
  }, [profile?.tenant_id, tenant]);

  const owner = isOwnerTenant(tenant);
  const appName = brandStatus === "ready" && brand?.app_name
    ? brand.app_name
    : neutralBrand().appName;

  return (
    // Phone geometry (observed 2026-08-15, TCL K33): signed in as a client at 360 CSS px
    // this row wanted 422px. "My coaching" and "Sign out" broke onto second lines, the bar
    // grew to 81px and — being sticky — ate the top of the page on every scroll. Worse, the
    // 62px of horizontal overflow widened the layout viewport, which dragged the client's
    // fixed bottom nav off the right edge of the glass with it.
    //
    // So: nothing in this row may wrap, the action cluster never shrinks, and the wordmark
    // absorbs any squeeze by truncating. Below sm the row also sheds what is genuinely
    // reachable elsewhere — see the notes on each item.
    <nav className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-ink/10 bg-paper/75 px-4 py-3 backdrop-blur-lg sm:px-5">
      <Link
        to={role === "client" ? "/client" : role === "coach" ? "/coach/brief" : "/"}
        className="display flex min-w-0 items-center gap-2.5 truncate text-[13px] sm:text-[15px]"
      >
        <TenantMark brand={brandStatus === "ready" ? brand : null} owner={owner} className="h-6 w-6" />
        <span className="truncate">{appName.toUpperCase()}</span>
      </Link>
      <div className="flex shrink-0 items-center gap-1.5 text-sm font-medium sm:gap-2">
        <ModeToggle />
        {/* Home button, phone-hidden: the wordmark to its left already links to exactly
            this route for both roles, and each role has a bottom bar underneath. */}
        {role === "coach" && (
          <Link to="/coach/brief" className="btn-primary hidden min-h-[44px] items-center whitespace-nowrap px-3 text-sm sm:inline-flex">Coach</Link>
        )}
        {role === "client" && (
          <Link to="/client" className="btn-primary hidden min-h-[44px] items-center whitespace-nowrap px-3 text-sm sm:inline-flex">My coaching</Link>
        )}
        {/* Phone-hidden: both roles reach Community from their own More sheet — the
            client's has always listed it, the coach's now does too (CoachTabs MORE).
            Never shown to a self-serve client — there is no coach-scoped community
            for a coachless tenant to pool into (spec §4). */}
        {(role === "coach" || (role === "client" && !isSelfServe(brand))) && (
          <Link
            to={role === "client" ? "/client?tab=community" : "/community"}
            className="hidden min-h-[44px] items-center whitespace-nowrap px-1.5 opacity-70 transition hover:opacity-100 sm:inline-flex sm:px-2"
          >
            Community
          </Link>
        )}
        {user ? (
          // Only sign-out control in the app — never hidden at any width.
          <button
            type="button"
            onClick={signOut}
            className="inline-flex min-h-[44px] items-center whitespace-nowrap px-1.5 opacity-70 transition hover:opacity-100 sm:px-2"
          >
            Sign out
          </button>
        ) : (
          <Link to="/login" className="btn-primary inline-flex min-h-[44px] items-center whitespace-nowrap px-3.5 text-sm">Sign in</Link>
        )}
      </div>
    </nav>
  );
}

// Light/dark toggle — explicit user choice only (never follows the OS; see theme.js).
// Icon-only (2026-08-30, implementation): the DARK/LIGHT word chip was the widest thing in the
// header for what it does. The icon shows the mode you'd SWITCH TO, matching the label.
function ModeToggle() {
  const [mode, setModeState] = useState(getMode());
  function flip() {
    const next = mode === "dark" ? "light" : "dark";
    setMode(next);
    setModeState(next);
  }
  return (
    <button
      type="button"
      onClick={flip}
      aria-label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-ink/10 opacity-70 transition hover:opacity-100"
    >
      {mode === "dark" ? (
        /* sun */
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="8" cy="8" r="3.25" />
          <path d="M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3.05 3.05l1.27 1.27M11.68 11.68l1.27 1.27M12.95 3.05l-1.27 1.27M4.32 11.68l-1.27 1.27" />
        </svg>
      ) : (
        /* moon */
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7Z" />
        </svg>
      )}
    </button>
  );
}

export default function App() {
  const { loading, authError, retryAuth } = useAuth();
  if (loading) return <BootScreen />;
  if (authError) return <BootScreen error={authError} onRetry={retryAuth} />;
  return (
    <div className="min-h-screen">
      <Nav />
      <ReadOnlyBanner />
      <Suspense fallback={<RouteLoading />}>
        <Routes>
        {/* / is public entry only. Signed-in clients → /client, coaches → /coach (Landing redirects).
            Challenges are /challenge/:slug and coach authoring at /coach/challenges. */}
        <Route path="/" element={<Landing />} />
        <Route path="/knowledge" element={<OwnerRoute><Knowledge /></OwnerRoute>} />
        <Route path="/resources/:slug" element={<OwnerRoute><Framework /></OwnerRoute>} />
        <Route path="/login" element={<Login />} />
        {/* Per-coach vanity sign-in, e.g. /owner — shows that coach's own logo/color
            before sign-in via get-coach-branding. React Router ranks static paths
            above this dynamic one regardless of declaration order, so it never
            shadows /coach, /client, /community, etc. above or below it. */}
        {/* Self-serve plan — public buyer path. Declared BEFORE /:slug so the vanity-login route never shadows it. */}
        <Route path="/system" element={<System />} />
        <Route path="/system/start" element={<SystemStart />} />
        <Route path="/system/welcome" element={<SystemWelcome />} />
        {/* OWNER coaching Payment Links return here after payment (Slice 0). Before /:slug for the same reason. */}
        <Route path="/welcome" element={<CoachingWelcome />} />
        <Route path="/:slug" element={<Login />} />
        <Route path="/coach" element={<CoachGate><CoachHome /></CoachGate>} />
        <Route path="/coach/brief" element={<CoachGate><CoachBrief /></CoachGate>} />
        <Route path="/coach/cockpit" element={<CoachGate><CoachCockpit /></CoachGate>} />
        <Route path="/coach/activity" element={<CoachGate><CoachActivity /></CoachGate>} />
        <Route path="/coach/challenges" element={<CoachGate><Coach /></CoachGate>} />
        {/* Ungated, fixture-only: renders the home page from a fixture so the
            layout can be reviewed and screenshotted at every breakpoint without
            a coach session. Present in dev, and in a draft build that opts in via
            VITE_PREVIEW_ROUTES=1; tree-shaken out of production builds, which set
            neither. It can only ever show fixture data — it has no database
            access. See previewFlag.js. */}
        {PREVIEW_ROUTES_ENABLED && (
          <>
            <Route path="/__preview/coach-home" element={<CoachHome />} />
            <Route path="/__preview/coach-cockpit" element={<CoachCockpit />} />
            <Route path="/__preview/client" element={<ClientPreview />} />
            <Route path="/__preview/challenge" element={<ChallengePreview />} />
            <Route path="/__preview/screen" element={<ScreenPreview />} />
          </>
        )}
        <Route path="/coach/clients" element={<CoachGate><CoachClients /></CoachGate>} />
        <Route path="/coach/inbox" element={<CoachGate><CoachInbox /></CoachGate>} />
        <Route path="/coach/calendar" element={<CoachGate><CoachCalendar /></CoachGate>} />
        <Route path="/coach/programs" element={<CoachGate><CoachPrograms /></CoachGate>} />
        <Route path="/coach/ai" element={<CoachGate><CoachAI /></CoachGate>} />
        <Route path="/coach/settings" element={<CoachGate><CoachSettings /></CoachGate>} />
        <Route path="/coach/about" element={<CoachGate><CoachAbout /></CoachGate>} />
        <Route path="/client" element={<Client />} />
        <Route path="/community" element={<Community />} />
        <Route path="/license" element={<License />} />
        <Route path="/intake" element={<Intake />} />
        <Route path="/screen" element={<Screen />} />
        <Route path="/claim" element={<Claim />} />
        <Route path="/claim-coach" element={<ClaimCoach />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/challenge/:slug" element={<Challenge />} />
        <Route
          path="*"
          element={
            <AppGate
              title="Page not found"
              actionTo="/"
              actionLabel="Go home"
              secondaryTo="/login"
              secondaryLabel="Sign in"
            >
              That link doesn’t match anything in the app. Check the URL or head home.
            </AppGate>
          }
        />
        </Routes>
      </Suspense>
    </div>
  );
}

function RouteLoading() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10" aria-live="polite">
      <span className="kicker">Coaching app</span>
      <p className="mt-2 text-sm opacity-60">Opening this section…</p>
    </main>
  );
}

function BootScreen({ error = null, onRetry = null }) {
  return (
    <main className="grid min-h-screen place-items-center px-5 py-12">
      <section className="glass w-full max-w-sm p-6 sm:p-8" aria-live="polite">
        <span className="kicker">Coaching app</span>
        <h1 className="display mt-2 text-2xl sm:text-3xl">
          {error ? "Could not open your coaching" : "Opening your coaching"}
        </h1>
        <p className="mt-3 text-sm leading-relaxed opacity-70">
          {error || "Loading your program, meals, and check-in."}
        </p>
        {error && onRetry && (
          <button type="button" onClick={onRetry} className="btn-primary mt-6 min-h-[44px] px-4">
            Try again
          </button>
        )}
      </section>
    </main>
  );
}

function OwnerRoute({ children }) {
  const { user, tenant, role } = useAuth();
  const decision = ownerRouteDecision({ user, tenant, role });
  return decision.allow ? children : <Navigate to={decision.redirectTo} replace />;
}
