import { useCallback, useEffect, useState } from "react";
import { listSlides } from "../lib/briefSlides";
import { supabase } from "../lib/supabase";

// Read-only slide strip on the Brief tab — same component on the coach and client
// front doors, so the two can never drift. Self-fetching by default (brief_slides is
// readable tenant-wide via brief_slides_member_read; images are public brand-bucket
// URLs) — but when a parent already holds the rows (BriefSlidesManager), pass them
// via `slides` so one screen never runs two competing fetches of the same table.
//
// A failed read says "failed", never renders as "no slides" — the empty plate is a
// statement about the strip, not a fallback for an unreadable one.
export default function BriefSlideStrip({ slides }) {
  const external = slides !== undefined;
  const [selfRows, setSelfRows] = useState(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    return listSlides()
      .then((next) => { setSelfRows(next); setFailed(false); })
      .catch(() => { setFailed(true); });
  }, []);
  useEffect(() => { if (!external) load(); }, [external, load]);

  const rows = external ? slides : selfRows;

  if (!external && failed) {
    return (
      <div className="glass mt-4 border-dashed p-4 text-center" role="alert">
        <p className="text-sm font-semibold">Could not load the slides</p>
        <p className="mt-1 text-xs opacity-60">This is a failed read, not confirmation that no slides are set.</p>
        <button type="button" onClick={load} className="btn-ghost mt-3 px-4 text-sm">Retry slides</button>
      </div>
    );
  }
  if (rows == null) return null; // loading — the strip appears when it knows what it is
  if (rows.length === 0) return null; // genuinely no slides: the Brief stays reel-only, no empty shell

  return (
    <section className="mt-4" aria-label="Briefing slides">
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2">
        {rows.map((slide, i) => (
          <figure key={slide.id} className="w-[82%] max-w-md shrink-0 snap-center sm:w-[46%]">
            <div className="overflow-hidden rounded-2xl border border-ink/15 bg-ink">
              <img
                src={supabase.storage.from("brand").getPublicUrl(slide.image_path).data.publicUrl}
                alt={slide.caption || `Slide ${i + 1}`}
                loading="lazy"
                className="aspect-video w-full object-cover"
              />
            </div>
            {slide.caption && (
              <figcaption className="mt-1.5 px-1 text-xs opacity-60">{slide.caption}</figcaption>
            )}
          </figure>
        ))}
      </div>
    </section>
  );
}
