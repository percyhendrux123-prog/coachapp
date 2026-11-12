import { useCallback, useEffect, useState } from "react";
import {
  MAX_SLOTS, listVideos, resolveYouTube, addVideo, updateVideo, removeVideo,
  reorderVideos, thumbFor, watchUrl, formatDuration, describeDescriptionState,
} from "../lib/videoLibrary";

// The coach's video library, as a section of Settings.
//
// THE INTERACTION. Twelve numbered slots. Paste a YouTube link into one, the
// title and description come back from YouTube, edit either, order them, remove
// them. No upload pipeline, no transcoding, no storage bill — the coach curates
// links and YouTube does the hosting.
//
// The slot numbers are load-bearing, not decoration: the coach assigns work by
// saying "watch video 2", so the number a client sees has to be the number the
// coach sees, and it has to stay put until the coach moves it.
export default function VideoLibrarySettings({ tenantId, userId }) {
  const [rows, setRows] = useState(undefined);
  const [err, setErr] = useState(null);

  const load = useCallback(
    () => listVideos().then(setRows).catch((e) => { setErr(e.message); setRows([]); }),
    [],
  );
  useEffect(() => { load(); }, [load]);

  const full = (rows?.length ?? 0) >= MAX_SLOTS;

  async function move(index, delta) {
    const next = [...rows];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    // Renumber optimistically so the list doesn't jump while the write lands.
    setRows(next.map((v, i) => ({ ...v, slot: i + 1 })));
    try {
      await reorderVideos(next.map((v) => v.id));
      await load();
    } catch (e) { setErr(e.message); await load(); }
  }

  return (
    <section className="glass p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="section-title">Video library</h2>
        <span className="text-xs opacity-60">
          {rows === undefined ? "—" : `${rows.length} of ${MAX_SLOTS} slots used`}
        </span>
      </div>
      <p className="mt-1 text-xs opacity-60">
        Paste a YouTube link and it lands in the next free slot with its title and description.
        <b className="font-semibold text-ink opacity-80"> Clients see this list under More → Videos</b>
        {" "}on their app (same slot numbers). You can open any video below with Open / Preview.
        Assign specific videos from a client&apos;s Videos tab on Clients.
      </p>

      {rows === undefined ? (
        <p className="mt-4 text-sm opacity-60">Loading…</p>
      ) : (
        <>
          <AddVideo tenantId={tenantId} userId={userId} full={full} onAdded={load} />

          {err && <p className="mt-3 text-sm text-danger">{err}</p>}

          {rows.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-ink/20 p-4 text-center text-sm opacity-60">
              No videos yet. Paste a link above to fill slot 1.
            </p>
          ) : (
            <ol className="mt-4 space-y-2">
              {rows.map((v, i) => (
                <VideoRow key={v.id} video={v} index={i} count={rows.length}
                  onMove={move} onChanged={load} onError={setErr} />
              ))}
            </ol>
          )}

          {full && (
            <p className="mt-3 text-xs opacity-60">
              All {MAX_SLOTS} slots are full. Remove one to make room — the limit keeps the list
              short enough that a slot number still means something to a client.
            </p>
          )}
        </>
      )}
    </section>
  );
}

// Paste → resolve → confirm. The confirm step exists because the title that
// comes back from YouTube is frequently not the title a coach wants a client to
// read ("FULL PUSH DAY | 4 WEEKS OUT | RAW"), and fixing it after saving is a
// second trip.
function AddVideo({ tenantId, userId, full, onAdded }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [draft, setDraft] = useState(null); // resolved video awaiting confirmation

  async function resolve(e) {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setProblem(null); setBusy(true);
    try {
      const res = await resolveYouTube(url.trim());
      if (!res.ok) { setProblem(res.message); return; }
      setDraft({
        ...res.video,
        source_url: url.trim(),
        _title: res.video.title ?? "",
        _description: res.video.description ?? "",
      });
    } finally { setBusy(false); }
  }

  async function save() {
    setProblem(null); setBusy(true);
    try {
      await addVideo({
        tenantId, createdBy: userId, video: draft,
        title: draft._title, description: draft._description,
      });
      setDraft(null); setUrl("");
      await onAdded();
    } catch (e) { setProblem(e.message); } finally { setBusy(false); }
  }

  if (full && !draft) return null;

  return (
    <div className="mt-4">
      {!draft ? (
        <form onSubmit={resolve} className="flex gap-2">
          <input value={url} onChange={(e) => { setUrl(e.target.value); setProblem(null); }}
            placeholder="Paste a YouTube link — youtube.com/watch?v=… or youtu.be/…"
            className="flex-1 rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          <button disabled={busy || !url.trim()} className="btn-primary shrink-0 px-3 py-1.5 text-sm">
            {busy ? "Checking…" : "Add"}
          </button>
        </form>
      ) : (
        <div className="rounded-lg border border-ink/20 p-3">
          <div className="flex gap-3">
            <img src={thumbFor(draft)} alt="" className="h-16 w-28 shrink-0 rounded-md object-cover" />
            <div className="min-w-0 flex-1 text-xs opacity-60">
              <p className="truncate">{draft.channel_title ?? "Unknown channel"}</p>
              {formatDuration(draft.duration_seconds) && <p>{formatDuration(draft.duration_seconds)}</p>}
              <p className="truncate">youtu.be/{draft.youtube_id}</p>
            </div>
          </div>

          <label className="mt-3 block text-xs font-medium">Title</label>
          <input value={draft._title} onChange={(e) => setDraft({ ...draft, _title: e.target.value })}
            className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" />

          <label className="mt-3 block text-xs font-medium">Description</label>
          <textarea value={draft._description} rows={3}
            onChange={(e) => setDraft({ ...draft, _description: e.target.value })}
            placeholder={draft.description_status === "unavailable" ? "Write what this video is for…" : ""}
            className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" />

          {/* The two empty states, kept apart. One is a fact about the video,
              the other is a fact about our setup — never rendered the same. */}
          {draft.description_status === "unavailable" && !draft._description && (
            <p className="mt-1.5 rounded-md border border-brand/30 bg-brand/5 px-2 py-1.5 text-xs text-ink">
              {draft.description_unavailable_because
                ?? "Description couldn't be pulled from YouTube."} The title came through fine.
            </p>
          )}
          {draft.description_status === "empty_on_youtube" && !draft._description && (
            <p className="mt-1.5 text-xs opacity-60">This video has no description on YouTube. Add your own if you want one.</p>
          )}
          {draft.embeddable === false && (
            <p className="mt-1.5 rounded-md border border-brand/30 bg-brand/5 px-2 py-1.5 text-xs text-ink">
              The owner has disabled embedding, so this one opens on YouTube in a new tab instead of playing inside your app.
            </p>
          )}

          {problem && <p className="mt-2 text-sm text-danger">{problem}</p>}

          <div className="mt-3 flex gap-2">
            <button onClick={save} disabled={busy} className="btn-primary px-3 py-1.5 text-sm">
              {busy ? "Saving…" : "Add to library"}
            </button>
            <button onClick={() => { setDraft(null); setProblem(null); }}
              className="rounded-md border border-ink/15 px-3 py-1.5 text-sm">Cancel</button>
          </div>
        </div>
      )}

      {problem && !draft && <p className="mt-2 text-sm text-danger">{problem}</p>}
    </div>
  );
}

