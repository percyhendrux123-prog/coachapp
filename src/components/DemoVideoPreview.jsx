import { useState } from "react";

// Exercise demo: still until tapped. Never hover-play, never in-view autoplay.
// Used on the client Program tab and the coach's client-program preview.

// Demo player behind a disclosure (implementation): a list of exercises shows short rows, and
// the player mounts only when asked for. A real toggle — the trigger stays in the DOM
// (keyboard focus survives, aria-expanded reflects state) and tapping again unmounts
// the player, so an opened or playing demo can always be put away.
export function DemoDisclosure({ url, label }) {
  const [open, setOpen] = useState(false);
  if (!url) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Watch"} ${label}`}
        className="inline-flex min-h-[44px] items-center text-xs font-semibold text-brand-fg"
      >
        {open ? "Hide demo ▾" : "Watch demo ▸"}
      </button>
      {open && <DemoVideoPreview url={url} label={label} compact />}
    </div>
  );
}

function youtubeId(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
    if (u.hostname.includes("youtube.com")) {
      if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || null;
      // Shorts are a natural fit for exercise demos; parsePromoUrl (promo.js) already
      // accepts them, so this parser must too or Shorts fall to the external-link fallback.
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
      return u.searchParams.get("v");
    }
  } catch { /* not a URL */ }
  return null;
}

function isDirectVideo(url) {
  if (!url) return false;
  return /\.(mp4|webm|ogg|mov)(\?|$)/i.test(url) || (url.includes("supabase") && url.includes("video"));
}

export default function DemoVideoPreview({ url, label = "Demo", compact = false }) {
  const [playing, setPlaying] = useState(false);
  const yt = youtubeId(url);
  const direct = isDirectVideo(url);

  if (!url) return null;

  // One frame for every demo regardless of source (implementation): 16:9, cover-cropped, dark
  // overlay, one play affordance. Source thumbnails vary wildly (crop, lighting,
  // third-party overlays) — the frame is the part this app controls. The 16:9 shape is
  // an invariant; `compact` only bounds width.
  const width = compact ? "max-w-sm" : "";

  if (!yt && !direct) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-fg underline"
      >
        {label} ↗
      </a>
    );
  }

  return (
    <div className={`mt-2 aspect-video overflow-hidden rounded-lg border border-ink/10 bg-ink/[0.03] ${width} w-full`}>
      {playing ? (
        yt ? (
          <iframe
            title={label}
            className="h-full w-full"
            src={`https://www.youtube.com/embed/${yt}?autoplay=1&mute=0&controls=1&rel=0&playsinline=1`}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <video
            src={url}
            className="h-full w-full object-cover"
            playsInline
            controls
            autoPlay
            preload="metadata"
          />
        )
      ) : (
        <button
          type="button"
          className="relative flex h-full w-full items-center justify-center bg-ink/10"
          onClick={() => setPlaying(true)}
          aria-label={`Play ${label}`}
        >
          {yt && (
            <img
              src={`https://i.ytimg.com/vi/${yt}/hqdefault.jpg`}
              alt=""
              className="absolute inset-0 h-full w-full object-cover"
            />
          )}
          {/* Uniform scrim: whatever the source thumbnail looks like, the frame reads
              as this app's — and the play control always clears WCAG contrast. */}
          <span className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/25 to-black/10" aria-hidden="true" />
          <span className="relative inline-flex items-center gap-1.5 rounded-full bg-black/70 px-3.5 py-1.5 text-xs font-semibold text-white">
            <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M2 1.2v7.6c0 .5.55.8.98.55l6.06-3.8a.65.65 0 0 0 0-1.1L2.98.65A.65.65 0 0 0 2 1.2Z" /></svg>
            Play demo
          </span>
        </button>
      )}
    </div>
  );
}
