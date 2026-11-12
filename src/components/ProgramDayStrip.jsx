// Full program day picker — every day in the block is tappable, not only "this week."
// viewIndex = day the client is looking at; activeIndex = assignment.current_day_index.
//
// Phone geometry (observed 2026-08-15, TCL K33): at 360 CSS px the arrows leave the
// scroller ~211px, so the third chip rests sliced by the container edge — "DAY 3" reads
// "DA" and "Rest" reads "Re" plus half an s. Two things fix that and neither removes a
// control: scroll snapping so a chip can never come to rest half-cut, and scrolling the
// selected day into view so the client opens on where they actually are, not on Day 1.
import { useEffect, useRef } from "react";

export default function ProgramDayStrip({
  days,
  viewIndex,
  activeIndex,
  onSelect,
  title = "Your program",
}) {
  const scrollerRef = useRef(null);
  const settled = useRef(false);

  // Align the selected chip to its own snap point. Done by setting scrollLeft rather
  // than scrollIntoView so this can never scroll the page vertically — the Program tab
  // already owns that (Open workout → #client-program, fa72374).
  useEffect(() => {
    const box = scrollerRef.current;
    const chip = box?.children?.[viewIndex];
    if (!box || !chip) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({
      left: Math.max(0, chip.offsetLeft - 4),
      behavior: settled.current && !reduce ? "smooth" : "auto",
    });
    settled.current = true;
  }, [viewIndex, days?.length]);

  if (!Array.isArray(days) || days.length === 0) return null;

  return (
    <div>
      <div className="flex items-end justify-between gap-2">
        <h3 className="section-title">{title}</h3>
        <span className="text-[10px] uppercase tracking-wide opacity-60">
          Day {viewIndex + 1} / {days.length}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={viewIndex <= 0}
          onClick={() => onSelect(viewIndex - 1)}
          className="min-h-[44px] shrink-0 rounded-lg border border-ink/15 px-2.5 text-sm disabled:opacity-30"
          aria-label="Previous day"
        >
          ←
        </button>
        <div className="relative min-w-0 flex-1">
          <div
            ref={scrollerRef}
            className="no-scrollbar relative flex snap-x snap-mandatory scroll-pl-1 gap-1.5 overflow-x-auto pb-1"
          >
            {days.map((d, i) => {
              const training = d?.kind !== "rest";
              const isView = i === viewIndex;
              const isActive = i === activeIndex;
              const past = i < activeIndex;
              const label = d?.label || (training ? "Train" : "Rest");
              return (
                <button
                  key={d.day_id ?? i}
                  type="button"
                  onClick={() => onSelect(i)}
                  aria-current={isView ? "true" : undefined}
                  aria-label={`Day ${i + 1}, ${label}${isActive ? ", current day" : past ? ", done" : ""}`}
                  className={`w-[4.75rem] shrink-0 snap-start rounded-xl border px-1.5 py-2 text-center transition ${
                    isView
                      ? "border-brand bg-paper shadow-sm"
                      : "border-ink/10 bg-paper/40 hover:border-ink/25"
                  } ${past && !isView ? "opacity-70" : ""}`}
                >
                  <div className="text-[10px] uppercase opacity-60">Day {i + 1}</div>
                  {/* Clamp, not ellipsis: a two-word label ("Full body") and Android text
                      scaling both survive a second line, where truncate just eats them. */}
                  <div className="mt-0.5 line-clamp-2 text-[11px] font-semibold leading-tight">
                    {label}
                  </div>
                  <div className="mt-1 flex items-center justify-center gap-1">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${training ? "bg-brand" : "bg-ink/20"}`} />
                    {isActive && (
                      <span className="text-[9px] font-bold uppercase text-brand-fg">Now</span>
                    )}
                    {past && !isActive && (
                      <span className="text-[9px] uppercase opacity-60">Done</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          {/* Reads the cut edge as "more days this way" instead of a broken card. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-paper via-paper/70 to-transparent"
          />
        </div>
        <button
          type="button"
          disabled={viewIndex >= days.length - 1}
          onClick={() => onSelect(viewIndex + 1)}
          className="min-h-[44px] shrink-0 rounded-lg border border-ink/15 px-2.5 text-sm disabled:opacity-30"
          aria-label="Next day"
        >
          →
        </button>
      </div>
    </div>
  );
}
