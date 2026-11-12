import { useEffect, useMemo, useState } from "react";
import { listClientPhotoTimeline, signPhotoPaths, defaultComparePair, emptyPhotosReason } from "../lib/progressPhotos";
import { getTenantConfig } from "../lib/settings";
import { getCheckinConfig } from "../lib/client";

// Coach-side check-in photo evaluation (2026-08-30). Clients have been uploading these
// since check-ins shipped; this is the first coach surface that shows them. Everything
// renders through short-lived signed URLs — the bucket is private and stays private.
//
// Review fixes (same day): every async effect carries a cancellation guard so a slow
// response for client A can never render under client B's name; signed URLs that
// expire (1h TTL) fall back to a visible "expired" plate with a refresh, never broken
// image glyphs; and a truncated timeline says so instead of presenting the cap as the
// client's total.

// Thumbnails for one check-in's attached photos, inline in the check-in row. When the
// parent already signed the paths (the Checkins list batches one signing call for all
// rows), pass the Map via `urls`; without it the component signs its own. A path that
// fails to sign renders as "could not load" — a system fact, never dropped.
export function CheckinPhotos({ paths, urls: urlsProp }) {
  const clean = useMemo(() => (paths ?? []).filter(Boolean), [paths]);
  const pathsKey = clean.join("\n");
  const [selfUrls, setSelfUrls] = useState(null);
  const [failed, setFailed] = useState(false);
  const [expired, setExpired] = useState(0); // bump to re-sign after TTL expiry

  const external = urlsProp != null;
  useEffect(() => {
    if (external || clean.length === 0) return;
    let cancelled = false;
    signPhotoPaths(clean)
      .then((m) => { if (!cancelled) { setSelfUrls(m); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pathsKey stands in for clean
  }, [external, pathsKey, expired]);

  const urls = external ? urlsProp : selfUrls;

  if (clean.length === 0) return null;
  if (failed) {
    return <p className="mt-2 text-xs opacity-60">{clean.length} photo{clean.length === 1 ? "" : "s"} attached — could not load them (failed read, the photos still exist).</p>;
  }
  if (urls == null) return <p className="mt-2 text-xs opacity-50">Loading {clean.length} photo{clean.length === 1 ? "" : "s"}…</p>;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {clean.map((path) => (
        <PhotoThumb key={path} url={urls.get(path)} onExpired={external ? null : () => setExpired((n) => n + 1)} />
      ))}
    </div>
  );
}

// One signed thumbnail with an expiry-aware error path: a URL that 403s (the 1-hour
// TTL passed while the tab sat open) renders a refresh plate instead of a broken glyph.
function PhotoThumb({ url, onExpired, className = "h-24 w-20" }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [url]);

  if (!url) {
    return (
      <div className={`flex ${className} items-center justify-center rounded-lg border border-dashed border-ink/20 p-1 text-center text-[10px] opacity-50`}>
        could not load
      </div>
    );
  }
  if (broken) {
    return (
      <button
        type="button"
        onClick={onExpired ?? undefined}
        className={`flex ${className} items-center justify-center rounded-lg border border-dashed border-ink/20 p-1 text-center text-[10px] opacity-60`}
      >
        {onExpired ? "link expired — tap to refresh" : "link expired — reload the page"}
      </button>
    );
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" title="Open full size">
      <img src={url} alt="Check-in photo" loading="lazy" onError={() => setBroken(true)}
        className={`${className} rounded-lg border border-ink/10 object-cover`} />
    </a>
  );
}

// The Photos tab: full timeline plus a two-up compare. Empty states follow the
// twin-facts rule — see emptyPhotosReason.
export default function CoachClientPhotos({ clientId }) {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [urls, setUrls] = useState(new Map());
  const [failed, setFailed] = useState(false);
  // undefined = still loading; after load: { tenantPhotosOn, checkinFieldsPhotos }
  // (either field null when its read failed).
  const [collection, setCollection] = useState(undefined);
  const [beforeId, setBeforeId] = useState(null); // null = use the default pair
  const [afterId, setAfterId] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = () => setReloadTick((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    listClientPhotoTimeline(clientId)
      .then(async ({ photos, total: t }) => {
        const m = await signPhotoPaths(photos.map((p) => p.photo_url));
        if (cancelled) return;
        setRows(photos);
        setTotal(t);
        setUrls(m);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [clientId, reloadTick]);

  // Fresh client, fresh compare selection (falls back to the default pair).
  useEffect(() => { setRows(null); setBeforeId(null); setAfterId(null); }, [clientId]);

  // Collection settings, only needed to phrase the empty state honestly.
  useEffect(() => {
    let cancelled = false;
    setCollection(undefined);
    Promise.allSettled([getTenantConfig(), getCheckinConfig()]).then(([t, c]) => {
      if (cancelled) return;
      setCollection({
        tenantPhotosOn: t.status === "fulfilled" ? (t.value?.progress_photos_on ?? true) : null,
        checkinFieldsPhotos: c.status === "fulfilled" ? (c.value?.fields?.photos ?? false) : null,
      });
    });
    return () => { cancelled = true; };
  }, [clientId, reloadTick]);

  if (failed) {
    return (
      <div role="alert">
        <p className="text-sm font-semibold">Could not read photos</p>
        <p className="mt-1 text-xs opacity-60">Failed load — not a statement that this client has no photos.</p>
        <button type="button" onClick={reload} className="btn-ghost mt-3 px-4 text-sm">Retry</button>
      </div>
    );
  }
  if (rows == null) return <p className="text-sm opacity-50">Loading photos…</p>;

  if (rows.length === 0) {
    // Still waiting on the settings reads: that's a loading state, not the "settings
    // unreadable" verdict — the two must never share a rendering.
    if (collection === undefined) return <p className="text-sm opacity-50">No photos yet — checking whether photos are being collected…</p>;
    const reason = emptyPhotosReason(collection);
    return (
      <div className="rounded-xl border border-dashed border-ink/20 p-4">
        {reason === "zero" && (
          <>
            <p className="text-sm font-semibold">No photos submitted.</p>
            <p className="mt-1 text-xs opacity-60">Photo prompts are on for this tenant — this client has not sent any with their check-ins.</p>
          </>
        )}
        {reason === "not_tracked" && (
          <>
            <p className="text-sm font-semibold">Photos are not being collected.</p>
            <p className="mt-1 text-xs opacity-60">The photo prompt is switched off (Settings, or the check-in question set). Not a miss by the client — nothing asked, nothing owed.</p>
          </>
        )}
        {reason === "unknown" && (
          <>
            <p className="text-sm font-semibold">No photos on file — and the collection settings could not be read.</p>
            <p className="mt-1 text-xs opacity-60">Cannot tell whether this is a client who skipped photos or a tenant not collecting them. Retry to check again.</p>
            <button type="button" onClick={reload} className="btn-ghost mt-3 px-4 text-sm">Retry</button>
          </>
        )}
      </div>
    );
  }

  const byId = new Map(rows.map((p) => [p.id, p]));
  const defaultPair = defaultComparePair(rows);
  const before = byId.get(beforeId) ?? defaultPair?.before ?? null;
  const after = byId.get(afterId) ?? defaultPair?.after ?? null;
  const truncated = total > rows.length;

  return (
    <div className="space-y-6">
      {rows.length >= 2 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] opacity-60">Compare</h3>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <ComparePane label="Before" photo={before} url={before ? urls.get(before.photo_url) : null}
              options={rows} onPick={setBeforeId} onExpired={reload} />
            <ComparePane label="After" photo={after} url={after ? urls.get(after.photo_url) : null}
              options={rows} onPick={setAfterId} onExpired={reload} />
          </div>
        </section>
      )}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] opacity-60">
          {truncated
            ? `Timeline · newest ${rows.length - 1} of ${total}, plus the earliest for compare`
            : `Timeline · ${rows.length} photo${rows.length === 1 ? "" : "s"}, newest first`}
        </h3>
        {truncated && (
          <p className="mt-1 text-xs opacity-50">
            {total - rows.length} older photo{total - rows.length === 1 ? "" : "s"} not shown here — the earliest is included so the compare starts at day one.
          </p>
        )}
        <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
          {rows.map((p) => (
            <figure key={p.id}>
              <PhotoThumb url={urls.get(p.photo_url)} onExpired={reload} className="aspect-[3/4] w-full" />
              <figcaption className="mt-1 text-[11px] opacity-60">
                {dateLabel(p.taken_at)}{p.pose_tag ? ` · ${p.pose_tag}` : ""}
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
    </div>
  );
}

function ComparePane({ label, photo, url, options, onPick, onExpired }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [url]);
  return (
    <div>
      <label className="block text-[11px] font-bold uppercase tracking-[0.12em] opacity-45">
        {label}
        <select
          value={photo?.id ?? ""}
          onChange={(e) => onPick(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-ink/15 px-2 py-1.5 text-xs font-normal normal-case tracking-normal"
        >
          {options.map((p) => (
            <option key={p.id} value={p.id}>{dateLabel(p.taken_at)}{p.pose_tag ? ` · ${p.pose_tag}` : ""}</option>
          ))}
        </select>
      </label>
      {url && !broken ? (
        <img src={url} alt={`${label}: ${dateLabel(photo?.taken_at)}`} onError={() => setBroken(true)}
          className="mt-2 w-full rounded-xl border border-ink/10 object-cover" />
      ) : (
        <button type="button" onClick={onExpired}
          className="mt-2 flex aspect-[3/4] w-full items-center justify-center rounded-xl border border-dashed border-ink/20 text-xs opacity-60">
          {broken ? "link expired — tap to refresh" : "could not load — tap to retry"}
        </button>
      )}
    </div>
  );
}

function dateLabel(iso) {
  if (!iso) return "unknown date";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
