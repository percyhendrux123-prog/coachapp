import { Link } from "react-router-dom";
import { PREVIEW_ROUTES_ENABLED } from "../lib/previewFlag";
import { PRIMARY_TABS } from "../lib/clientTabs";

export default function ClientPreview() {
  if (!PREVIEW_ROUTES_ENABLED) {
    return (
      <main className="mx-auto max-w-xl px-5 py-16">
        <section className="glass p-6">
          <span className="kicker">Client coaching</span>
          <h1 className="display mt-2 text-2xl">Sign in to see your coaching</h1>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-5 pb-28 pt-6 sm:px-6">
      <div className="hatch rounded-2xl border border-dashed border-ink/25 p-3 text-xs font-semibold uppercase tracking-[0.12em] opacity-70">
        Preview — fictional client view. Not live data. Mutations are off.
      </div>

      <header className="mt-6">
        <span className="kicker">Demo Client A · Monday, 24 Aug</span>
        <h1 className="display mt-1 text-3xl sm:text-4xl">Your coaching</h1>
        <p className="mt-2 max-w-[52ch] text-sm opacity-60">
          One place for the plan, the next action, and the check-in that keeps the week visible.
        </p>
      </header>

      <section className="mt-6 overflow-hidden rounded-2xl bg-ink p-5 text-paper shadow-[0_20px_60px_-34px_rgba(10,10,10,0.7)] sm:p-6" aria-labelledby="today-heading">
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-paper/60">Today · Day 2 of 4</span>
            <h2 id="today-heading" className="display mt-2 text-2xl sm:text-3xl">Upper body</h2>
            <p className="mt-2 text-sm text-paper/65">Foundation block · 5 exercises</p>
          </div>
          <span className="rounded-full border border-paper/20 bg-paper/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-paper">
            Ready
          </span>
        </div>
        <p className="mt-5 border-l border-paper/25 pl-3 text-sm leading-relaxed text-paper/75">Leave one clean rep in reserve.</p>
        <button type="button" disabled className="mt-6 inline-flex min-h-[48px] w-full items-center justify-center rounded-xl bg-paper px-4 text-sm font-bold text-ink opacity-80">
          Open workout
        </button>
        <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
          <button type="button" disabled className="flex min-h-[48px] items-center justify-between rounded-xl border border-paper/15 bg-paper/[0.06] px-3 text-sm">
            <span>Meals</span><span className="font-bold tabular-nums">2/4</span>
          </button>
          <button type="button" disabled className="min-h-[48px] rounded-xl border border-paper/15 bg-paper/[0.06] px-3 text-sm font-semibold">Check-in</button>
        </div>
      </section>

      <section className="mt-4 grid gap-4 sm:grid-cols-2">
        <article className="glass p-5">
          <span className="kicker">Nutrition</span>
          <h2 className="display mt-1 text-xl">Meal plan</h2>
          <p className="mt-2 text-sm opacity-65">4 meals · 2,450 kcal target</p>
          <div className="mt-4 flex gap-2 text-xs font-semibold uppercase tracking-[0.1em]">
            <span className="rounded-full bg-ink/5 px-2 py-1">P 190g</span>
            <span className="rounded-full bg-ink/5 px-2 py-1">C 260g</span>
          </div>
        </article>
        <article className="glass p-5">
          <span className="kicker">Check-in</span>
          <h2 className="display mt-1 text-xl">Friday reflection</h2>
          <p className="mt-2 text-sm opacity-65">Weight, adherence, and what needs adjusting.</p>
          <Link to="/__preview/client?preview=check-in" className="btn-ghost mt-4 inline-flex min-h-[44px] items-center px-4">
            Open check-in
          </Link>
        </article>
      </section>

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-ink/10 bg-paper/95 px-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur" aria-label="Client preview navigation">
        <div className="mx-auto flex max-w-3xl items-stretch justify-between gap-0.5">
        {/* Derived from the real client bar — this was a hand copy and drifted once. */}
        {PRIMARY_TABS.map((t, i) => (
          <NavItem key={t.id} label={t.short} active={i === 0} />
        ))}
          <NavItem label="More" />
        </div>
      </nav>
    </main>
  );
}

function NavItem({ label, active = false }) {
  return (
    <span className={`relative flex min-h-[52px] min-w-0 flex-1 items-center justify-center px-0.5 py-2 text-center text-[11px] font-semibold leading-tight ${
      active ? "text-ink after:absolute after:inset-x-3 after:top-0 after:h-0.5 after:rounded-full after:bg-brand" : "text-ink/55"
    }`}>{label}</span>
  );
}
