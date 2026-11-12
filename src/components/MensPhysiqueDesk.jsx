import { MENS_PHYSIQUE_RADIO, MENS_PHYSIQUE_RULE_LINKS } from "../lib/mensPhysiqueDesk";

// Prep-only Brief shelf. Radio stays on this page. Rulebooks stay outbound links.
export default function MensPhysiqueDesk() {
  return (
    <section className="mt-8" aria-labelledby="mp-desk-title">
      <span className="kicker">Men’s Physique</span>
      <h3 id="mp-desk-title" className="display mt-1 text-xl md:text-2xl">
        Competitor desk
      </h3>
      <p className="mt-2 max-w-[46ch] text-sm opacity-60">
        Radio on this page. Official rules open in a new tab. We do not rewrite the federations.
      </p>

      <div className="mt-5">
        <div className="relative w-full overflow-hidden rounded-2xl border border-ink/15 bg-ink aspect-video">
          <iframe
            className="absolute inset-0 h-full w-full border-0"
            src={MENS_PHYSIQUE_RADIO.embedSrc}
            title="Men’s Physique Radio"
            allow="encrypted-media; picture-in-picture"
            allowFullScreen
          />
        </div>
        <a
          href={MENS_PHYSIQUE_RADIO.channelUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-xs font-semibold text-brand-fg hover:underline"
        >
          Open {MENS_PHYSIQUE_RADIO.handle} on YouTube
        </a>
      </div>

      <ul className="mt-5 space-y-2">
        {MENS_PHYSIQUE_RULE_LINKS.map((item) => (
          <li key={item.id} className="rounded-xl border border-ink/10 p-3">
            <p className="text-sm font-semibold">{item.title}</p>
            <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide opacity-60">
              {item.source}
            </p>
            <p className="mt-1.5 text-xs leading-relaxed opacity-70">{item.why}</p>
            <a
              href={item.href}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex text-xs font-semibold text-brand-fg hover:underline"
            >
              Open official rules
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
