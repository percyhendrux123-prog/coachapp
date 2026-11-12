import { STANDARD_LINE, COACHING_APPLICATION_URL } from "../lib/systemMode";

let warned = false;

// The funnel, stated as a fact, not a pitch (spec §2.1 item 6). Renders only in self-serve;
// the caller guards on mode. With no application URL configured the line still renders —
// the missing link is reported once in the console, never papered over with a fake href.
export default function StandardCard({ compact = false }) {
  if (!COACHING_APPLICATION_URL && !warned) {
    warned = true;
    console.warn("StandardCard: COACHING_APPLICATION_URL is not set — rendering without a link");
  }
  return (
    <section className={`glass ${compact ? "px-4 py-3" : "p-5"} text-sm`} aria-label="Daily standards">
      <span className="kicker">Daily standards</span>
      <p className="mt-2 leading-relaxed">{STANDARD_LINE}</p>
      {COACHING_APPLICATION_URL ? (
        <a
          href={COACHING_APPLICATION_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost mt-3 inline-flex min-h-[44px] items-center text-xs"
        >
          Apply for coaching →
        </a>
      ) : null}
    </section>
  );
}
