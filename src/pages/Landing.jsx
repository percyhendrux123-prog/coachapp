import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

// Public entry ONLY when logged out.
// Signed-in coach → /coach, client → /client. No shared marketing stop.
// Challenges: /challenge/:slug (and coach Challenges tab) — not this page's job.
export default function Landing() {
  const { user, role, loading } = useAuth();


  // Auth still resolving — no challenge hero flash.
  if (loading) {
    return (
      <main className="mx-auto max-w-md px-5 py-24 text-center text-sm opacity-60">
        Signing you in…
      </main>
    );
  }

  // Product homes — never sit on public entry.
  if (role === "client") return <Navigate to="/client" replace />;
  if (role === "coach") return <Navigate to="/coach/brief" replace />;

  // Session exists but profile role missing (invite lag).
  if (user && !role) {
    return (
      <main className="mx-auto max-w-md px-5 py-20">
        <div className="glass p-6 text-center">
          <span className="kicker">Account</span>
          <h1 className="display mt-2 text-3xl">Finishing setup</h1>
          <p className="mt-3 text-sm opacity-70">
            You’re signed in. This email isn’t linked as a client or coach yet.
            Open the invite your coach sent, or wait a moment and refresh.
          </p>
          <div className="mt-6 flex flex-col gap-2">
            <Link to="/login" className="btn-primary py-3">Sign in again</Link>
          </div>
        </div>
      </main>
    );
  }

  // Logged out — useful public entry.
  return (
    <main className="mx-auto max-w-md px-5 py-20 md:py-28">
      <span className="kicker">Coaching app</span>
      <h1 className="display mt-3 text-4xl md:text-5xl">
        Train with<br />structure
      </h1>
      <p className="mt-4 text-sm leading-relaxed opacity-70">
        Programs, nutrition, check-ins, and history. Same sign-in for everyone —
        enter the emailed code in this app and your account opens in the right place.
      </p>

      <div className="mt-8 flex flex-col gap-3">
        <Link to="/login" className="btn-primary py-3 text-center text-base">
          Sign in
        </Link>
        <p className="text-center text-xs opacity-50">
          Email a one-time code to the address on file (coach or client).
        </p>
      </div>

      <div className="glass mt-10 space-y-4 p-5">
        <div>
          <p className="section-title">Client</p>
          <p className="mt-1 text-sm opacity-70">
            Your coach adds your email. Sign in here — you land in My coaching automatically.
          </p>
        </div>
        <div className="border-t border-ink/10 pt-4">
          <p className="section-title">Coach</p>
          <p className="mt-1 text-sm opacity-70">
            Same login. Enter the emailed code and your coach dashboard opens.
          </p>
          <a
            href="https://github.com/percyhendrux123-prog/coachapp/blob/main/SETUP.md"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost mt-3 inline-flex text-sm"
          >
            Coach on your own terms →
          </a>
        </div>
      </div>


    </main>
  );
}
