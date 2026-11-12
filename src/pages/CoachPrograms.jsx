import { useEffect, useState, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { listPrograms, duplicateProgram, assignProgram } from "../lib/programs";
import { listClients } from "../lib/coachClients";
import { CoachTabs } from "../components/CoachTabs";
import ProgramBuilder from "../components/ProgramBuilder";
import AppGate from "../components/AppGate";

// Coach program library. One table backs two groups: hand-built splits
// (source_draft_id null) and AI-generated per-client plans (source_draft_id set).
export default function CoachPrograms() {
  const { user, role, profile } = useAuth();
  const navigate = useNavigate();
  // undefined = loading, null = failed, [] = genuine empty
  const [programs, setPrograms] = useState(undefined);
  const [clients, setClients] = useState([]);
  const [openId, setOpenId] = useState(null);   // program with the assign panel open
  const [editing, setEditing] = useState(null); // program being edited, or "new"
  const [builderDirty, setBuilderDirty] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const [ps, cs] = await Promise.all([listPrograms(), listClients()]);
      setPrograms(ps);
      setClients(cs);
      setErr(null);
    } catch (e) {
      setPrograms(null);
      setErr(e.message);
    }
  }, []);
  useEffect(() => { if (role === "coach") load(); }, [role, load]);

  if (!user) {
    return (
      <AppGate title="Sign in to manage programs" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
        Your program library and assignments live here.
      </AppGate>
    );
  }
  if (role !== "coach") {
    return (
      <AppGate title="Coach area only" actionTo="/client" actionLabel="Client home" secondaryTo="/" secondaryLabel="Home">
        Programs are managed by coaches.
      </AppGate>
    );
  }

  const tenantId = profile?.tenant_id;
  const list = programs ?? [];
  const handBuilt = list.filter((p) => !p.source_draft_id);
  const generated = list.filter((p) => p.source_draft_id);

  // Intercept in-app link clicks while the builder has unsaved edits (BrowserRouter
  // has no useBlocker without a data router). Tab close uses beforeunload in ProgramBuilder.
  function onNavCapture(e) {
    if (!builderDirty) return;
    const a = e.target.closest?.("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || a.target === "_blank") return;
    // Same-document hash only — skip
    if (href.startsWith("http") && !href.includes(window.location.host)) return;
    e.preventDefault();
    e.stopPropagation();
    const leave = window.confirm("You have unsaved program changes. Leave without saving?");
    if (leave) {
      setBuilderDirty(false);
      setEditing(null);
      navigate(href);
    }
  }

  if (editing) {
    return (
      <main className="mx-auto max-w-3xl px-5 py-10" onClickCapture={onNavCapture}>
        <CoachTabs active="programs" />
        <ProgramBuilder
          program={editing === "new" ? null : editing}
          tenantId={tenantId}
          onDirtyChange={setBuilderDirty}
          onDone={async () => { setBuilderDirty(false); setEditing(null); await load(); }}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <CoachTabs active="programs" />
      <div className="mt-6 flex items-end justify-between">
        <h1 className="display text-3xl">Programs</h1>
        <button onClick={() => setEditing("new")} className="btn-primary px-3 py-1.5">New program</button>
      </div>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}

      {programs === undefined && (
        <p className="mt-6 text-sm opacity-60">Loading programs…</p>
      )}
      {programs === null && (
        <p className="mt-6 rounded-xl border border-dashed border-danger/40 bg-danger/5 px-3 py-3 text-sm text-danger">
          Could not load programs — failed read, not an empty library. Refresh or try again.
        </p>
      )}

      {Array.isArray(programs) && (
        <>
          <Group title="Your programs" empty="No programs yet — build one, or duplicate a generated plan.">
            {handBuilt.map((p) => (
              <ProgramRow key={p.id} p={p} clients={clients} tenantId={tenantId}
                open={openId === p.id} onToggle={() => setOpenId(openId === p.id ? null : p.id)}
                onEdit={() => setEditing(p)} onChanged={load} setErr={setErr} />
            ))}
          </Group>

          <Group title="Generated client plans" empty="No AI-generated plans yet.">
            {generated.map((p) => (
              <ProgramRow key={p.id} p={p} clients={clients} tenantId={tenantId}
                open={openId === p.id} onToggle={() => setOpenId(openId === p.id ? null : p.id)}
                onEdit={() => setEditing(p)} onChanged={load} setErr={setErr} />
            ))}
          </Group>
        </>
      )}
    </main>
  );
}

