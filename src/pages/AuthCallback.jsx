import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

function pickNext(role) {
  if (role === "coach") return "/coach/brief";
  if (role === "client") return "/client";
  return null; // never park known users on marketing /
}

export default function AuthCallback() {
  const navigate = useNavigate();
  const [message, setMessage] = useState("Signing you in…");
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function finishSignIn() {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) throw error;
      }

      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      const userId = sessionData.session?.user?.id;
      if (!userId) throw new Error("No session was created. Request a fresh sign-in code from this app.");

      // First client login: link verified email → clients row + mint profile.
      // Idempotent for coaches / already-linked users. Must run BEFORE we read role.
      await supabase.rpc("claim_my_client").then((r) => r, () => ({ data: 0 }));

      let role = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("role")
          .eq("user_id", userId)
          .maybeSingle();
        role = profile?.role ?? null;
        if (role === "coach" || role === "client") break;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }

      if (cancelled) return;

      // Clean the address bar; do not leave users on /auth/callback.
      window.history.replaceState({}, document.title, "/auth/callback");

      const next = pickNext(role);
      if (next) {
        navigate(next, { replace: true });
        return;
      }

      // Signed in but no coach/client profile yet — stay here, never challenge marketing.
      setStuck(true);
      setMessage(
        "You’re signed in, but this email isn’t linked as a coach or client yet. Use the invite your coach sent, or request a new sign-in code after they add you.",
      );
    }

    finishSignIn().catch((error) => {
      if (!cancelled) {
        setStuck(true);
        setMessage(error.message || "Sign-in failed. Request a fresh sign-in code.");
      }
    });

    return () => { cancelled = true; };
  }, [navigate]);

  return (
    <main className="mx-auto max-w-sm px-5 py-24">
      <div className="glass space-y-4 p-6 text-sm">
        <p className="opacity-80">{message}</p>
        {stuck && (
          <div className="flex flex-col gap-2">
            <Link to="/login" className="btn-primary py-2.5 text-center">Back to sign in</Link>
            <Link to="/" className="btn-ghost py-2 text-center text-xs">Home</Link>
          </div>
        )}
      </div>
    </main>
  );
}
