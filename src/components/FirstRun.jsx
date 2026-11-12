import { useState } from "react";
import { DEFAULT_WELCOME_VIDEO, isIosSafari, isStandaloneApp, markWelcomeSeen } from "../lib/firstRun";
import { copyFor, isSelfServe } from "../lib/systemMode";

// Shown once after email confirmation / first client login.
// Code-based sign-in keeps an installed app's session in that app. This screen
// still explains installation for clients who intentionally signed in in a browser.

export default function FirstRun({ clientId, branding, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [playing, setPlaying] = useState(false);
  const needsHomeScreen = !isStandaloneApp();
  const ios = isIosSafari();
  const custom = (branding?.welcome_video_url || "").trim();
  const videoUrl = /\.(mp4|webm|mov)(\?|$)/i.test(custom) ? custom : DEFAULT_WELCOME_VIDEO;
  const name = branding?.coach_display_name || branding?.app_name || "your coach";
  const firstRunBody = isSelfServe(branding)
    ? copyFor(branding?.mode, "first_run_body")
    : copyFor(branding?.mode, "first_run_body").replace("{name}", name);

  async function finish() {
    setErr(null);
    setBusy(true);
    try {
      await markWelcomeSeen(clientId);
      onDone();
    } catch (e) {
      setErr(e.message || "Could not save. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink text-paper">
      <div className="mx-auto flex min-h-[100dvh] max-w-md flex-col px-5 py-10">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] opacity-50">First session</p>
        <h1 className="display mt-2 text-3xl">You are in.</h1>
        <p className="mt-2 text-sm opacity-70">{firstRunBody}</p>

        <div className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-black">
          {playing ? (
            <video
              src={videoUrl}
              className="aspect-[9/16] w-full object-cover"
              controls
              playsInline
              autoPlay
              preload="metadata"
            />
          ) : (
            <button
              type="button"
              onClick={() => setPlaying(true)}
              className="relative flex aspect-[9/16] w-full items-center justify-center"
              aria-label="Play welcome briefing"
            >
              <img
                src="/assets/welcome-onboarding.jpg"
                alt=""
                className="absolute inset-0 h-full w-full object-cover opacity-80"
              />
              <span className="relative rounded-full bg-paper px-4 py-2 text-sm font-semibold text-ink">
                Play briefing
              </span>
            </button>
          )}
        </div>

        {needsHomeScreen && (
          <div className="mt-6 rounded-2xl border border-white/15 bg-white/5 p-4 text-sm">
            <p className="font-semibold">Add this to your Home Screen</p>
            <p className="mt-1 text-xs opacity-70">
              You are signed in here. Alerts work after this sits on the Home Screen like an app.
            </p>
            {ios ? (
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-xs opacity-85">
                <li>Tap the Share button at the bottom of Safari (the square with the arrow).</li>
                <li>Scroll and tap Add to Home Screen.</li>
                <li>Tap Add. Open it from the new icon next time.</li>
              </ol>
            ) : (
              <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-xs opacity-85">
                <li>Open the browser menu (three dots or share).</li>
                <li>Tap Add to Home Screen or Install app.</li>
                <li>Open it from that icon next time so alerts can reach you.</li>
              </ol>
            )}
          </div>
        )}

        {err && <p className="mt-4 text-sm text-danger">{err}</p>}
        <button type="button" onClick={finish} disabled={busy} className="btn-primary mt-6 w-full py-3">
          {busy ? "Saving…" : "Continue to my program"}
        </button>
      </div>
    </div>
  );
}
