import { useEffect, useRef, useState } from "react";
import { getTenantConfig, saveTenantConfig } from "../lib/settings";
import { validateReelFile, uploadedReelPath, REEL_MIME_EXT } from "../lib/promo";
import { supabase } from "../lib/supabase";
import PromoStage from "./PromoStage";

// Coach Home add-link. Paste a URL, tap Set. Stored on the tenant so every
// device sees the same briefing. Same field as Settings → Welcome video.
export default function PromoLinkField({ tenantId }) {
  const [url, setUrl] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    getTenantConfig()
      .then((c) => {
        if (cancelled) return;
        const next = c?.welcome_video_url ?? "";
        setUrl(next);
        setDraft(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  async function save(e) {
    e.preventDefault();
    if (!tenantId) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    const next = draft.trim();
    try {
      // If the current reel is a file WE uploaded and this save replaces or clears
      // it, the file must actually come down — "Cleared" while the old video stays
      // publicly reachable in the brand bucket is a lie to the coach. Pasted links
      // are never touched (uploadedReelPath returns null for them).
      const retiredUpload = next !== url ? uploadedReelPath(url) : null;
      await saveTenantConfig({
        tenantId,
        welcome_video_url: next || null,
      });
      if (retiredUpload) {
        await supabase.storage.from("brand").remove([retiredUpload]).catch(() => {});
      }
      setUrl(next);
      setNote(next ? "Link saved. This is now the current briefing." : "Cleared. Empty plate is showing.");
    } catch (e2) {
      setErr(e2.message || "Could not save the link.");
    } finally {
      setBusy(false);
    }
  }

  // Upload an mp4/.mov/.webm reel into the public brand bucket and point the SAME
  // welcome_video_url field at it. Replacing one of our own previous uploads removes
  // the old file; pasted links are never touched (uploadedReelPath returns null).
  async function uploadReel(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file after a failure
    if (!file || !tenantId || busy) return;
    const check = validateReelFile(file);
    if (!check.ok) { setErr(check.error); return; }
    setBusy(true); setErr(null); setNote(null);
    try {
      const previousUpload = uploadedReelPath(url);
      const path = `${tenantId}/brief-video/${crypto.randomUUID()}.${REEL_MIME_EXT[file.type]}`;
      const { error: upErr } = await supabase.storage.from("brand")
        .upload(path, file, { contentType: file.type });
      if (upErr) throw upErr;
      const next = supabase.storage.from("brand").getPublicUrl(path).data.publicUrl;
      try {
        await saveTenantConfig({ tenantId, welcome_video_url: next });
      } catch (saveErr) {
        // The file reached storage but nothing points at it — remove the orphan
        // rather than leaving an invisible public video, then report the real failure.
        await supabase.storage.from("brand").remove([path]).catch(() => {});
        throw saveErr;
      }
      setUrl(next);
      setDraft(next);
      if (previousUpload) {
        // Best-effort: the new reel is already live; a stray old file is cosmetic.
        await supabase.storage.from("brand").remove([previousUpload]).catch(() => {});
      }
      setNote(
        check.warning
          ? `Uploaded and set as the current briefing. Heads up: ${check.warning}`
          : "Uploaded and set as the current briefing.",
      );
    } catch (e2) {
      setErr(e2.message || "Could not upload the video.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 space-y-3">
      <PromoStage url={url} />
      <form onSubmit={save} className="glass p-4">
        <label htmlFor="coach-promo-url" className="text-xs font-semibold uppercase tracking-[0.12em] opacity-60">
          Add link
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="coach-promo-url"
            type="url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste YouTube, Vimeo, or https://…mp4"
            className="min-h-[44px] min-w-0 flex-1 rounded-xl border border-ink/15 px-3 py-2 text-sm"
          />
          <button type="submit" disabled={busy} className="btn-primary min-h-[44px] px-4 disabled:opacity-50">
            {busy ? "Saving…" : "Set"}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,video/webm" className="hidden" onChange={uploadReel} />
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className="btn-ghost min-h-[44px] px-4 text-sm disabled:opacity-50">
            {busy ? "Working…" : "or upload a video"}
          </button>
          <span className="text-xs opacity-50">mp4, .mov, or .webm · up to 50 MB · mp4 plays on every device</span>
        </div>
        <p className="mt-2 text-xs opacity-50">
          Paste a link or upload a file. This appears on coach and client Brief. The first-session briefing is built in and does not change here.
        </p>
        {note && <p className="mt-2 text-sm opacity-70">{note}</p>}
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      </form>
    </div>
  );
}
