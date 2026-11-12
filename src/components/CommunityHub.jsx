import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listPosts, createPost, listComments, addComment, getMyReaction, toggleReaction } from "../lib/community";
import TenantMark from "./TenantMark";

// Shared Community body. Coach page wraps this. Client tab renders it in-shell.
// No video dump here — Brief and Videos already own the reel and the shelf.
export default function CommunityHub({ ctx, brand }) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  const load = useCallback(
    () => listPosts()
      .then((rows) => { setPosts(rows); setErr(null); })
      .catch((e) => { setErr(e.message); setPosts([]); })
      .finally(() => setLoading(false)),
    [],
  );
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <span className="kicker">Room</span>
        <h2 className="display mt-1 text-2xl">Community</h2>
        <p className="mt-1 text-xs opacity-60">
          Coach posts. You read, react, comment. Reels live on Brief and Videos.
        </p>
      </div>

      <section className="glass p-4">
        <div className="flex items-center gap-3">
          <TenantMark brand={brand} className="h-12 w-12 border border-ink/10" />
          <div className="min-w-0">
            <p className="display truncate text-lg">{brand?.app_name || "Your coaching"}</p>
            {brand?.coach_display_name && (
              <p className="mt-0.5 text-xs opacity-60">with {brand.coach_display_name}</p>
            )}
          </div>
        </div>
        {brand?.welcome_message && (
          <p className="mt-3 text-sm leading-relaxed opacity-70 whitespace-pre-wrap">{brand.welcome_message}</p>
        )}
        {ctx.role === "coach" && !brand?.logo_url && (
          <p className="mt-3 text-xs opacity-60">
            No logo yet — <Link className="underline" to="/coach/settings">Settings → Branding</Link>.
          </p>
        )}
      </section>

      {ctx.role === "coach" && <Composer tenantId={ctx.tenantId} onPosted={load} />}

      <section>
        <span className="kicker">Feed</span>
        <h3 className="display mt-1 text-xl">Posts</h3>
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
        {loading && <p className="mt-3 text-sm opacity-60">Loading…</p>}
        {!loading && err && posts.length === 0 && (
          <p className="mt-3 rounded-xl border border-dashed border-danger/40 bg-danger/5 px-3 py-3 text-sm text-danger">
            Could not load the feed — failed read, not “no posts.”
          </p>
        )}
        {!loading && !err && posts.length === 0 && (
          <p className="mt-3 text-sm opacity-60">No posts yet. When your coach writes, it lands here.</p>
        )}
        <div className="mt-4 space-y-3">
          {posts.map((p) => <Post key={p.id} post={p} ctx={ctx} />)}
        </div>
      </section>
    </div>
  );
}

function Composer({ tenantId, onPosted }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function post(e) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setErr(null);
    try { await createPost({ tenantId, body: body.trim() }); setBody(""); await onPosted(); }
    catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={post} className="glass p-4">
      <span className="kicker">Write</span>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Share something with the room…"
        aria-label="Share something with the room"
        className="mt-2 w-full rounded-xl border border-ink/15 px-3 py-2 text-sm"
      />
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
      <button disabled={busy} className="btn-primary mt-2 min-h-[44px] px-3 py-1.5">{busy ? "Posting…" : "Post"}</button>
    </form>
  );
}

function Post({ post, ctx }) {
  const [open, setOpen] = useState(false);
  const [reacted, setReacted] = useState(false);
  const [count, setCount] = useState(post.reaction_count);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (ctx.clientId) getMyReaction(post.id, ctx.clientId).then(setReacted).catch(() => {});
  }, [post.id, ctx.clientId]);

  async function toggle() {
    if (ctx.role !== "client" || !ctx.clientId) return;
    const wasOn = reacted;
    setReacted(!wasOn); setCount((c) => c + (wasOn ? -1 : 1));
    setErr(null);
    try { await toggleReaction({ postId: post.id, tenantId: ctx.tenantId, clientId: ctx.clientId, on: wasOn }); }
    catch (e) { setReacted(wasOn); setCount((c) => c + (wasOn ? 1 : -1)); setErr(e.message); }
  }

  return (
    <article className="rounded-xl border border-ink/10 bg-paper/40 p-3">
      {post.pinned && <span className="kicker">Pinned</span>}
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{post.body}</p>
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
      <div className="mt-3 flex items-center gap-2 text-sm">
        <button
          type="button"
          onClick={toggle}
          disabled={ctx.role !== "client"}
          aria-pressed={reacted}
          className={`flex min-h-[44px] items-center rounded-lg px-2 ${reacted ? "font-semibold text-brand-fg" : "opacity-60"} ${ctx.role === "client" ? "" : "cursor-default"}`}
        >
          {reacted ? "Liked" : "Like"} · {count}
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-h-[44px] items-center rounded-lg px-2 opacity-60"
        >
          Comments · {post.comment_count}
        </button>
      </div>
      {open && <Comments post={post} ctx={ctx} />}
    </article>
  );
}

function Comments({ post, ctx }) {
  const [rows, setRows] = useState([]);
  const [body, setBody] = useState("");
  const [err, setErr] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(
    () => listComments(post.id)
      .then((r) => { setRows(r); setLoadFailed(false); })
      .catch(() => { setRows([]); setLoadFailed(true); }),
    [post.id],
  );
  useEffect(() => { load(); }, [load]);
  async function add(e) {
    e.preventDefault();
    if (!body.trim()) return;
    setErr(null);
    try {
      await addComment({ postId: post.id, tenantId: ctx.tenantId, clientId: ctx.clientId, role: ctx.role, body: body.trim() });
      setBody(""); await load();
    } catch (e2) { setErr(e2.message); }
  }
  return (
    <div className="mt-3 border-t border-ink/10 pt-3">
      {loadFailed ? (
        <p className="text-xs text-danger">Comments could not load. Not empty — the feed failed.</p>
      ) : (
        <ul className="space-y-2">
          {rows.length === 0 && <li className="text-xs opacity-60">No comments yet.</li>}
          {rows.map((c) => (
            <li key={c.id} className="text-sm">
              <span className="mr-2 text-[11px] font-semibold uppercase tracking-wide opacity-60">{c.author_role}</span>
              {c.body}
            </li>
          ))}
        </ul>
      )}
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
      <form onSubmit={add} className="mt-2 flex gap-2">
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment…"
          aria-label="Add a comment"
          className="min-h-[44px] flex-1 rounded-xl border border-ink/15 px-3 py-1.5 text-sm"
        />
        <button type="submit" className="btn-primary min-h-[44px] px-3 text-sm">Send</button>
      </form>
    </div>
  );
}
