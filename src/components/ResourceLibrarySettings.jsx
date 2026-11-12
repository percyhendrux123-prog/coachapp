import { useCallback, useEffect, useState } from "react";
import {
  listResourcesForCoach, addResource, updateResource,
  removeResource, reorderResources, resolveResourceUrl,
} from "../lib/resourceLibrary";

const TYPE_LABEL = { pdf: "PDF", video: "Video", link: "Link" };

// The coach's resources library, as a section of Settings — mirrors
// VideoLibrarySettings.jsx: an add form, a reorderable list, edit/remove per row.
// Unlike the video shelf this has no slot cap; it is a flat, coach-ordered list.
// No created_by here (unlike coach_videos) — the resources table has no such
// column, so this component only needs tenantId, not a user id.
export default function ResourceLibrarySettings({ tenantId }) {
  const [rows, setRows] = useState(undefined);
  const [err, setErr] = useState(null);

  const load = useCallback(
    () => listResourcesForCoach().then(setRows).catch((e) => { setErr(e.message); setRows([]); }),
    [],
  );
  useEffect(() => { load(); }, [load]);

  async function move(index, delta) {
    const next = [...rows];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setRows(next);
    try {
      await reorderResources(next.map((r) => r.id));
      await load();
    } catch (e) { setErr(e.message); await load(); }
  }

  return (
    <section className="glass p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="section-title">Resources</h2>
        <span className="text-xs opacity-60">
          {rows === undefined ? "—" : `${rows.length} item${rows.length === 1 ? "" : "s"}`}
        </span>
      </div>
      <p className="mt-1 text-xs opacity-60">
        Upload a PDF or paste a link (video or otherwise) and it lands at the end of
        the list — reorder it below.
        <b className="font-semibold text-ink opacity-80"> Clients see this under Resources</b>
        {" "}on their app, same order as here.
      </p>

      {rows === undefined ? (
        <p className="mt-4 text-sm opacity-60">Loading…</p>
      ) : (
        <>
          <AddResource tenantId={tenantId} onAdded={load} />

          {err && <p className="mt-3 text-sm text-danger">{err}</p>}

          {rows.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-ink/20 p-4 text-center text-sm opacity-60">
              No resources yet. Add one above.
            </p>
          ) : (
            <ol className="mt-4 space-y-2">
              {rows.map((r, i) => (
                <ResourceRow key={r.id} resource={r} index={i} count={rows.length}
                  onMove={move} onChanged={load} onError={setErr} />
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function AddResource({ tenantId, onAdded }) {
  const [type, setType] = useState("pdf");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);

  async function save(e) {
    e.preventDefault();
    if (busy) return;
    setProblem(null); setBusy(true);
    try {
      await addResource({
        tenantId, title, description, type,
        file: type === "pdf" ? file : undefined,
        url: type === "pdf" ? undefined : url,
      });
      setTitle(""); setDescription(""); setUrl(""); setFile(null);
      onAdded();
    } catch (e) { setProblem(e.message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={save} className="mt-4 space-y-2 rounded-lg border border-ink/10 p-3">
      <div className="flex gap-2">
        {["pdf", "video", "link"].map((t) => (
          <button key={t} type="button" onClick={() => setType(t)}
            className={`rounded-md px-2 py-1 text-xs font-medium ${
              type === t ? "bg-ink text-paper" : "border border-ink/15 hover:bg-ink/[0.03]"}`}>
            {TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)}
        placeholder="Title" className="w-full rounded-md border border-ink/15 px-3 py-2 text-sm" />
      <input value={description} onChange={(e) => setDescription(e.target.value)}
        placeholder="Short description (optional)"
        className="w-full rounded-md border border-ink/15 px-3 py-2 text-sm" />
      {type === "pdf" ? (
        <input type="file" accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full text-sm" />
      ) : (
        <input value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder={type === "video" ? "Video link (YouTube, Loom, etc.)" : "Link URL"}
          className="w-full rounded-md border border-ink/15 px-3 py-2 text-sm" />
      )}
      {problem && <p className="text-xs text-danger">{problem}</p>}
      <button type="submit" disabled={busy} className="btn-primary px-3 py-1.5 text-xs">
        {busy ? "Saving…" : "Add resource"}
      </button>
    </form>
  );
}

function ResourceRow({ resource, index, count, onMove, onChanged, onError }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(resource.title);
  const [description, setDescription] = useState(resource.description ?? "");
  const [busy, setBusy] = useState(false);
  const [openUrl, setOpenUrl] = useState(null);

  async function openLink() {
    try { setOpenUrl(await resolveResourceUrl(resource)); }
    catch (e) { onError(e.message); }
  }

  async function save() {
    setBusy(true);
    try { await updateResource(resource.id, { title, description }); setEditing(false); onChanged(); }
    catch (e) { onError(e.message); } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    try { await removeResource(resource.id); onChanged(); }
    catch (e) { onError(e.message); setBusy(false); }
  }

  if (editing) {
    return (
      <li className="glass space-y-2 p-3">
        <input value={title} onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-md border border-ink/15 px-3 py-2 text-sm" />
        <input value={description} onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-md border border-ink/15 px-3 py-2 text-sm" />
        <div className="flex gap-2">
          <button type="button" onClick={save} disabled={busy} className="btn-primary px-3 py-1.5 text-xs">Save</button>
          <button type="button" onClick={() => setEditing(false)} className="btn-ghost px-3 py-1.5 text-xs">Cancel</button>
        </div>
      </li>
    );
  }

  return (
    <li className="glass flex items-center justify-between gap-3 p-3 text-sm">
      <div className="min-w-0">
        <p className="truncate font-medium">{resource.title}</p>
        <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide opacity-45">
          {TYPE_LABEL[resource.type] ?? resource.type}
        </p>
        {resource.description && <p className="mt-1 text-xs opacity-60">{resource.description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={() => onMove(index, -1)} disabled={index === 0}
          className="btn-ghost px-2 py-1 text-xs disabled:opacity-30">↑</button>
        <button type="button" onClick={() => onMove(index, 1)} disabled={index === count - 1}
          className="btn-ghost px-2 py-1 text-xs disabled:opacity-30">↓</button>
        {openUrl ? (
          <a href={openUrl} target="_blank" rel="noreferrer" className="btn-ghost px-2 py-1 text-xs">Open</a>
        ) : (
          <button type="button" onClick={openLink} className="btn-ghost px-2 py-1 text-xs">Open</button>
        )}
        <button type="button" onClick={() => setEditing(true)} className="btn-ghost px-2 py-1 text-xs">Edit</button>
        <button type="button" onClick={remove} disabled={busy} className="btn-ghost px-2 py-1 text-xs text-danger">Remove</button>
      </div>
    </li>
  );
}
