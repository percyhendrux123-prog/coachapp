import { parsePromoUrl } from "../lib/promo";

export default function PromoStage({ url, emptyHint }) {
  const embed = parsePromoUrl(url);

  return (
    <section className="w-full" aria-label="Current briefing">
      <div className="relative w-full overflow-hidden rounded-2xl border border-ink/15 bg-ink aspect-video">
        {embed.kind === "youtube" || embed.kind === "vimeo" ? (
          <iframe
            className="absolute inset-0 h-full w-full border-0"
            src={embed.src}
            title="Current briefing"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        ) : embed.kind === "file" ? (
          <video
            className="absolute inset-0 h-full w-full object-cover"
            src={embed.src}
            autoPlay
            muted
            loop
            playsInline
            controls
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center text-paper">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-brand">
              Live briefing
            </p>
            <p className="display mt-3 text-2xl md:text-3xl">
              {embed.kind === "invalid"
                ? "That link is not a YouTube, Vimeo, or video file."
                : "The current reel plays here."}
            </p>
            <p className="mt-2 max-w-[36ch] text-sm opacity-60">
              {emptyHint || "Same window empty or playing. Paste a link below."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
