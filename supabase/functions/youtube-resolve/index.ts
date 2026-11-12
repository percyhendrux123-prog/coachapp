// youtube-resolve — turn a pasted YouTube link into title/description/thumbnail.
// (verify_jwt=false; auth self-handled, same as the other functions here.)
//
// POST { url }  (Bearer JWT required; caller must be a coach)
//   -> 200 { ok: true, video: {...} }
//   -> 200 { ok: false, reason, message }   <- a resolvable "no", not a crash
// GET -> health check, and reports whether the Data API key is configured.
//
// WHY THIS IS A SERVER FUNCTION AND NOT A FETCH FROM THE BROWSER.
//   1. YouTube's oEmbed endpoint sends no Access-Control-Allow-Origin, so a
//      browser cannot read the response.
//   2. The Data API needs a key, and a key inlined into the Vite bundle is
//      public. This repo has been burned once by a VITE_ variable becoming a
//      literal in a production chunk (see vite.config.js). The key stays here.
//
// THE DESCRIPTION PROBLEM — READ BEFORE "FIXING" THE FALLBACK.
//   Data API v3   title + DESCRIPTION + channel + duration + embeddable.
//                 Needs YOUTUBE_API_KEY. videos.list costs 1 unit of a
//                 10,000/day free quota, so it is not a real limit here.
//   oEmbed        title + channel + thumbnail. NO DESCRIPTION, ever — it is
//                 not in the oEmbed response schema.
// With no key we resolve the title and cannot resolve the description. That is
// reported as description_status 'unavailable' and rendered as a visible
// notice, never as an empty description box. An empty box would assert "this
// video has no description" — a different and possibly false claim — and would
// stop anyone ever asking why.
import { admin, callerUserId, json, CORS } from "../_shared/challenge.ts";

const API_KEY = Deno.env.get("YOUTUBE_API_KEY") || "";

// youtu.be/ID · /watch?v=ID · /shorts/ID · /embed/ID · /live/ID · /v/ID · bare id
function parseYouTubeId(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const ok = (v: string | null | undefined) =>
    v && /^[A-Za-z0-9_-]{11}$/.test(v) ? v : null;
  if (host === "youtu.be") return ok(u.pathname.split("/")[1]);
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com" ||
      host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") return ok(u.searchParams.get("v"));
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
    if (m) return ok(m[1]);
  }
  return null;
}

// PT1H2M3S -> 3723. null rather than 0 on anything unparseable: 0 would claim
// the video is zero seconds long, which is a fact we do not have.
function parseISODuration(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  if (!d && !h && !mi && !s) return null;
  return (+(d || 0)) * 86400 + (+(h || 0)) * 3600 + (+(mi || 0)) * 60 + (+(s || 0));
}

function bestThumb(thumbs: Record<string, { url?: string }> | undefined): string | null {
  if (!thumbs) return null;
  for (const k of ["maxres", "standard", "high", "medium", "default"]) {
    if (thumbs[k]?.url) return thumbs[k]!.url!;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") {
    return json({
      ok: true,
      service: "youtube-resolve",
      data_api_key_configured: !!API_KEY,
      description_support: API_KEY ? "full" : "titles only — set YOUTUBE_API_KEY for descriptions",
    });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "authentication required" }, 401);

  const { data: prof } = await admin()
    .from("profiles").select("role").eq("user_id", userId).maybeSingle();
  if (!prof || prof.role !== "coach") return json({ error: "coach only" }, 403);

  let body: { url?: string } = {};
  try { body = await req.json(); } catch { /* handled below */ }

  const id = parseYouTubeId(body?.url ?? "");
  if (!id) {
    return json({
      ok: false,
      reason: "not_a_youtube_url",
      message: "That doesn't look like a YouTube link. Paste the address from the browser bar or the Share button — youtube.com/watch?v=… or youtu.be/…",
    });
  }

  // ---- Preferred path: Data API v3 (the only one that returns a description).
  if (API_KEY) {
    try {
      const r = await fetch(
        "https://www.googleapis.com/youtube/v3/videos" +
        `?part=snippet,contentDetails,status&id=${encodeURIComponent(id)}&key=${encodeURIComponent(API_KEY)}`,
      );
      const payload = await r.json().catch(() => null);

      if (r.ok && payload) {
        const item = payload.items?.[0];
        if (!item) {
          // The API returns an empty list for all three cases and cannot tell
          // them apart. Naming one would be a guess, so name all three.
          return json({
            ok: false,
            reason: "not_found",
            message: "YouTube returned nothing for this video. It's private, it's been deleted, or the link is wrong.",
          });
        }
        const sn = item.snippet ?? {};
        const desc: string = sn.description ?? "";
        return json({
          ok: true,
          video: {
            youtube_id: id,
            title: sn.title ?? "",
            description: desc.trim() ? desc : null,
            description_status: desc.trim() ? "fetched" : "empty_on_youtube",
            channel_title: sn.channelTitle ?? null,
            thumbnail_url: bestThumb(sn.thumbnails),
            duration_seconds: parseISODuration(item.contentDetails?.duration),
            embeddable: item.status?.embeddable !== false,
            privacy_status: item.status?.privacyStatus ?? null,
            source: "data_api",
          },
        });
      }

      // A bad/blocked/over-quota key must not silently degrade into a
      // description-less result that looks like a normal success. Fall through
      // for the title, but the status stays 'unavailable'.
      console.error("youtube-resolve: Data API error", r.status, payload?.error?.message);
    } catch (e) {
      console.error("youtube-resolve: Data API fetch threw", e);
    }
  }

  // ---- Fallback: oEmbed. Title yes, description never.
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`,
    );
    if (r.status === 401 || r.status === 403) {
      return json({
        ok: false,
        reason: "private_or_removed",
        message: "YouTube says this video is private. Only public or unlisted videos can be shown to your clients.",
      });
    }
    if (r.status === 404 || r.status === 400) {
      return json({
        ok: false,
        reason: "not_found",
        message: "No video exists at that link. Check the address and try again.",
      });
    }
    if (!r.ok) {
      return json({
        ok: false,
        reason: "upstream_error",
        message: `YouTube didn't answer (HTTP ${r.status}). Try again in a moment.`,
      });
    }

    const o = await r.json();
    return json({
      ok: true,
      video: {
        youtube_id: id,
        title: o.title ?? "",
        description: null,
        description_status: "unavailable",
        description_unavailable_because: API_KEY
          ? "YouTube's description API didn't answer. You can write one yourself."
          : "Descriptions need a YouTube API key, which isn't set up yet. You can write one yourself.",
        channel_title: o.author_name ?? null,
        thumbnail_url: o.thumbnail_url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        duration_seconds: null,
        embeddable: true,
        privacy_status: null,
        source: "oembed",
      },
    });
  } catch (e) {
    console.error("youtube-resolve: oEmbed fetch threw", e);
    return json({
      ok: false,
      reason: "upstream_error",
      message: "Couldn't reach YouTube just then. Try again in a moment.",
    });
  }
});
