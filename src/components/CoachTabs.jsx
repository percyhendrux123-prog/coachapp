import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";

// Coach navigation — Primary (daily path) + More (tools).
// Audit 2026-08-07: eleven equal tabs made rare tools compete with Home/Clients/Inbox.
// Mobile gets a fixed bottom bar (same idea as the client shell).

const PRIMARY = [
  { key: "brief", to: "/coach/brief", label: "Brief", short: "Brief" },
  { key: "home", to: "/coach", label: "Home", short: "Home" },
  { key: "clients", to: "/coach/clients", label: "Clients", short: "Clients" },
  { key: "inbox", to: "/coach/inbox", label: "Inbox", short: "Inbox" },
];

const MORE = [
  { key: "programs", to: "/coach/programs", label: "Programs" },
  { key: "cockpit", to: "/coach/cockpit", label: "Cockpit (drafts)" },
  { key: "calendar", to: "/coach/calendar", label: "Calendar" },
  { key: "activity", to: "/coach/activity", label: "Activity" },
  { key: "challenges", to: "/coach/challenges", label: "Challenges" },
  { key: "ai", to: "/coach/ai", label: "AI" },
  { key: "about", to: "/coach/about", label: "About" },
  { key: "settings", to: "/coach/settings", label: "Settings" },
  // Community was the one coach destination reachable only from the top bar, which is
  // why that bar could not shed it on a phone. Listing it here with the other tools is
  // additive — nothing moved out of the header until it had a second way in.
  { key: "community", to: "/community", label: "Community" },
];

const MORE_KEYS = new Set(MORE.map((t) => t.key));

function tabClass(isActive) {
  return `shrink-0 rounded-full px-3 py-3 text-sm transition min-h-[44px] touch-manipulation flex items-center ${
    isActive
      ? "bg-brand font-semibold text-brand-text"
      : "font-medium opacity-60 hover:opacity-100"
  }`;
}

function moreTileClass(isActive) {
  return `rounded-xl border px-3 py-3 text-left text-sm font-semibold transition min-h-[44px] touch-manipulation flex items-center ${
    isActive
      ? "border-brand bg-brand/10 text-ink"
      : "border-ink/10 bg-ink/[0.03] opacity-80 hover:opacity-100"
  }`;
}

