import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { supabase } from "../lib/supabase";
import { requestEmailCode as requestCode, verifyEmailCode as verifyCode } from "../lib/emailAuth";
import { authChangeNeedsHydration, subscribeToAuthChanges, withTimeout } from "../lib/authLifecycle";

const AuthContext = createContext(null);
const BOOT_TIMEOUT_MS = 10_000;

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null); // { user_id, role, tenant_id }
  const [tenant, setTenant] = useState(null);    // { id, slug, status, subscription_status }
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [bootAttempt, setBootAttempt] = useState(0);

  // Load the profile row (role + tenant) for the signed-in user, plus the tenant's
  // access status (drives the hosting-lapse coach lock / client read-only).
  //
  // profiles.tenant_id has a real FK to tenants.id, so PostgREST can embed the tenant
  // row in the same request instead of a second round trip that waits on the first.
  const loadProfile = useCallback(async (userId) => {
    if (!userId) { setProfile(null); setTenant(null); return; }
    const fetchProfile = async () => {
      const result = await supabase
        .from("profiles")
        .select("user_id, role, tenant_id, tenants(id, slug, status, subscription_status)")
        .eq("user_id", userId)
        .maybeSingle();
      if (result.error) throw result.error;
      return result;
    };
    let { data } = await fetchProfile();
    if (!data) {
      // Self-heal for first logins: claim_my_client links this verified email to the
      // clients row a coach created and mints the client profile. Idempotent no-op
      // for everyone else (coaches, prospects, already-linked clients).
      const { data: linked } = await supabase.rpc("claim_my_client").then((r) => r, () => ({ data: 0 }));
      if (linked > 0) ({ data } = await fetchProfile());
    }
    const { tenants: embeddedTenant, ...profileFields } = data ?? {};
    setProfile(data ? profileFields : null);
    setTenant(embeddedTenant ?? null);
  }, []);

  useEffect(() => {
    let active = true;
    let currentUserId = null;

    const hydrate = async (nextSession) => {
      if (!active) return;
      currentUserId = nextSession?.user?.id ?? null;
      setSession(nextSession ?? null);
      await withTimeout(loadProfile(currentUserId), BOOT_TIMEOUT_MS, "profile load");
    };

    const fail = () => {
      if (!active) return;
      setProfile(null);
      setTenant(null);
      setAuthError("We could not open your coaching. Check your connection and try again.");
    };

    const bootstrap = async () => {
      setLoading(true);
      setAuthError(null);
      try {
        const { data, error } = await withTimeout(
          supabase.auth.getSession(),
          BOOT_TIMEOUT_MS,
          "session load",
        );
        if (error) throw error;
        await hydrate(data.session);
      } catch {
        fail();
      } finally {
        if (active) setLoading(false);
      }
    };

    bootstrap();
    const unsubscribe = subscribeToAuthChanges(supabase.auth, async (nextSession, event) => {
      if (!active) return;
      const nextUserId = nextSession?.user?.id ?? null;
      if (!authChangeNeedsHydration(event, currentUserId, nextUserId)) {
        setSession(nextSession);
        return;
      }
      setLoading(true);
      setAuthError(null);
      try {
        await hydrate(nextSession);
      } catch {
        fail();
      } finally {
        if (active) setLoading(false);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [loadProfile, bootAttempt]);

  const retryAuth = useCallback(() => setBootAttempt((n) => n + 1), []);

  // Magic-link return address, resolved at RUNTIME from the origin actually serving the
  // app. Never from a build-time env value.
  //
  // This line previously read `redirectTo || import.meta.env.VITE_SITE_URL || origin`,
  // and VITE_SITE_URL was http://localhost:5173 in the developer .env.local. Vite inlines
  // import.meta.env at build time, so production shipped a literal
  // emailRedirectTo:"http://localhost:5173" — and because that value is truthy the
  // window.location.origin fallback was unreachable. Every client who requested a sign-in
  // link from /login got a magic link pointing at their own machine. It failed silently:
  // the request succeeded, the mail arrived, the link went nowhere.
  //
  // window.location.origin cannot have that failure mode. The app is served from the site
  // it needs to return to, so the correct answer is already in the browser — no env var to
  // set, nothing to keep in sync, and no dependency on which machine ran the build. It is
  // also more correct than hardcoding the production URL would be: Netlify branch and
  // preview deploys each return to their own origin instead of bouncing to production.
  //
  // Supabase must still allow the origin in its redirect allow-list; an origin that is not
  // allowed falls back to the project's configured Site URL, which is a real address. The
  // failure mode is "wrong page on the right site", never "localhost". /claim has passed
  // window.location.origin since it was written, which is why /claim kept working while
  // /login did not.
  const requestEmailCode = (email, redirectTo) => requestCode(
    supabase.auth,
    email,
    redirectTo || `${window.location.origin}/auth/callback`,
  );
  const verifyEmailCode = (email, token) => verifyCode(supabase.auth, email, token);
  const signOut = () => supabase.auth.signOut();

  return (
    <AuthContext.Provider
      value={{
        session, user: session?.user ?? null, profile, role: profile?.role ?? null,
        tenant, suspended: tenant?.status === "suspended",
        loading, authError, retryAuth, requestEmailCode, verifyEmailCode, signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
