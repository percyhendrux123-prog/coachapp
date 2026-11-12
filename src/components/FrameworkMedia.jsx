// Renders a free-form framework / community media URL.
// Images and direct video files play inline. YouTube / Vimeo embed when the id
// is parseable. Anything else is a safe outbound link — never raw HTML inject.

function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
      if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || null;
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
      return u.searchParams.get("v");
    }
  } catch { /* not a URL */ }
  return null;
}

function vimeoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host !== "vimeo.com" && host !== "player.vimeo.com") return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const id = parts.find((p) => /^\d+$/.test(p));
    return id || null;
  } catch { return null; }
}

export default function FrameworkMedia({ url, className = "mt-4" }) {
  if (!url) return null;
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) {
    return <video src={url} controls playsInline className={`${className} w-full rounded-xl`} />;
  }
  if (/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(url)) {
    return <img src={url} alt="" className={`${className} w-full rounded-xl object-cover`} />;
  }
  const yt = youtubeId(url);
  if (yt && /^[A-Za-z0-9_-]{11}$/.test(yt)) {
    const frame = className.includes("aspect-")
      ? `${className} overflow-hidden rounded-xl border border-ink/10 bg-ink/5`
      : `${className} aspect-video overflow-hidden rounded-xl border border-ink/10 bg-ink/5`;
    return (
      <div className={frame}>
        <iframe
          title="Coach video"
          src={`https://www.youtube-nocookie.com/embed/${yt}`}
          className="h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
          loading="lazy"
        />
      </div>
    );
  }
  const vim = vimeoId(url);
  if (vim) {
    return (
      <div className={`${className} aspect-video overflow-hidden rounded-xl border border-ink/10 bg-ink/5`}>
        <iframe
          title="Coach video"
          src={`https://player.vimeo.com/video/${vim}`}
          className="h-full w-full"
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
          loading="lazy"
        />
      </div>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="btn-ghost mt-4 inline-block">
      Watch the video
    </a>
  );
}
