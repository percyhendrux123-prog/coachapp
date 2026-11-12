import { useEffect, useState, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { listChallenges, createChallenge, AUDIENCE_LABEL } from "../lib/challenges";
import ChallengeEditor from "../components/ChallengeEditor";
import { CoachTabs } from "../components/CoachTabs";
import AppGate from "../components/AppGate";

// Phase 2 coach challenge board: create/publish challenges, author standards + daily
// content, and watch runs. Role-gated; tenant scoping is enforced server-side by RLS.
export default function Coach() {
  const { user, role, profile } = useAuth();
  // undefined = loading, null = failed, [] = genuine empty
  const [challenges, setChallenges] = useState(undefined);
  const [selectedId, setSelectedId] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      setChallenges(await listChallenges());
      setErr(null);
    } catch (e) {
      setChallenges(null);
      setErr(e.message);
    }
  }, []);
  useEffect(() => { if (role === "coach") load(); }, [role, load]);

  if (!user) {
    return (
      <AppGate title="Sign in to manage challenges" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
        Challenge board and run tracking live here for coaches.
      </AppGate>
    );
  }
  if (role !== "coach") {
    return (
      <AppGate title="Coach area only" actionTo="/client" actionLabel="Client home" secondaryTo="/" secondaryLabel="Home">
        Challenges are managed by coaches.
      </AppGate>
    );
  }

  const list = challenges ?? [];
  const selected = list.find((c) => c.id === selectedId) ?? null;

  function onStatusChange(id, status) {
    setChallenges((cs) => (Array.isArray(cs) ? cs.map((c) => (c.id === id ? { ...c, status } : c)) : cs));
  }

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <CoachTabs active="challenges" />
      <h1 className="display mt-6 text-3xl">Challenges</h1>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}

      <NewChallenge tenantId={profile?.tenant_id} onCreated={async (c) => { await load(); setSelectedId(c.id); }} />

      <ul className="glass mt-6 divide-y divide-ink/10 overflow-hidden">
        {challenges === undefined && <li className="p-4 text-sm opacity-60">Loading challenges…</li>}
        {challenges === null && (
          <li className="p-4 text-sm text-danger">
            Could not load challenges — failed read, not “no challenges yet.”
          </li>
        )}
        {Array.isArray(challenges) && challenges.length === 0 && (
          <li className="p-4 text-sm opacity-60">No challenges yet — create one above.</li>
        )}
        {list.map((c) => (
          <li key={c.id}>
            <button onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
              className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-ink/[0.03]">
              <span>
                <span className="font-bold">{c.title}</span>
                <span className="ml-2 text-xs opacity-50">/{c.slug}</span>
              </span>
              <StatusBadge status={c.status} />
            </button>
          </li>
        ))}
      </ul>

      {selected && <ChallengeEditor challenge={selected} tenantId={profile?.tenant_id} onStatusChange={onStatusChange} />}
    </main>
  );
}

function NewChallenge({ tenantId, onCreated }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [audience, setAudience] = useState("open");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const c = await createChallenge({ tenantId, slug: slug.trim(), title: title.trim(), subtitle: subtitle.trim() || null, audience });
      setTitle(""); setSlug(""); setSubtitle(""); setAudience("open"); setOpen(false);
      onCreated?.(c);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  if (!open) return <button onClick={() => setOpen(true)} className="btn-primary mt-6 px-3 py-2">+ New challenge</button>;
  return (
    <form onSubmit={submit} className="glass mt-6 space-y-2 p-4">
      <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Challenge title"
        className="w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" />
      <input required value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
        placeholder="slug (e.g. reset-7)" className="w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" />
      <input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="Subtitle (optional)"
        className="w-full rounded-md border border-ink/10 px-2 py-1.5 text-sm" />
      <label className="block text-xs">
        <span className="opacity-60">Who can join</span>
        <select value={audience} onChange={(e) => setAudience(e.target.value)}
          className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm">
          {Object.entries(AUDIENCE_LABEL).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </label>
      {err && <p className="text-sm text-danger">{err}</p>}
      <div className="flex gap-2">
        <button disabled={busy} className="btn-primary px-3 py-1.5">{busy ? "Creating…" : "Create (draft)"}</button>
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost px-3 py-1.5">Cancel</button>
      </div>
    </form>
  );
}

function StatusBadge({ status }) {
  const map = { published: "bg-success/15 text-success", draft: "bg-brand/10 text-ink", archived: "bg-ink/10 opacity-60" };
  return <span className={`rounded-full px-2 py-0.5 text-xs ${map[status] ?? "bg-ink/10"}`}>{status}</span>;
}