export function CoachTabs({ active }) {
  const location = useLocation();
  const onPreviewRoute = location.pathname.startsWith("/__preview/");
  const hrefFor = (tab) => (
    onPreviewRoute && tab.key === "cockpit"
      ? "/__preview/coach-cockpit?preview=unseen"
      : tab.to
  );
  const onMore = MORE_KEYS.has(active);
  const [desktopMoreOpen, setDesktopMoreOpen] = useState(onMore);
  // Mobile must start closed even on Cockpit/Settings. A shared moreOpen plus
  // the onMore mount effect put the sheet over the metric cards on every load.
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  // Text scaling can make the bar taller than its nominal 60px. Dock the sheet above
  // the measured bar so the More controls stay reachable instead of being covered.
  const [mobileNav, setMobileNav] = useState(null);
  const [mobileNavHeight, setMobileNavHeight] = useState(60);

  // Desktop may keep the tool grid visible on a More destination. Mobile never
  // auto-opens — only the mobile More button toggles that sheet.
  useEffect(() => {
    if (onMore) setDesktopMoreOpen(true);
  }, [onMore]);

  useEffect(() => {
    if (!mobileNav) return undefined;
    const measure = () => {
      const height = Math.round(mobileNav.getBoundingClientRect().height) || 60;
      setMobileNavHeight(height);
      // Pages reserve this same measured height, so enlarged text cannot hide their
      // final controls behind the fixed bar after the More sheet was corrected.
      document.documentElement.style.setProperty("--coach-mobile-nav-height", `${height}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return () => document.documentElement.style.removeProperty("--coach-mobile-nav-height");
    }
    const observer = new ResizeObserver(measure);
    observer.observe(mobileNav);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--coach-mobile-nav-height");
    };
  }, [mobileNav]);

  return (
    <>
      {/* Desktop / tablet — primary strip + optional More grid */}
      <div className="hidden md:block">
        <nav
          className="glass no-scrollbar flex max-w-full items-center gap-1 overflow-x-auto rounded-full p-1.5 text-sm md:w-fit"
          aria-label="Coach primary"
        >
          {PRIMARY.map((t) => (
            <Link
              key={t.key}
              to={t.to}
              className={tabClass(active === t.key)}
              aria-current={active === t.key ? "page" : undefined}
            >
              {t.label}
            </Link>
          ))}
          <button
            type="button"
            onClick={() => setDesktopMoreOpen((v) => !v)}
            className={tabClass(onMore || desktopMoreOpen)}
            aria-expanded={desktopMoreOpen}
            aria-controls="coach-more-nav"
          >
            More
          </button>
        </nav>

        {desktopMoreOpen && (
          // Flex-wrap, not a fixed-column grid -- 7 tools in a 4-col grid left a bare
          // gap under "Settings" (3 of 4 cells filled on the second row). Wrapping
          // tiles by their own width means the row never implies a missing 4th tile.
          <div
            id="coach-more-nav"
            className="mt-3 flex flex-wrap gap-2"
          >
            {MORE.map((t) => (
              <Link
                key={t.key}
                to={hrefFor(t)}
                className={`grow-0 basis-[7.5rem] ${moreTileClass(active === t.key)}`}
                aria-current={active === t.key ? "page" : undefined}
                onClick={() => setDesktopMoreOpen(false)}
              >
                {t.label}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Mobile — More sheet docks above the fixed bar; primary bar stays pinned */}
      <div className="md:hidden">
        {mobileMoreOpen && (
          <div
            id="coach-more-nav-mobile"
            role="region"
            aria-label="More coach tools"
            style={{ bottom: `${mobileNavHeight}px` }}
            className="fixed inset-x-0 z-40 max-h-[min(50vh,22rem)] overflow-y-auto border-t border-ink/10 bg-paper/98 px-3 py-3 shadow-[0_-8px_24px_rgba(0,0,0,0.08)] backdrop-blur-md"
          >
            <div className="mx-auto grid max-w-6xl grid-cols-2 gap-2">
              {MORE.map((t) => (
                <Link
                  key={t.key}
                  to={hrefFor(t)}
                  className={moreTileClass(active === t.key)}
                  aria-current={active === t.key ? "page" : undefined}
                  onClick={() => setMobileMoreOpen(false)}
                >
                  {t.label}
                </Link>
              ))}
            </div>
          </div>
        )}

        <nav
          ref={setMobileNav}
          data-coach-mobile-nav
          className="fixed inset-x-0 bottom-0 z-50 border-t border-ink/10 bg-paper/95 px-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-md"
          aria-label="Coach primary"
        >
          <div className="mx-auto flex max-w-6xl items-stretch justify-between gap-0.5">
            {PRIMARY.map((t) => (
              <Link
                key={t.key}
                to={hrefFor(t)}
                aria-label={t.label}
                aria-current={active === t.key ? "page" : undefined}
                className={`relative flex min-h-[52px] min-w-0 flex-1 touch-manipulation items-center justify-center px-0.5 py-2 text-center text-[11px] font-semibold leading-tight transition ${
                  active === t.key
                    ? "text-ink after:absolute after:inset-x-3 after:top-0 after:h-0.5 after:rounded-full after:bg-brand"
                    : "text-ink/55"
                }`}
              >
                {t.short}
              </Link>
            ))}
            <button
              type="button"
              onClick={() => setMobileMoreOpen((v) => !v)}
              aria-label="More tools"
              aria-expanded={mobileMoreOpen}
              aria-controls="coach-more-nav-mobile"
              className={`relative flex min-h-[52px] min-w-0 flex-1 touch-manipulation items-center justify-center px-0.5 py-2 text-center text-[11px] font-semibold leading-tight transition ${
                onMore || mobileMoreOpen
                  ? "text-ink after:absolute after:inset-x-3 after:top-0 after:h-0.5 after:rounded-full after:bg-brand"
                  : "text-ink/55"
              }`}
            >
              More
            </button>
          </div>
        </nav>
      </div>
    </>
  );
}

export default CoachTabs;