function VideoRow({ video, index, count, onMove, onChanged, onError }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(video.title);
  const [description, setDescription] = useState(video.description ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const note = describeDescriptionState(video);

  async function save() {
    setBusy(true);
    try { await updateVideo(video.id, { title, description }); setEditing(false); await onChanged(); }
    catch (e) { onError(e.message); } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try { await removeVideo(video.id); await onChanged(); }
    catch (e) { onError(e.message); setBusy(false); }
  }

  return (
    <li className="rounded-lg border border-ink/10 p-3">
      <div className="flex gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink/5 text-xs font-bold">
          {video.slot}
        </span>
        <img src={thumbFor(video)} alt="" className="h-14 w-24 shrink-0 rounded-md object-cover" />

        <div className="min-w-0 flex-1">
          {editing ? (
            <>
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-md border border-ink/15 px-2 py-1 text-sm font-medium" />
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
                placeholder="Description"
                className="mt-1.5 w-full rounded-md border border-ink/15 px-2 py-1 text-xs" />
              <div className="mt-2 flex gap-2">
                <button onClick={save} disabled={busy} className="btn-primary px-2.5 py-1 text-xs">
                  {busy ? "Saving…" : "Save"}
                </button>
                <button onClick={() => { setEditing(false); setTitle(video.title); setDescription(video.description ?? ""); }}
                  className="rounded-md border border-ink/15 px-2.5 py-1 text-xs">Cancel</button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">{video.title}</p>
              <p className="mt-0.5 text-xs opacity-50">
                {video.channel_title ?? "Unknown channel"}
                {formatDuration(video.duration_seconds) ? ` · ${formatDuration(video.duration_seconds)}` : ""}
                {video.embeddable === false ? " · opens on YouTube" : ""}
              </p>
              {video.description
                ? <p className="mt-1.5 whitespace-pre-line text-xs opacity-70">{clamp(video.description)}</p>
                : note && (
                    <p className={`mt-1.5 text-xs ${note.tone === "warn" ? "text-brand-fg" : "opacity-50"}`}>
                      {note.text}
                    </p>
                  )}
            </>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
          <div className="flex gap-0.5">
            <button onClick={() => onMove(index, -1)} disabled={index === 0} aria-label="Move up"
              className="rounded border border-ink/15 px-1.5 leading-5 disabled:opacity-25">↑</button>
            <button onClick={() => onMove(index, 1)} disabled={index === count - 1} aria-label="Move down"
              className="rounded border border-ink/15 px-1.5 leading-5 disabled:opacity-25">↓</button>
          </div>
          {!editing && (
            <button onClick={() => setEditing(true)} className="underline opacity-60 hover:opacity-100">edit</button>
          )}
          <a href={watchUrl(video.youtube_id)} target="_blank" rel="noreferrer"
            className="underline opacity-60 hover:opacity-100">Open / preview</a>
          {confirmRemove ? (
            <span className="flex gap-1.5">
              <button onClick={remove} disabled={busy} className="text-danger underline">
                {busy ? "…" : "confirm"}
              </button>
              <button onClick={() => setConfirmRemove(false)} className="opacity-60 underline">no</button>
            </span>
          ) : (
            <button onClick={() => setConfirmRemove(true)} className="text-danger opacity-70 underline hover:opacity-100">
              remove
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

// YouTube descriptions run to hundreds of lines. Show the opening; the whole
// thing is one click away on YouTube itself.
function clamp(text, max = 220) {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}
