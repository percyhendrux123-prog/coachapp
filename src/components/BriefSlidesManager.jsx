import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_SLIDES, listSlides, addSlide, removeSlide, moveSlide, saveSlideCaption, validateSlideFile,
} from "../lib/briefSlides";
import { supabase } from "../lib/supabase";
import BriefSlideStrip from "./BriefSlideStrip";

// Coach-side slide management on the Brief tab: upload, caption, reorder, remove.
// The strip preview above the controls is the SAME component clients render, so what
// the coach sees while editing is exactly what the roster sees.
export default function BriefSlidesManager({ tenantId }) {
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const fileRef = useRef(null);

  // Returns the fetch promise so act() genuinely waits for the refresh — an
  // `await load()` on a void load resolves immediately and re-enables the buttons
  // against stale rows (the fast-double-click bug from the 2026-08-30 review).
  const load = useCallback(() => {
    setFailed(false);
    return listSlides()
      .then((next) => { setRows(next); setFailed(false); })
      .catch(() => { setFailed(true); });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(fn, doneNote) {
    if (busy) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      await fn();
      await load();
      if (doneNote) setNote(doneNote);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function onPick(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // same file can be re-picked after a failure
    if (!file) return;
    const check = validateSlideFile(file);
    if (!check.ok) { setErr(check.error); return; }
    act(() => addSlide({ tenantId, file, existing: rows }), "Slide added.");
  }

  const full = (rows?.length ?? 0) >= MAX_SLIDES;

  return (
    <div className="mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-[0.12em] opacity-60">Slides</h2>
      <p className="mt-1 max-w-[52ch] text-xs opacity-50">
        Stills under the reel — clients see the same strip. Marketing content only;
        never a client&apos;s photo or name.
      </p>

      {/* Same component clients render — fed from this screen's own rows, so the
          preview and the edit list below can never disagree, and a write costs one
          fetch instead of two. */}
      <BriefSlideStrip slides={rows ?? []} />

      {failed ? (
        <div className="glass mt-3 border-dashed p-4 text-center" role="alert">
          <p className="text-sm font-semibold">Could not load your slides for editing</p>
          <p className="mt-1 text-xs opacity-60">Failed read — not an empty strip.</p>
          <button type="button" onClick={load} className="btn-ghost mt-3 px-4 text-sm">Retry</button>
        </div>
      ) : rows == null ? (
        <p className="mt-3 text-sm opacity-50">Loading slides…</p>
      ) : (
        <div className="glass mt-3 p-4">
          {rows.length === 0 && (
            <p className="text-sm opacity-60">No slides yet. The Brief stays reel-only until you add one.</p>
          )}
          <ul className="space-y-2">
            {rows.map((slide, i) => (
              <SlideRow
                key={slide.id}
                slide={slide}
                index={i}
                count={rows.length}
                busy={busy}
                onMove={(dir) => act(() => moveSlide(rows, slide.id, dir))}
                onRemove={() => act(() => removeSlide(slide), "Slide removed.")}
                onCaption={(caption) => act(() => saveSlideCaption(slide.id, caption), "Caption saved.")}
              />
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={onPick} />
            <button
              type="button"
              disabled={busy || full}
              onClick={() => fileRef.current?.click()}
              className="btn-primary min-h-[44px] px-4 disabled:opacity-50"
            >
              {busy ? "Working…" : full ? `Full at ${MAX_SLIDES}` : "Add slide"}
            </button>
            <span className="text-xs opacity-50">{rows.length} of {MAX_SLIDES} · JPG, PNG, or WebP · up to 8 MB</span>
          </div>
          {note && <p className="mt-2 text-sm opacity-70">{note}</p>}
          {err && <p className="mt-2 text-sm text-danger" role="alert">{err}</p>}
        </div>
      )}
    </div>
  );
}

function SlideRow({ slide, index, count, busy, onMove, onRemove, onCaption }) {
  const [caption, setCaption] = useState(slide.caption ?? "");
  useEffect(() => { setCaption(slide.caption ?? ""); }, [slide.id, slide.caption]);
  const dirty = (caption.trim() || "") !== (slide.caption ?? "");

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-ink/10 p-2">
      <img
        src={supabase.storage.from("brand").getPublicUrl(slide.image_path).data.publicUrl}
        alt={slide.caption || `Slide ${index + 1}`}
        className="h-14 w-24 shrink-0 rounded-lg border border-ink/10 object-cover"
      />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-xs font-bold opacity-40">{index + 1}</span>
        <input
          type="text"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Caption (optional)"
          maxLength={200}
          className="min-h-[40px] min-w-0 flex-1 rounded-lg border border-ink/15 px-2 py-1 text-sm"
        />
        {dirty && (
          <button type="button" disabled={busy} onClick={() => onCaption(caption)} className="btn-ghost min-h-[40px] px-3 text-xs">
            Save
          </button>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button type="button" disabled={busy || index === 0} onClick={() => onMove("up")}
          aria-label={`Move slide ${index + 1} up`}
          className="btn-ghost min-h-[40px] px-2 text-sm disabled:opacity-30">↑</button>
        <button type="button" disabled={busy || index === count - 1} onClick={() => onMove("down")}
          aria-label={`Move slide ${index + 1} down`}
          className="btn-ghost min-h-[40px] px-2 text-sm disabled:opacity-30">↓</button>
        <button type="button" disabled={busy} onClick={onRemove}
          aria-label={`Remove slide ${index + 1}`}
          className="btn-ghost min-h-[40px] px-2 text-sm text-danger">Remove</button>
      </div>
    </li>
  );
}
