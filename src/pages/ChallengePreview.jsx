import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PREVIEW_ROUTES_ENABLED } from "../lib/previewFlag";
import { createSyntheticChallenge, HOUR_MS } from "../lib/challengeRunFixtures";
import ChallengeOverview from "../components/ChallengeOverview";
import ChallengeRun from "../components/ChallengeRun";

// ============================================================================
// CHALLENGE PREVIEW — fixture-only. Renders the real participant components against
// the synthetic challenge server (src/lib/challengeRunFixtures.js), so the enrollment
// page, the daily log, the 20-hour lock, and every end state can be seen and tapped on
// a phone with no account, no database, and nothing written anywhere.
//
// Present under `vite dev` and `npm run build:preview` only (see previewFlag.js);
// tree-shaken out of production builds. Synthetic data. Nothing is live.
//
//   /__preview/challenge?phase=overview    the public page, signed out
//   /__preview/challenge?phase=day1        day 1 open — tick standards, press Save
//   /__preview/challenge?phase=logged      day 1 logged, locked until the gate passes
//   /__preview/challenge?phase=day7        six perfect days closed, day 7 open
//   /__preview/challenge?phase=rewarded    perfect week → rewarded (server-set)
//   /__preview/challenge?phase=completed   all logged, one imperfect day
//   /__preview/challenge?phase=incomplete  one day never logged
//   /__preview/challenge?phase=failed      the day-log read fails
// ============================================================================
const PHASES = ["overview", "day1", "logged", "day7", "rewarded", "completed", "incomplete", "failed"];

const ALL = (s) => s.standards.map((x) => x.id);

async function perfectDays(s, run, n, { imperfectDay = null, skipDay = null } = {}) {
  for (let day = 1; day <= n; day++) {
    if (day !== skipDay) {
      await s.api.logDay(run.id, day, imperfectDay === day ? ALL(s).slice(1) : ALL(s));
    }
    s.clock.advance(24 * HOUR_MS);
    await s.api.closeDay(run.id);
  }
}

// Build the synthetic world so that its clock lands on wall-clock "now".
async function seed(phase) {
  const daysBack = { day7: 6, rewarded: 7, completed: 7, incomplete: 7 }[phase] ?? 0;
  const s = createSyntheticChallenge({ startAt: Date.now() - daysBack * 24 * HOUR_MS - (phase === "logged" ? 1 * HOUR_MS : 0) });
  if (phase === "overview") return { s, run: null };
  await s.api.enroll(s.challenge.id);
  const run = await s.api.getMyRun(s.challenge.id);
  if (phase === "logged") { await s.api.logDay(run.id, 1, ALL(s)); s.clock.advance(1 * HOUR_MS); }
  if (phase === "day7") await perfectDays(s, run, 6);
  if (phase === "rewarded") await perfectDays(s, run, 7);
  if (phase === "completed") await perfectDays(s, run, 7, { imperfectDay: 3 });
  if (phase === "incomplete") await perfectDays(s, run, 7, { skipDay: 4 });
  if (phase === "failed") s.api.getDayLogs = async () => { throw new Error("synthetic network failure"); };
  return { s, run: await s.api.getMyRun(s.challenge.id) };
}

export default function ChallengePreview() {
  const [params] = useSearchParams();
  const phase = PHASES.includes(params.get("phase")) ? params.get("phase") : "day1";
  const [world, setWorld] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!PREVIEW_ROUTES_ENABLED) return;
    let active = true;
    seed(phase).then((w) => { if (active) setWorld(w); });
    return () => { active = false; };
  }, [phase]);

  if (!PREVIEW_ROUTES_ENABLED) {
    return (
      <main className="mx-auto max-w-xl px-5 py-16">
        <section className="glass p-6">
          <span className="kicker">Challenge</span>
          <h1 className="display mt-2 text-2xl">Sign in to see your challenge</h1>
        </section>
      </main>
    );
  }
  if (!world) return <main className="mx-auto max-w-2xl px-5 py-14 text-sm opacity-60">Building the synthetic run…</main>;

  const { s } = world;
  const refreshRun = async () => setWorld((w) => ({ ...w, run: null })) || s.api.getMyRun(s.challenge.id).then((run) => setWorld({ s, run }));
  const jump = (h) => { s.clock.advance(h * HOUR_MS); setTick((n) => n + 1); };

  return (
    <main className="mx-auto max-w-2xl px-5 pb-28 pt-6">
      <div className="hatch rounded-2xl border border-dashed border-ink/25 p-3 text-xs font-semibold uppercase tracking-[0.12em] opacity-70">
        Preview — fictional challenge run. Synthetic data. Nothing is saved or sent.
      </div>
      <nav className="mt-3 flex flex-wrap gap-1.5 text-xs">
        {PHASES.map((p) => (
          <Link key={p} to={`/__preview/challenge?phase=${p}`}
            className={`rounded-full px-2.5 py-1 ${p === phase ? "bg-ink text-paper" : "border border-ink/15 opacity-70"}`}>
            {p}
          </Link>
        ))}
      </nav>
      {world.run && !["rewarded", "completed", "incomplete", "failed"].includes(phase) && (
        <p className="mt-2 text-xs opacity-60">
          Synthetic clock: {new Date(s.clock.now()).toLocaleString()} ·{" "}
          <button type="button" onClick={() => jump(20)} className="underline">jump +20 hours</button>
        </p>
      )}

      <div className="mt-8">
        {world.run ? (
          <>
            <p className="kicker">{s.challenge.title}</p>
            <ChallengeRun key={`${phase}-${tick}`} challenge={s.challenge} standards={s.standards} run={world.run}
              onRunChange={refreshRun} api={s.api} />
          </>
        ) : (
          <ChallengeOverview challenge={s.challenge} standards={s.standards} footer={`Free · ${s.challenge.duration_days} days`}>
            <button type="button" disabled className="btn-primary min-h-[44px] w-full py-3 text-base opacity-70">
              Start free — send me a code
            </button>
          </ChallengeOverview>
        )}
      </div>
    </main>
  );
}