function Group({ title, empty, children }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <section className="mt-6">
      <h2 className="section-title">{title}</h2>
      <ul className="glass mt-2 divide-y divide-ink/10 overflow-hidden">
        {items.length === 0 && <li className="p-4 text-sm opacity-60">{empty}</li>}
        {children}
      </ul>
    </section>
  );
}

function ProgramRow({ p, clients, tenantId, open, onToggle, onEdit, onChanged, setErr }) {
  const [busy, setBusy] = useState(false);
  const nDays = Array.isArray(p.structure?.days) ? p.structure.days.length : 0;
  const nActive = p.active_client_ids.length;

  async function duplicate() {
    setBusy(true); setErr(null);
    try { await duplicateProgram(p, tenantId); await onChanged(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <li>
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm">
          <span className="font-bold">{p.name}</span>
          <span className="ml-2 text-xs opacity-50">{nDays} days</span>
          {p.is_default && <span className="ml-2 text-xs uppercase opacity-40">default</span>}
          {nActive > 0 && (
            <span className="ml-2 text-xs opacity-60">
              assigned to {nActive} client{nActive > 1 ? "s" : ""}
            </span>
          )}
        </span>
        <span className="flex gap-2 text-xs">
          <button onClick={onEdit} className="rounded-md border border-ink/15 px-2 py-1 hover:bg-ink/[0.03]">Edit</button>
          <button onClick={duplicate} disabled={busy} className="rounded-md border border-ink/15 px-2 py-1 hover:bg-ink/[0.03]">Duplicate</button>
          <button onClick={onToggle} className={`rounded-md px-2 py-1 ${open ? "bg-ink text-paper" : "border border-ink/15 hover:bg-ink/[0.03]"}`}>Assign</button>
        </span>
      </div>
      {open && <AssignPanel p={p} clients={clients} tenantId={tenantId} onChanged={onChanged} setErr={setErr} />}
    </li>
  );
}

// Assign this program to selected clients. Replaces each client's current active
// assignment (their in-progress cycle closes), so mid-cycle clients are called out.
function AssignPanel({ p, clients, tenantId, onChanged, setErr }) {
  const [picked, setPicked] = useState({});
  const [busy, setBusy] = useState(false);
  const ids = Object.keys(picked).filter((id) => picked[id]);

  return (
    <div className="border-t border-ink/5 px-4 py-3">
      <div className="flex flex-wrap gap-3">
        {clients.map((c) => (
          <label key={c.id} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={!!picked[c.id]}
              onChange={(e) => setPicked((s) => ({ ...s, [c.id]: e.target.checked }))} />
            {c.display_name ?? c.email}
            {p.active_client_ids.includes(c.id) && (
              <span className="text-xs opacity-50">(currently assigned)</span>
            )}
            {c.status && c.status !== "active" && (
              <span className="text-xs opacity-45">· {c.status}</span>
            )}
          </label>
        ))}
        {clients.length === 0 && <span className="text-sm opacity-60">No clients yet.</span>}
      </div>
      <p className="mt-2 text-xs opacity-60">Assigning replaces each selected client’s current program from day 1. Their past workout history is kept.</p>
      <button
        disabled={busy || ids.length === 0}
        onClick={async () => {
          setBusy(true); setErr(null);
          try { await assignProgram({ programId: p.id, clientIds: ids, tenantId }); setPicked({}); await onChanged(); }
          catch (e) { setErr(e.message); } finally { setBusy(false); }
        }}
        className="mt-2 rounded-md bg-brand px-3 py-1.5 text-sm text-brand-text disabled:opacity-40">
        {busy ? "Assigning…" : `Assign to ${ids.length || "…"} client${ids.length === 1 ? "" : "s"}`}
      </button>
    </div>
  );
}
