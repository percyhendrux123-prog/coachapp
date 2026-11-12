// Paste a YouTube, Vimeo, or direct video URL. Empty plate and playing
// video share the same 16:9 box. No JSON editing required.

export function parsePromoUrl(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { kind: "empty" };

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { kind: "invalid", raw: trimmed };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { kind: "invalid", raw: trimmed };
  }

  const host = url.hostname.replace(/^www\./, "");

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    if (!id) return { kind: "invalid", raw: trimmed };
    return youtubeEmbed(id);
  }

  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname.startsWith("/embed/")) {
      const id = url.pathname.split("/")[2];
      if (id) return youtubeEmbed(id);
    }
    if (url.pathname.startsWith("/shorts/")) {
      const id = url.pathname.split("/")[2];
      if (id) return youtubeEmbed(id);
    }
    const id = url.searchParams.get("v");
    if (id) return youtubeEmbed(id);
    return { kind: "invalid", raw: trimmed };
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts.find((p) => /^\d+$/.test(p));
    if (!id) return { kind: "invalid", raw: trimmed };
    return {
      kind: "vimeo",
      src: `https://player.vimeo.com/video/${id}?autoplay=1&muted=1&loop=1&title=0&byline=0&portrait=0`,
    };
  }

  if (/\.(mp4|webm|mov)(\?|$)/i.test(url.pathname)) {
    return { kind: "file", src: url.toString() };
  }

  return { kind: "invalid", raw: trimmed };
}

function youtubeEmbed(id) {
  return {
    kind: "youtube",
    src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&mute=1&loop=1&playlist=${encodeURIComponent(id)}&rel=0&modestbranding=1`,
  };
}

// ---------------------------------------------------------------------------
// Uploaded reels (2026-08-30). A coach can now upload an mp4/.mov/.webm instead of
// pasting a link. The file lands in the public `brand` bucket under
// <tenant>/brief-video/, and its public URL goes into the SAME
// welcome_video_url field — parsePromoUrl already plays direct file URLs, so the
// player needed no change. Pure helpers here; the upload itself is in the component.
// ---------------------------------------------------------------------------

export const REEL_MIME_EXT = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

// 50 MB — the Supabase platform's DEFAULT global upload cap, which is the only number
// verified to hold on this project (the live setting is not readable via the API we
// have; checked 2026-08-30). Raising this means two changes together: the dashboard's
// Storage upload limit, and this constant.
export const MAX_REEL_BYTES = 50 * 1024 * 1024;

// Validate a reel file before upload. `warning` is non-fatal: .mov from an iPhone is
// often HEVC-encoded, which Safari plays but Chrome/Android do not — the coach should
// hear that BEFORE the roster does.
export function validateReelFile(file) {
  if (!file) return { ok: false, error: "No file selected." };
  if (!(file.type in REEL_MIME_EXT)) {
    return { ok: false, error: "Upload an mp4, .mov, or .webm video." };
  }
  if (file.size > MAX_REEL_BYTES) {
    return { ok: false, error: "That video is over 50 MB. Export a smaller version (or paste a YouTube link instead)." };
  }
  return {
    ok: true,
    warning: file.type === "video/quicktime"
      ? ".mov files sometimes use a format Chrome and Android phones cannot play. For every device, export as mp4."
      : null,
  };
}

// If a welcome_video_url points at one of OUR uploaded reels (public brand-bucket URL
// under <tenant>/brief-video/), return its storage path so a replacement can clean it
// up. Any other URL — YouTube, Vimeo, an externally hosted file — returns null and is
// never touched.
export function uploadedReelPath(url) {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  let u;
  try { u = new URL(trimmed); } catch { return null; }
  const m = u.pathname.match(/\/storage\/v1\/object\/public\/brand\/(.+)$/);
  if (!m) return null;
  const path = decodeURIComponent(m[1]);
  return path.split("/")[1] === "brief-video" ? path : null;
}
