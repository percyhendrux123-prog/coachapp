import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { CoachTabs } from "../components/CoachTabs";
import AppGate from "../components/AppGate";
import { fetchCoachCockpit, confirmCheckinTag, rejectCheckinTag } from "../lib/coachCockpit";
import { availableDraftStyles, resolveDraftStyle } from "../lib/whiteLabelPolicy";
import { firstUnseenCheckinHref, openCheckinHref, unseenCheckinClients } from "../lib/coachCockpitNav";
import { markCheckinSeen, sendCoachMessage } from "../lib/coachClients";
import { listActivity, recordActivity } from "../lib/activity";
import { OWNER_TENANT_SLUG } from "../lib/tenantIdentity";

const BAND_STYLES = {
  act: "border-danger/35 bg-danger/5 text-danger",
  review: "border-brand/35 bg-brand/5 text-brand-fg",
  steady: "border-ink/15 bg-ink/[0.03]",
};

export default function CoachCockpit() {
  const auth = useAuth();
  const [params] = useSearchParams();
  // Repeat the flag expression so production DCE can drop the fixture import,
  // matching previewFlag.js. An imported boolean is not always folded.
  const previewEnabled = import.meta.env.DEV || globalThis.__COACHAPP_PREVIEW_ROUTES__;
  const previewName = previewEnabled ? params.get("preview") : null;
  const [previewCoach, setPreviewCoach] = useState(null);
  const user = previewName ? previewCoach?.user : auth.user;
  const role = previewName ? previewCoach?.role : auth.role;
  const profile = previewName ? previewCoach?.profile : auth.profile;
  const tenant = useMemo(() => previewName ? { slug: OWNER_TENANT_SLUG } : auth.tenant, [previewName, auth.tenant]);
  const [data, setData] = useState(null);
  const [activity, setActivity] = useState(undefined); // undefined loading, null failed, [] empty
  const [selectedId, setSelectedId] = useState(null);
  const [err, setErr] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestId.current;
    setLoading(true);
    try {
      if (previewEnabled && previewName) {
        const { getCockpitFixture, PREVIEW_COACH } = await import("../lib/coachCockpitFixtures");
        if (request !== requestId.current) return;
        const fixture = getCockpitFixture(previewName);
        if (!fixture) throw new Error(`Unknown cockpit preview “${previewName}”.`);
        setPreviewCoach(PREVIEW_COACH);
        setData(fixture);
        setActivity([]);
        setErr(null);
        return;
      }
      const [cockpit, activity] = await Promise.allSettled([
        fetchCoachCockpit(tenant),
        listActivity({ limit: 6 }),
      ]);
      if (request !== requestId.current) return;
      if (cockpit.status === "rejected") throw cockpit.reason;
      setData(cockpit.value);
      setActivity(activity.status === "fulfilled" ? activity.value : null);
      setErr(null);
    } catch (e) {
      if (request !== requestId.current) return;
      // Do not leave the last successful priority queue on screen after a failed refresh.
      // Stale triage looks live and can trigger the wrong client action.
      setData(null);
      setSelectedId(null);
      setErr(e.message || String(e));
    } finally {
      if (request !== requestId.current) return;
      setLoaded(true);
      setLoading(false);
    }
  }, [previewEnabled, previewName, tenant]);

  useEffect(() => { if (previewName || role === "coach") load(); }, [previewName, role, load]);

  if (!previewName) {
    if (!user) {
      return (
        <AppGate title="Sign in to open cockpit" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
          Priority queue and draft messages live here for coaches.
        </AppGate>
      );
    }
    if (role !== "coach") {
      return (
        <AppGate title="Coach area only" actionTo="/client" actionLabel="Client home" secondaryTo="/" secondaryLabel="Home">
          Cockpit is for coaches.
        </AppGate>
      );
    }
  }

  const rows = data?.clients ?? [];
  // Desktop is a convenient master-detail overview, so it can default to the first row.
  // On a phone, a first row must not silently become the whole screen: the coach chooses a
  // person from the queue, then has one obvious way back to it.
  const selectedRow = rows.find((r) => r.client.id === selectedId) ?? null;
  const desktopSelected = selectedRow ?? rows[0] ?? null;

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <CoachTabs active="cockpit" />

      <header className="mt-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <span className="kicker">Coach assistant</span>
          <h1 className="display mt-1 text-3xl md:text-4xl">Client cockpit</h1>
          <p className="mt-2 max-w-[58ch] text-sm opacity-60">
            Review the priority queue, approve the draft, then send only when you choose.
          </p>
        </div>
        {!previewName && (
          <button type="button" onClick={load} disabled={loading} className="btn-ghost w-fit">
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </header>

      {previewName && (
        <div className="hatch mt-4 rounded-2xl border border-dashed border-ink/25 p-3 text-xs font-semibold uppercase tracking-[0.12em] opacity-70">
          Preview — fixture “{previewName}”. Not live data. Send and mark-seen are off.
        </div>
      )}

      {err && (
        <div className="mt-3 rounded-xl border border-danger/25 bg-danger/5 p-3 text-sm text-danger" role="alert">
          <p>{err}</p>
          <button type="button" onClick={load} disabled={loading} className="btn-ghost mt-3 px-4 text-sm">
            {loading ? "Trying again…" : "Retry cockpit"}
          </button>
        </div>
      )}

      <Stats stats={data?.stats} rows={rows} loading={!loaded} failed={loaded && !data && !!err} />
      <RecentActivity rows={activity} />

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-[360px_1fr]">
        <section className={`${selectedRow ? "hidden lg:block" : "block"} glass overflow-hidden`}>
          <div className="border-b border-ink/10 p-4">
            <h2 className="section-title">Priority queue</h2>
          </div>
          {!data ? (
            <p className="p-4 text-sm opacity-60">{err ? "Could not read client signals. Retry cockpit above." : "Reading client signals..."}</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm opacity-60">No active clients found.</p>
          ) : (
            <ul className="divide-y divide-ink/10">
              {rows.map((row) => (
                <li key={row.client.id}>
                  <button type="button" onClick={() => setSelectedId(row.client.id)}
                    className={`min-h-[44px] w-full p-4 text-left transition hover:bg-ink/[0.03] ${
                      (selectedRow?.client.id ?? desktopSelected?.client.id) === row.client.id ? "bg-ink/[0.04]" : ""
                    }`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-bold">{row.client.display_name}</div>
                        <div className="mt-1 text-xs opacity-55">{row.reasons[0]}</div>
                        {row.latestCheckin && !row.latestCheckin.coach_seen && (
                          <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.12em] text-brand-fg">
                            Unseen check-in
                          </div>
                        )}
                      </div>
                      <Band band={row.band} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {desktopSelected ? (
          <div className={selectedRow ? "block" : "hidden lg:block"}>
            {selectedRow && (
              <button type="button" onClick={() => setSelectedId(null)}
                className="btn-ghost mb-3 px-4 text-sm lg:hidden">
                ← Back to queue
              </button>
            )}
            <ClientAssistant
              row={desktopSelected}
              tenantId={profile?.tenant_id}
              tenant={tenant}
              onChanged={previewName ? undefined : load}
              allowMutations={!previewName}
            />
          </div>
        ) : (
          <section className="hidden min-h-[360px] items-center justify-center rounded-2xl border border-dashed border-ink/15 text-sm opacity-50 lg:flex">
            Select a client to review.
          </section>
        )}
      </div>
    </main>
  );
}

function RecentActivity({ rows }) {
  if (rows === undefined) {
    return (
      <section className="glass mt-5 p-4">
        <h2 className="section-title">Recent activity</h2>
        <p className="mt-2 text-sm opacity-60">Loading activity…</p>
      </section>
    );
  }
  if (rows === null) {
    return (
      <section className="glass mt-5 p-4">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="section-title">Recent activity</h2>
          <Link to="/coach/activity" className="text-xs opacity-60 hover:underline">Open ledger</Link>
        </div>
        <p className="mt-2 rounded-xl border border-dashed border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          Could not load recent activity — failed read, not “nothing happened.”
        </p>
      </section>
    );
  }
  if (!rows.length) return null;
  return (
    <section className="glass mt-5 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="section-title">Recent activity</h2>
        <Link to="/coach/activity" className="text-xs opacity-60 hover:underline">Open ledger</Link>
      </div>
      <ul className="grid gap-2 md:grid-cols-2">
        {rows.map((row) => (
          <li key={row.id} className="rounded-xl border border-ink/10 p-3 text-sm">
            <b>{row.clientName}</b> <span className="opacity-70">{row.label}</span>
            <div className="mt-1 text-[11px] opacity-45">{dateTime(row.at)}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stats({ stats, rows = [], loading, failed }) {
  const cards = [
    ["Clients", stats?.total],
    ["Act today", stats?.urgent],
    ["Drafts ready", stats?.drafts],
    ["Unseen check-ins", stats?.unseenCheckins],
  ];
  // Four treatments, matching CoachHome.jsx RosterPulse:
  //   loading — still waiting on the read
  //   failed  — read came back broken (null/error)
  //   known   — value is present and non-zero, or zero by design
  //   zero    — value is 0 on a metric where zero means something bad (render loud)
  // Clients=0 is just a count; the other three at 0 are signals.
  const EM_DASH = "\u2014";
  const unseenHref = !loading && !failed ? firstUnseenCheckinHref(stats, rows) : null;
  const unseenCount = unseenCheckinClients(rows).length;

  return (
    <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
      {cards.map(([label, value]) => {
        const isKnown = !loading && !failed;
        const zeroSignal = isKnown && value === 0 && label !== "Clients";
        const display = isKnown ? (value ?? EM_DASH) : EM_DASH;
        const isUnseenNav = label === "Unseen check-ins" && unseenHref;
        const className = `glass flex min-h-[44px] flex-col justify-center p-4 ${
          failed ? "hatch border-dashed border-ink/25" : ""
        } ${isUnseenNav ? "transition hover:bg-ink/[0.03]" : ""}`;
        const body = (
          <>
            <div className={`display text-3xl ${
              loading ? "animate-pulse opacity-20" :
              failed ? "opacity-30" :
              zeroSignal ? "text-danger" : ""
            }`}>{display}</div>
            <div className={`mt-1 text-[11px] font-bold uppercase tracking-[0.12em] ${
              zeroSignal ? "text-danger" :
              failed ? "opacity-40" : "opacity-50"
            }`}>
              {failed ? "Unavailable" : label}
            </div>
            {isUnseenNav && unseenCount > 1 && (
              <div className="mt-1 text-[11px] opacity-55">
                First of {unseenCount} still in the queue
              </div>
            )}
          </>
        );
        if (isUnseenNav) {
          return (
            <Link
              key={label}
              to={unseenHref}
              className={className}
              aria-label={unseenCount > 1
                ? `Open first unseen check-in. ${unseenCount} unseen still in the queue.`
                : "Open first unseen check-in"}
            >
              {body}
            </Link>
          );
        }
        return (
          <div key={label} className={className}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

const COCKPIT_SENT_KEY = "coachapp-cockpit-sent-history";

function loadSentHistory(clientId) {
  try {
    const all = JSON.parse(localStorage.getItem(COCKPIT_SENT_KEY) || "{}");
    return Array.isArray(all[clientId]) ? all[clientId] : [];
  } catch {
    return [];
  }
}

function pushSentHistory(clientId, entry) {
  try {
    const all = JSON.parse(localStorage.getItem(COCKPIT_SENT_KEY) || "{}");
    const prev = Array.isArray(all[clientId]) ? all[clientId] : [];
    all[clientId] = [entry, ...prev].slice(0, 20);
    localStorage.setItem(COCKPIT_SENT_KEY, JSON.stringify(all));
    return all[clientId];
  } catch {
    return [entry];
  }
}

function ClientAssistant({ row, tenantId, tenant, onChanged, allowMutations = true }) {
  const styles = availableDraftStyles(tenant);
  const [style, setStyle] = useState(() => resolveDraftStyle(localStorage.getItem("coachapp-cockpit-draft-style"), tenant));
  const [draft, setDraft] = useState(row.draft);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState(null);
  const [sentLog, setSentLog] = useState(() => loadSentHistory(row.client.id));

  useEffect(() => {
    setDraft(row.drafts?.[style] || row.draft);
    setSent(false);
    setCopied(false);
    setErr(null);
    setSentLog(loadSentHistory(row.client.id));
  }, [row, style]);

  useEffect(() => {
    const safeStyle = resolveDraftStyle(style, tenant);
    if (safeStyle !== style) {
      setStyle(safeStyle);
      localStorage.setItem("coachapp-cockpit-draft-style", safeStyle);
    }
  }, [style, tenant]);

  function chooseStyle(next) {
    setStyle(next);
    localStorage.setItem("coachapp-cockpit-draft-style", next);
  }

  async function markReviewed() {
    if (!allowMutations) return;
    if (!row.latestCheckin || row.latestCheckin.coach_seen) return;
    setBusy(true); setErr(null);
    try {
      await markCheckinSeen(row.latestCheckin.id);
      onChanged?.();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendDraft() {
    if (!allowMutations) return;
    if (!draft.trim()) return;
    setBusy(true); setErr(null);
    const body = draft.trim();
    try {
      await sendCoachMessage({ clientId: row.client.id, tenantId, body });
      recordActivity({
        tenantId,
        clientId: row.client.id,
        template: "cockpit_draft_sent",
        detail: { style, summary: body.slice(0, 120) },
      }).catch((activityErr) => console.error("activity: Cockpit draft was not recorded", activityErr));
      const nextLog = pushSentHistory(row.client.id, {
        at: new Date().toISOString(),
        style,
        body,
      });
      setSentLog(nextLog);
      setSent(true);
      // Clear the box so the next send isn't a re-fire of the same text.
      // Style switch or client change reloads a fresh template.
      setDraft("");
      onChanged?.();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
    } catch {
      setErr("Could not copy. You can still select the draft text manually.");
    }
  }

  function restoreTemplate() {
    setDraft(row.drafts?.[style] || row.draft || "");
    setSent(false);
  }

  return (
    <section className="glass p-5">
      <div className="flex flex-col gap-3 border-b border-ink/10 pb-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="display text-xl sm:text-2xl">{row.client.display_name}</h2>
            <Band band={row.band} />
          </div>
          <p className="mt-1 text-xs opacity-55">
            {row.client.email || "No email"} · status: {row.client.status || "active"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/coach/clients?client=${row.client.id}`} className="btn-ghost inline-flex min-h-[44px] w-fit items-center">
            Open profile
          </Link>
          {openCheckinHref(row) && (
            <Link to={openCheckinHref(row)} className="btn-ghost inline-flex min-h-[44px] w-fit items-center">
              Open check-in
            </Link>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1.1fr]">
        <div className="space-y-4">
          <Panel title="Why this client needs you">
            <ul className="space-y-2">
              {row.reasons.map((reason) => (
                <li key={reason} className="rounded-xl border border-ink/10 p-3 text-sm">
                  {reason}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Assistant summary">
            <p className="text-sm leading-relaxed opacity-75">{row.summary}</p>
          </Panel>

          <LoopPosition assessment={row.latestAssessment} allowMutations={allowMutations} onChanged={onChanged} />

          <Panel title="Latest signals">
            <Signal label="Check-in" value={row.latestCheckin ? `${dateTime(row.latestCheckin.submitted_at)}${row.latestCheckin.coach_seen ? " · reviewed" : " · unseen"}` : "None visible"} />
            <Signal label="Message" value={row.latestMessage ? `${row.latestMessage.sender_role}: ${row.latestMessage.body}` : "None visible"} />
            <Signal label="Workout" value={row.latestWorkout ? `${row.latestWorkout.status || "logged"} · ${dateTime(row.latestWorkout.completed_at || row.latestWorkout.session_date)}` : "None visible"} />
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Coach-approved draft">
            <div className="mb-3 flex flex-wrap gap-1.5 rounded-xl border border-ink/10 bg-ink/[0.025] p-1.5">
              {styles.map((option) => (
                <button key={option.key} type="button" onClick={() => chooseStyle(option.key)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-bold uppercase tracking-[0.08em] transition ${
                    style === option.key ? "bg-brand text-brand-text" : "opacity-55 hover:bg-ink/[0.05] hover:opacity-90"
                  }`}>
                  {option.label}
                </button>
              ))}
            </div>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
              placeholder="Draft clears after send. Use Restore template if you need the AI wording again."
              className="min-h-[240px] w-full rounded-xl border border-ink/15 px-3 py-3 text-sm leading-relaxed"
            />
            {err && <p className="mt-2 text-sm text-danger">{err}</p>}
            {sent && <p className="mt-2 text-sm text-success">Sent to client messages. Box cleared for the next send.</p>}
            {copied && <p className="mt-2 text-sm text-success">Copied.</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={copyDraft} className="btn-ghost" disabled={busy || !draft.trim()}>
                Copy draft
              </button>
              {allowMutations && (
                <button type="button" onClick={sendDraft} className="btn-primary" disabled={busy || !draft.trim()}>
                  {busy ? "Working..." : "Send draft"}
                </button>
              )}
              <button type="button" onClick={restoreTemplate} className="btn-ghost" disabled={busy}>
                Restore template
              </button>
              {allowMutations && row.latestCheckin && !row.latestCheckin.coach_seen && (
                <button type="button" onClick={markReviewed} className="btn-ghost" disabled={busy}>
                  Mark reviewed
                </button>
              )}
            </div>
          </Panel>

          <Panel title="Sent from Cockpit">
            <p className="mb-2 text-xs opacity-55">
              Session history on this device for bulk sends. Full threads live in{" "}
              <Link to="/coach/inbox" className="underline">Inbox</Link>
              {" "}or the client&apos;s Messages tab.
            </p>
            {sentLog.length === 0 ? (
              <p className="text-sm opacity-50">Nothing sent from Cockpit for this client yet.</p>
            ) : (
              <ul className="max-h-64 space-y-2 overflow-y-auto">
                {sentLog.map((item, i) => (
                  <li key={`${item.at}-${i}`} className="rounded-xl border border-ink/10 p-3 text-sm">
                    <div className="flex items-center justify-between gap-2 text-[11px] opacity-50">
                      <span className="uppercase tracking-wide">{item.style || "draft"}</span>
                      <time>{dateTime(item.at)}</time>
                    </div>
                    <p className="mt-1 line-clamp-4 whitespace-pre-wrap opacity-80">{item.body}</p>
                    <button
                      type="button"
                      className="mt-2 text-xs underline opacity-60 hover:opacity-100"
                      onClick={() => { setDraft(item.body); setSent(false); }}
                    >
                      Load into editor
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </section>
  );
}

function Panel({ title, children }) {
  return (
    <div className="rounded-xl border border-ink/10 p-4">
      <h3 className="section-title mb-3">{title}</h3>
      {children}
    </div>
  );
}

const STAGES = ["M01", "M02", "M03", "M04", "M05"];

// A quick overview of the client's current check-in.
// Solid brackets = confirmed and real, counted toward a streak. Round brackets
// = a machine proposal waiting on the coach — visible so confirming isn't a chore
// he has to go elsewhere to do, but never rendered like a real position.
function LoopPosition({ assessment, allowMutations, onChanged }) {
  const [correcting, setCorrecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setCorrecting(false);
    setReason("");
    setErr(null);
  }, [assessment?.id]);

  if (!assessment) {
    return (
      <Panel title="Loop position">
        <p className="text-sm opacity-50">No read yet.</p>
      </Panel>
    );
  }

  async function act(fn) {
    if (!allowMutations || busy) return;
    setBusy(true); setErr(null);
    try {
      await fn();
      setCorrecting(false); setReason("");
      onChanged?.();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  if (assessment.confirmed_tag) {
    return (
      <Panel title="Loop position">
        <p className="text-2xl font-bold">[&nbsp;{assessment.confirmed_tag}&nbsp;]</p>
        <p className="mt-1 text-xs opacity-50">Confirmed.</p>
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      </Panel>
    );
  }

  if (assessment.proposed_tag) {
    return (
      <Panel title="Loop position">
        <p className="text-2xl font-bold text-brand-fg">(&nbsp;{assessment.proposed_tag}&nbsp;)</p>
        <p className="mt-1 text-xs opacity-50">Proposed by the assistant — waiting on you. Counts toward nothing until confirmed.</p>
        {(assessment.proposed_evidence ?? []).length > 0 && (
          <ul className="mt-3 space-y-1.5">
            {assessment.proposed_evidence.map((e, i) => (
              <li key={i} className="rounded-lg border border-ink/10 p-2 text-xs opacity-75">
                <span className="font-semibold">{e.field_key}:</span> "{e.quote_or_value}" — {e.why}
              </li>
            ))}
          </ul>
        )}
        {allowMutations && !correcting && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => act(() => confirmCheckinTag(assessment.id, assessment.proposed_tag))} className="btn-primary">
              {busy ? "Working…" : "Confirm"}
            </button>
            <button type="button" disabled={busy} onClick={() => setCorrecting(true)} className="btn-ghost">Correct</button>
            <button type="button" disabled={busy} onClick={() => act(() => rejectCheckinTag(assessment.id, reason || null))} className="btn-ghost">No tag is right</button>
          </div>
        )}
        {allowMutations && correcting && (
          <div className="mt-3 space-y-2 rounded-xl border border-ink/10 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide opacity-60">Correct to:</p>
            <div className="flex flex-wrap gap-1.5">
              {STAGES.map((s) => (
                <button key={s} type="button" disabled={busy}
                  onClick={() => act(() => confirmCheckinTag(assessment.id, s, reason || null))}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-bold ${s === assessment.proposed_tag ? "border-ink/15 opacity-40" : "border-ink/15 hover:bg-ink/[0.05]"}`}>
                  {s}
                </button>
              ))}
            </div>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="Why? (optional, but this is the highest-value field in the system)"
              className="min-h-[60px] w-full rounded-lg border border-ink/15 px-2 py-1.5 text-xs" />
            <button type="button" disabled={busy} onClick={() => setCorrecting(false)} className="btn-ghost text-xs">Cancel</button>
          </div>
        )}
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      </Panel>
    );
  }

  // Declined — the generator ran and found insufficient evidence. Quiet by
  // design: this is correct behaviour, not a failure, and demands no action.
  return (
    <Panel title="Loop position">
      <p className="text-sm opacity-50">No tag proposed — {declineLabel(assessment.no_tag_reason)}.</p>
    </Panel>
  );
}

function declineLabel(reason) {
  const known = {
    insufficient_evidence: "this check-in didn't carry enough to go on",
    requires_history: "not enough history yet for this client",
    client_type_unknown: "client not yet classified lifestyle/prep",
    prep_physiology: "expected prep-phase physiology, not proposable as avoidance",
  };
  return known[reason] || reason || "declined";
}

function Signal({ label, value }) {
  return (
    <div className="border-t border-ink/10 py-2 first:border-t-0 first:pt-0 last:pb-0">
      <div className="text-[11px] font-bold uppercase tracking-[0.12em] opacity-45">{label}</div>
      <p className="mt-1 line-clamp-3 text-sm opacity-75">{value}</p>
    </div>
  );
}

function Band({ band }) {
  const label = band === "act" ? "Act" : band === "review" ? "Review" : "Steady";
  return (
    <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] ${
      BAND_STYLES[band] || BAND_STYLES.steady
    }`}>
      {label}
    </span>
  );
}

function dateTime(iso) {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}


