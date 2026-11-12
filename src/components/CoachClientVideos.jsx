import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
  listVideos, listAssignmentsForClient, assignVideo, unassignVideo,
  markResponseSeen, thumbFor,
} from "../lib/videoLibrary";
import { DemoDisclosure } from "./DemoVideoPreview";

// Coach side of assignments, on the client's Videos tab: pick one off the
// shelf, say what you want back, read the answer.
//
// This is a prompt and a reply. Not a quiz, not a grade, not a completion
// percentage — the useful signal is whether the client wrote anything and what
// they chose to write.
export default function CoachClientVideos({ clientId, tenantId }) {
  const { user } = useAuth();
  const [videos, setVideos] = useState(undefined);
  const [rows, setRows] = useState(undefined);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const [v, a] = await Promise.all([listVideos(), listAssignmentsForClient(clientId)]);
      setVideos(v); setRows(a);
    } catch (e) { setErr(e.message); setVideos([]); setRows([]); }
  }, [clientId]);
  useEffect(() => { load(); }, [load]);

  if (videos === undefined || rows === undefined) return <Muted>Loading…</Muted>;

  return (
    <div className="space-y-5">
      {err && <p className="text-sm text-danger">{err}</p>}

      {videos.length === 0 ? (
        <p className="rounded-lg border border-dashed border-ink/20 p-4 text-sm opacity-70">
          Your video library is empty. Add videos under{" "}
          <Link to="/coach/settings" className="underline">Settings → Video library</Link>, then assign them here.
        </p>
      ) : (
        <AssignForm videos={videos} clientId={clientId} tenantId={tenantId}
          userId={user?.id} onAssigned={load} />
      )}

      {rows.length === 0 ? (
        <Muted>Nothing assigned yet.</Muted>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <AssignmentRow key={a.id} assignment={a} videos={videos} onChanged={load} onError={setErr} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AssignForm({ videos, clientId, tenantId, userId, onAssigned }) {
  const [videoId, setVideoId] = useState(videos[0]?.id ?? "");
  // the owner's own example, pre-filled. It is a good default prompt and it also
  // shows a coach what shape of ask this field is for.
  const [prompt, setPrompt] = useState("Watch this and post your favourite line.");
  const [dueOn, setDueOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const video = videos.find((v) => v.id === videoId);
    if (!video) return;
    setErr(null); setOk(false); setBusy(true);
    try {
      await assignVideo({ tenantId, clientId, video, prompt, dueOn, assignedBy: userId });
      setOk(true);
      await onAssigned();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-ink/15 p-3">
      <p className="text-sm font-medium">Assign a video</p>

      <select value={videoId} onChange={(e) => { setVideoId(e.target.value); setOk(false); }}
        className="mt-2 w-full rounded-md border border-ink/15 bg-paper px-2 py-1.5 text-sm">
        {videos.map((v) => <option key={v.id} value={v.id}>{v.slot}. {v.title}</option>)}
      </select>

      <textarea value={prompt} onChange={(e) => { setPrompt(e.target.value); setOk(false); }} rows={2}
        placeholder="What should they do with it?"
        className="mt-2 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" />

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs opacity-70">
          By (optional)
          <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)}
            className="rounded-md border border-ink/15 px-2 py-1 text-xs" />
        </label>
        <button disabled={busy || !prompt.trim()} className="btn-primary px-3 py-1.5 text-sm">
          {busy ? "Assigning…" : "Assign"}
        </button>
        {ok && <span className="text-xs text-success">Assigned.</span>}
      </div>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </form>
  );
}

function AssignmentRow({ assignment: a, videos, onChanged, onError }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const reply = (a.video_assignment_responses ?? [])[0] ?? null;
  const shelf = videos.find((v) => v.id === a.video_id) ?? null;

  async function seen() {
    setBusy(true);
    try { await markResponseSeen(reply.id); await onChanged(); }
    catch (e) { onError(e.message); } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try { await unassignVideo(a.id); await onChanged(); }
    catch (e) { onError(e.message); setBusy(false); }
  }

  return (
    <li className="rounded-lg border border-ink/10 p-3">
      <div className="flex items-start gap-3">
        <img src={thumbFor(shelf ?? { youtube_id: a.video_youtube_id })} alt=""
          className="h-12 w-20 shrink-0 rounded object-cover" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {shelf ? `${shelf.slot}. ${shelf.title}` : a.video_title}
          </p>
          {/* The snapshot doing its job: the ask survives the video leaving
              the shelf, and says so rather than showing a dead reference. */}
          {!shelf && <p className="text-xs opacity-50">No longer in your library</p>}
          <p className="mt-0.5 text-xs italic opacity-60">{a.prompt}</p>
          <p className="mt-0.5 text-xs opacity-40">
            Assigned {new Date(a.assigned_at).toLocaleDateString()}
            {a.due_on ? ` · due ${a.due_on}` : ""}
          </p>
          {/* The row already shows a thumbnail; the player mounts only on request. */}
          {(shelf?.youtube_id || a.video_youtube_id) && (
            <DemoDisclosure
              url={`https://www.youtube.com/watch?v=${shelf?.youtube_id || a.video_youtube_id}`}
              label={shelf ? shelf.title : a.video_title}
            />
          )}
        </div>
        {!reply && !confirm && (
          <button onClick={() => setConfirm(true)}
            className="shrink-0 text-xs text-danger opacity-70 underline hover:opacity-100">unassign</button>
        )}
        {!reply && confirm && (
          <span className="flex shrink-0 gap-1.5 text-xs">
            <button onClick={remove} disabled={busy} className="text-danger underline">confirm</button>
            <button onClick={() => setConfirm(false)} className="opacity-60 underline">no</button>
          </span>
        )}
      </div>

      {reply ? (
        <div className={`mt-2 rounded-md p-2.5 text-sm ${reply.coach_seen ? "bg-ink/[0.03]" : "bg-brand/10"}`}>
          <div className="flex items-center justify-between gap-3 text-xs opacity-60">
            <span>
              Answered {new Date(reply.submitted_at).toLocaleDateString()}
              {!reply.coach_seen && <span className="ml-2 font-bold text-brand-fg">new</span>}
            </span>
            {!reply.coach_seen && (
              <button onClick={seen} disabled={busy} className="underline">{busy ? "…" : "mark read"}</button>
            )}
          </div>
          <p className="mt-1 whitespace-pre-line">{reply.body}</p>
        </div>
      ) : (
        // Not answered is a real state about the client, not a blank. Say it.
        <p className="mt-2 text-xs opacity-50">No answer yet.</p>
      )}
    </li>
  );
}

function Muted({ children }) { return <p className="text-sm opacity-60">{children}</p>; }
