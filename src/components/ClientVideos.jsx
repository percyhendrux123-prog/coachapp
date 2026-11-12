import { useCallback, useEffect, useState } from "react";
import {
  listVideos, listMyAssignments, submitResponse,
  embedUrl, watchUrl, thumbFor, formatDuration, describeDescriptionState,
  clampDescription, displayTitle,
} from "../lib/videoLibrary";

// Client Videos tab — same chrome as Content. Assignments first (something owed),
// then the numbered shelf. Click-to-play so we do not fire a YouTube iframe per card.

export default function ClientVideos({ ctx }) {
  const [videos, setVideos] = useState(undefined);
  const [assignments, setAssignments] = useState(undefined);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    setVideos(undefined);
    setAssignments(undefined);
    try {
      const [v, a] = await Promise.all([listVideos(), listMyAssignments()]);
      setVideos(v); setAssignments(a);
    } catch (e) {
      setErr(e.message); setVideos(null); setAssignments(null);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (err) {
    return (
      <div className="glass border-dashed p-4 text-center" role="alert">
        <p className="text-sm font-semibold">Could not load Videos</p>
        <p className="mt-1 text-xs opacity-60">This is a failed read, not an empty shelf.</p>
        <button type="button" onClick={load} className="btn-ghost mt-4 px-4 text-sm">Retry Videos</button>
      </div>
    );
  }

  if (videos === undefined || assignments === undefined) {
    return <p className="text-sm opacity-60">Loading…</p>;
  }

  const outstanding = assignments.filter((a) => (a.video_assignment_responses ?? []).length === 0);
  const answered = assignments.filter((a) => (a.video_assignment_responses ?? []).length > 0);

  return (
    <div className="space-y-8">
      <div>
        <span className="kicker">Watch</span>
        <h2 className="display mt-1 text-2xl">Videos</h2>
        <p className="mt-1 text-xs opacity-60">
          What your coach assigned, then the shelf. Plays here. Vertical.
        </p>
      </div>

      {err && <p className="text-sm text-danger">{err}</p>}

      {outstanding.length > 0 && (
        <section>
          <span className="kicker">Assigned</span>
          <h3 className="display mt-1 text-xl">From your coach</h3>
          <ul className="mt-4 space-y-3">
            {outstanding.map((a) => (
              <AssignmentCard key={a.id} assignment={a} videos={videos} ctx={ctx} onDone={load} />
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="flex items-end justify-between gap-3">
          <div>
            <span className="kicker">Library</span>
            <h3 className="display mt-1 text-xl">The shelf</h3>
          </div>
          {videos.length > 0 && <span className="text-xs opacity-60">{videos.length}</span>}
        </div>
        {videos.length === 0 ? (
          <p className="mt-4 text-sm opacity-60">
            No videos on the shelf yet. When your coach adds one, it lands here.
          </p>
        ) : (
          <ol className="mt-4 space-y-3">
            {videos.map((v) => <VideoCard key={v.id} video={v} />)}
          </ol>
        )}
      </section>

      {answered.length > 0 && (
        <section>
          <span className="kicker">Done</span>
          <h3 className="display mt-1 text-xl">Your answers</h3>
          <ul className="mt-4 space-y-2">
            {answered.map((a) => {
              const r = a.video_assignment_responses[0];
              return (
                <li key={a.id} className="rounded-xl border border-ink/10 p-3 text-sm">
                  <p className="text-xs opacity-60">
                    {displayTitle(a.video_title)} · {new Date(r.submitted_at).toLocaleDateString()}
                  </p>
                  <p className="mt-0.5 text-xs italic opacity-60">{a.prompt}</p>
                  <p className="mt-1.5 whitespace-pre-line">{r.body}</p>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function AssignmentCard({ assignment: a, videos, ctx, onDone }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const shelf = videos.find((v) => v.id === a.video_id) ?? null;
  const stillOnShelf = !!shelf;
  const title = displayTitle(stillOnShelf ? shelf.title : a.video_title);

  async function send(e) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      await submitResponse({
        tenantId: ctx.tenantId, clientId: ctx.clientId,
        assignmentId: a.id, body,
      });
      setBody("");
      await onDone();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <li className="glass p-4">
      <div className="flex items-center gap-2">
        {stillOnShelf && (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-xs font-bold text-brand-text">
            {shelf.slot}
          </span>
        )}
        <span className="text-sm font-semibold leading-snug">{title}</span>
      </div>

      <p className="mt-2 text-sm">{a.prompt}</p>
      {a.due_on && (
        <p className="mt-0.5 text-xs opacity-60">By {new Date(`${a.due_on}T00:00:00`).toLocaleDateString()}</p>
      )}

      <div className="mt-3">
        <Player video={shelf ?? { youtube_id: a.video_youtube_id, title: a.video_title, embeddable: true }} />
      </div>
      {!stillOnShelf && (
        <p className="mt-1.5 text-xs opacity-60">
          This one is no longer in your coach’s library, but your task still stands.
        </p>
      )}

      <form onSubmit={send} className="mt-3">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3}
          placeholder="Your answer…"
          className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        {err && <p className="mt-1 text-sm text-danger">{err}</p>}
        <p className="mt-1 text-xs opacity-60">You can send this once — take a second with it.</p>
        <button disabled={busy || !body.trim()} className="btn-primary mt-2 min-h-[44px] px-3 py-1.5 text-sm">
          {busy ? "Sending…" : "Send answer"}
        </button>
      </form>
    </li>
  );
}

function VideoCard({ video }) {
  const [open, setOpen] = useState(false);
  const note = describeDescriptionState(video);
  return (
    <li className="rounded-xl border border-ink/10 bg-paper/40 p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink/5 text-xs font-bold">
          {video.slot}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug">{displayTitle(video.title)}</p>
          <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide opacity-60">
            {video.channel_title ?? ""}
            {formatDuration(video.duration_seconds) ? ` · ${formatDuration(video.duration_seconds)}` : ""}
          </p>
          {video.description
            ? <p className="mt-1.5 break-words text-xs opacity-70 leading-relaxed">{clampDescription(video.description)}</p>
            : note?.tone === "neutral" && <p className="mt-1.5 text-xs opacity-60">{note.text}</p>}
        </div>
      </div>
      <div className="mt-3">
        {open ? <Player video={video} /> : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="group relative mx-auto block w-full max-w-sm overflow-hidden rounded-xl border border-ink/10"
          >
            <img src={thumbFor(video)} alt="" className="aspect-[9/16] max-h-[28rem] w-full object-cover" />
            <span className="absolute inset-0 grid place-items-center bg-ink/25 transition group-hover:bg-ink/35">
              <span className="rounded-full bg-paper/90 px-4 py-2 text-sm font-semibold">Watch</span>
            </span>
          </button>
        )}
      </div>
    </li>
  );
}

function Player({ video }) {
  if (video.embeddable === false) {
    return (
      <a href={watchUrl(video.youtube_id)} target="_blank" rel="noreferrer"
        className="flex min-h-[44px] items-center justify-between rounded-lg border border-ink/15 px-3 py-2 text-sm">
        <span>Watch on YouTube</span>
        <span className="text-xs opacity-60">opens a new tab →</span>
      </a>
    );
  }
  return (
    <div className="mx-auto aspect-[9/16] max-h-[28rem] w-full max-w-sm overflow-hidden rounded-xl border border-ink/10 bg-ink/5">
      <iframe
        src={embedUrl(video.youtube_id)}
        title={displayTitle(video.title)}
        className="h-full w-full"
        allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
      />
    </div>
  );
}
