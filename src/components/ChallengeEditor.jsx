import { useEffect, useState, useCallback } from "react";
import {
  getStandards, upsertStandard, deleteStandard,
  getContent, upsertContent, listRuns, setChallengeStatus, setChallengeAudience, setChallengeMaxEntrants, AUDIENCE_LABEL,
} from "../lib/challenges";

// Edit one challenge: its standards (≤7), per-day content (up to duration), publish
// state, and a read-only view of participant runs. tenantId comes from the coach profile.
export default function ChallengeEditor({ challenge, tenantId, onStatusChange }) {
  const [tab, setTab] = useState("standards");
  return (
    <section className="mt-6 rounded-xl border border-ink/10 p-5">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{challenge.title}</h2>
          <p className="text-xs opacity-60">/{challenge.slug} · {challenge.duration_days} days · {challenge.num_standards} standards</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PublishToggle challenge={challenge} onStatusChange={onStatusChange} />
          <ArchiveButton challenge={challenge} onStatusChange={onStatusChange} />
        </div>
      </header>
      <AudienceSelect challenge={challenge} />
      <MaxEntrants challenge={challenge} />

      <nav className="mt-4 flex gap-4 border-b border-ink/10 text-sm">
        {["standards", "content", "runs"].map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`-mb-px border-b-2 pb-2 capitalize ${tab === t ? "border-ink font-medium" : "border-transparent opacity-60"}`}>
            {t}
          </button>
        ))}
      </nav>

      <div className="mt-4">
        {tab === "standards" && <StandardsEditor challenge={challenge} tenantId={tenantId} />}
        {tab === "content" && <ContentEditor challenge={challenge} tenantId={tenantId} />}
        {tab === "runs" && <RunsView challenge={challenge} />}
      </div>
    </section>
  );
}

function PublishToggle({ challenge, onStatusChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const published = challenge.status === "published";
  async function toggle() {
    setBusy(true); setErr(null);
    try {
      const next = published ? "draft" : "published";
      await setChallengeStatus(challenge.id, next);
      onStatusChange?.(challenge.id, next);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div>
      <button onClick={toggle} disabled={busy}
        className={`shrink-0 rounded-lg px-3 py-1.5 text-sm ${published ? "bg-success text-white" : "border border-ink/20"}`}>
        {published ? "Published — unpublish" : "Publish"}
      </button>
      {err && <p className="mt-1 text-xs text-danger">{err}</p>}
    </div>
  );
}

// Gets a challenge out of the active list without deleting it — reversible (the Publish
// button above still works from "archived": it goes straight back to published). A real
// delete isn't offered here on purpose; once a challenge has any participant runs, deleting
// the row would orphan their history. Archive covers the actual need safely.
function ArchiveButton({ challenge, onStatusChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (challenge.status === "archived") return null;
  async function archive() {
    setBusy(true); setErr(null);
    try {
      await setChallengeStatus(challenge.id, "archived");
      onStatusChange?.(challenge.id, "archived");
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div>
      <button onClick={archive} disabled={busy}
        className="shrink-0 rounded-lg border border-ink/20 px-3 py-1.5 text-sm opacity-70">
        Archive
      </button>
      {err && <p className="mt-1 text-xs text-danger">{err}</p>}
    </div>
  );
}

// Who's allowed to enroll. Enforced server-side in challenge-enroll — this control just
// sets it. Changing it never affects anyone already in a run, only new enrollments.
function AudienceSelect({ challenge }) {
  const [value, setValue] = useState(challenge.audience ?? "open");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function change(next) {
    const prev = value;
    setValue(next); setBusy(true); setErr(null);
    try {
      await setChallengeAudience(challenge.id, next);
    } catch (e) { setValue(prev); setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="mt-3 flex items-center gap-2 text-sm">
      <span className="opacity-60">Who can join</span>
      <select value={value} disabled={busy} onChange={(e) => change(e.target.value)}
        className="rounded-md border border-ink/15 px-2 py-1 text-sm">
        {Object.entries(AUDIENCE_LABEL).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      {err && <span className="text-xs text-danger">{err}</span>}
    </div>
  );
}

// Hard cap on entrants, enforced by the database on every enrollment path (a row lock on
// the challenge serialises concurrent sign-ups). Blank = no cap.
function MaxEntrants({ challenge }) {
  const [value, setValue] = useState(challenge.max_entrants ?? "");
  const [saved, setSaved] = useState(null);
  const [err, setErr] = useState(null);
  async function save() {
    setErr(null); setSaved(null);
    try { const v = await setChallengeMaxEntrants(challenge.id, value); setSaved(v === null ? "No cap" : `Capped at ${v}`); }
    catch (e) { setErr(e.message); }
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <span className="opacity-60">Places</span>
      <input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
        placeholder="no cap" className="w-20 rounded-md border border-ink/15 px-2 py-1 text-sm" />
      <button onClick={save} className="rounded-md border border-ink/20 px-2 py-1 text-xs">Save</button>
      {saved && <span className="text-xs opacity-60">{saved}</span>}
      {err && <span className="text-xs text-danger">{err}</span>}
    </div>
  );
}

function StandardsEditor({ challenge, tenantId }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const load = useCallback(() => getStandards(challenge.id).then(setRows), [challenge.id]);
  useEffect(() => { load(); }, [load]);

  const slots = Array.from({ length: challenge.num_standards }, (_, i) => i + 1);
  async function save(ordinal, title, description) {
    if (!title.trim()) return;
    setErr(null);
    try { await upsertStandard({ tenantId, challengeId: challenge.id, ordinal, title, description }); await load(); }
    catch (e) { setErr(e.message); }
  }
  async function remove(id) { setErr(null); try { await deleteStandard(id); await load(); } catch (e) { setErr(e.message); } }

  return (
    <div>
      {err && <p className="mb-3 text-xs text-danger">{err}</p>}
      <ol className="space-y-3">
      {slots.map((ordinal) => {
        const row = rows.find((r) => r.ordinal === ordinal);
        return <StandardRow key={ordinal} ordinal={ordinal} row={row} onSave={save} onRemove={remove} />;
      })}
    </ol>
    </div>
  );
}

function StandardRow({ ordinal, row, onSave, onRemove }) {
  const [title, setTitle] = useState(row?.title ?? "");
  const [desc, setDesc] = useState(row?.description ?? "");
  useEffect(() => { setTitle(row?.title ?? ""); setDesc(row?.description ?? ""); }, [row?.id, row?.title, row?.description]);
  return (
    <li className="flex items-start gap-3">
      <span className="mt-2 w-5 text-sm opacity-50">{ordinal}</span>
      <div className="flex-1 space-y-1">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`Standard ${ordinal} title`}
          className="w-full rounded-md border border-ink/15 px-2 py-1 text-sm" />
        <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Short description"
          className="w-full rounded-md border border-ink/10 px-2 py-1 text-xs" />
      </div>
      <button onClick={() => onSave(ordinal, title, desc)} className="mt-1 rounded-md bg-brand px-2 py-1 text-xs text-brand-text">Save</button>
      {row && <button onClick={() => onRemove(row.id)} className="mt-1 rounded-md border border-ink/15 px-2 py-1 text-xs">✕</button>}
    </li>
  );
}

function ContentEditor({ challenge, tenantId }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const load = useCallback(() => getContent(challenge.id).then(setRows), [challenge.id]);
  useEffect(() => { load(); }, [load]);
  const days = Array.from({ length: challenge.duration_days }, (_, i) => i + 1);

  async function save(dayIndex, title, body) {
    setErr(null);
    try { await upsertContent({ tenantId, challengeId: challenge.id, dayIndex, title, body }); await load(); }
    catch (e) { setErr(e.message); }
  }
  return (
    <div className="space-y-4">
      {err && <p className="text-xs text-danger">{err}</p>}
      {days.map((day) => {
        const row = rows.find((r) => r.day_index === day);
        return <DayRow key={day} day={day} row={row} onSave={save} />;
      })}
    </div>
  );
}

function DayRow({ day, row, onSave }) {
  const [title, setTitle] = useState(row?.title ?? "");
  const [body, setBody] = useState(row?.body ?? "");
  useEffect(() => { setTitle(row?.title ?? ""); setBody(row?.body ?? ""); }, [row?.id, row?.title, row?.body]);
  return (
    <div className="rounded-lg border border-ink/10 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide opacity-50">Day {day}</span>
        <button onClick={() => onSave(day, title, body)} className="rounded-md bg-brand px-2 py-1 text-xs text-brand-text">Save</button>
      </div>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Day title"
        className="mt-2 w-full rounded-md border border-ink/15 px-2 py-1 text-sm" />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="What this day is about…" rows={2}
        className="mt-1 w-full rounded-md border border-ink/10 px-2 py-1 text-xs" />
    </div>
  );
}

function RunsView({ challenge }) {
  const [rows, setRows] = useState(null); // null = loading
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    setRows(null);
    listRuns(challenge.id)
      .then((r) => { setFailed(false); setRows(r); })
      .catch(() => { setFailed(true); setRows([]); });
  }, [challenge.id]);
  if (rows === null) return <p className="text-sm opacity-60">Loading…</p>;
  if (failed) {
    return (
      <p className="rounded-xl border border-dashed border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
        Could not load runs — failed read, not “no participants.”
      </p>
    );
  }
  if (rows.length === 0) return <p className="text-sm opacity-60">No participants yet.</p>;
  const perfect = rows.filter((r) => r.perfect_week).length;
  return (
    <div>
      <p className="mb-3 text-sm opacity-70">{rows.length} run(s) · {perfect} perfect week(s)</p>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase opacity-50">
          <tr><th className="py-1">Participant</th><th>Status</th><th>Day</th><th>Perfect</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-ink/5">
              <td className="py-1 text-xs">{r.participant_email ?? <span className="font-mono">{r.participant_user_id.slice(0, 8)}… <span className="opacity-50">(no email on record)</span></span>}</td>
              <td>{r.status}</td>
              <td>{r.current_day_index}</td>
              <td>{r.perfect_week ? "✓" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
