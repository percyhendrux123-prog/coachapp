import { useEffect, useState, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { isOwnerTenant } from "../lib/tenantIdentity";
import { listSystemBuyers, intakeLabel, convertSystemBuyer, originLabel, stuckReasons } from "../lib/systemBuyers";
import {
  listClients, getClientCheckins, markCheckinSeen,
  getClientProgram, getClientMessages, sendCoachMessage, getClientWorkouts,
  getClientIntakes,
  createClient, updateClient, getClientProfile, createClientInvite, getClientSigninCode,
  prepareClientAccount, claimLinkFromPath,
  sendClientNudge,
  archiveClient, deleteClient,
  getClientNotes, addClientNote, updateClientNote,
  getClientArchiveCounts, getClientArchive,
  getClientScheduleAdjustments,
  listOnboardingFacts,
} from "../lib/coachClients";
import { statusLine, isStuck, indexFacts, actionOwner } from "../lib/onboardingFacts";
import { summarizeAdjustment, reasonChipLabel } from "../lib/scheduleAdjustments";
import TrainerizeImport from "../components/TrainerizeImport";
import ProgramBuilder from "../components/ProgramBuilder";
import CoachClientVideos from "../components/CoachClientVideos";
import CoachClientPhotos, { CheckinPhotos } from "../components/CoachClientPhotos";
import { signPhotoPaths } from "../lib/progressPhotos";
import { createIntakeInvite, createScreenInvite } from "../lib/intake";
// Invite delivery: the app composes, the coach's own mail client sends. See lib/mailto.js.
import { buildMailto, openMailClient } from "../lib/mailto";
import { accountInviteEmail, intakeInviteEmail } from "../lib/inviteCopy";
import {
  uploadMealPlan, getMealPlan, MEAL_PLAN_MAX_BYTES,
  getMealPlanRecord, upsertMealPlan, getClientMacroInputs,
} from "../lib/mealPlan";
import { generateMealPlan, missingBodyMetrics, PROTEIN_PER_KG_LBM_RANGE, FAT_PCT_DEFAULT } from "../lib/mealGen";
import { generatePeakWeekProtocol, DIVISIONS } from "../lib/peakWeek";
import { generateTrainingProgram } from "../lib/programGen";
import { createProgram, assignProgram } from "../lib/programs";
import MealPlanEditor from "../components/MealPlanEditor";
import { getStructuredPlanRecord, getPlanSlotsWithMeals, releaseStructuredPlan, summarizePlanMacros, getMealPhotoUrl } from "../lib/clientMealPlan";
import { cmToFtIn, ftInToCm, kgToLb, lbToKg, ACTIVITY_LEVELS } from "../lib/units";
// This page RENDERS CoachTabs (see the <CoachTabs active="clients" /> below), so it needs a
// real local binding. The `export { CoachTabs } from …` line at the foot of this file is a
// re-export: it forwards the name to importers of this module but declares NOTHING in this
// module's scope. When CoachTabs was extracted to components/, the local `function CoachTabs`
// was replaced by that re-export, which left the JSX below referencing a free identifier —
// a ReferenceError at render, i.e. a blank page, and invisible to the build.
import { CoachTabs } from "../components/CoachTabs";
import { DemoDisclosure } from "../components/DemoVideoPreview";
import {
  TypeBadge, ClassificationFields, BulkClassify, ClassificationSummary,
} from "../components/ClientClassification";
import { daysOutLabel, prepMissingShowDate, classificationOf, classificationLabel } from "../lib/clientType";
import { recordActivity } from "../lib/activity";
import { getReleaseChecklist, releaseClient } from "../lib/releaseClient";
import { checklistLines, isReadyToRelease, offerNoNutrition, runRelease } from "../lib/releaseChecklist";
import BodyMetricsConfirm from "../components/BodyMetricsConfirm";
import AppGate from "../components/AppGate";

// Phase 3 coach client management: list clients, review check-ins, see their program, message.
export default function CoachClients() {
  const { user, role, profile, tenant } = useAuth();
  // undefined = still loading, null = read failed, [] = genuine empty roster
  const [clients, setClients] = useState(undefined);
  const [selId, setSelId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [err, setErr] = useState(null);
  const [missingFilter, setMissingFilter] = useState(false); // filter list to clients missing body metrics
  // Slice 1: onboarding facts per client. undefined = loading, null = read FAILED, Map = loaded.
  const [facts, setFacts] = useState(undefined);
  const [stuckFilter, setStuckFilter] = useState(false);

  // Goal weight is coach-optional target only — never blocks generation or roster health.
  const REQUIRED_METRICS = ["sex", "age", "height_cm", "weight_kg", "activity_level"];
  const metricLabel = (m) => ({ sex: "Sex", age: "Age", height_cm: "Height", weight_kg: "Weight", activity_level: "Activity level" }[m] ?? m);
  function missingMetrics(c) {
    return REQUIRED_METRICS.filter((m) => {
      const v = c[m];
      return v === null || v === undefined || v === "";
    });
  }

  const reload = useCallback(
    () => {
      // Facts ride alongside the roster, never gate it: a failed facts read renders as
      // "status unavailable" on each row while the roster itself still loads.
      listOnboardingFacts().then((rows) => setFacts(indexFacts(rows))).catch(() => setFacts(null));
      return listClients({ includeArchived: showArchived })
        .then((rows) => { setClients(rows); setErr(null); })
        .catch((e) => { setClients(null); setErr(e.message); });
    },
    [showArchived],
  );
  useEffect(() => { if (role === "coach") reload(); }, [role, reload]);

  // Deep link: /coach/clients?client=<id> opens straight into that client. The coach home
  // links here from its attention queue, where "Open client" is about one named person —
  // landing on an unfiltered list and making the coach find them again is the difference
  // between an action and a signpost. Applied once the roster has loaded so the id can be
  // checked against it; an unknown id is ignored rather than selecting nothing.
  const [searchParams, setSearchParams] = useSearchParams();
  const wantedClient = searchParams.get("client");
  const wantedTab = searchParams.get("tab");
  // Deep link from the coach home's onboarding rows: /coach/clients?stuck=1 opens with the
  // Stuck filter already on, so the row's count and this list agree.
  const wantedStuck = searchParams.get("stuck");
  useEffect(() => {
    if (wantedStuck !== "1") return;
    setStuckFilter(true);
    setSearchParams((p) => { p.delete("stuck"); return p; }, { replace: true });
  }, [wantedStuck, setSearchParams]);
  const [deepTab, setDeepTab] = useState(null);
  useEffect(() => {
    if (!wantedClient || !clients?.length) return;
    if (clients.some((c) => c.id === wantedClient)) {
      setSelId(wantedClient);
      // One-shot tab: apply for this open only. Cleared after ClientDetail consumes it
      // so the next client does not inherit Nutrition/Messages/etc.
      setDeepTab(wantedTab || null);
    }
    // Drop the params once consumed so a later manual selection is not fighting the URL.
    setSearchParams((p) => {
      p.delete("client");
      p.delete("tab");
      return p;
    }, { replace: true });
  }, [wantedClient, wantedTab, clients, setSearchParams]);

  if (!user) {
    return (
      <AppGate title="Sign in to manage clients" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
        Client roster, programs, and check-ins live here for coaches.
      </AppGate>
    );
  }
  if (role !== "coach") {
    return (
      <AppGate title="Coach area only" actionTo="/client" actionLabel="Client home" secondaryTo="/" secondaryLabel="Home">
        This roster is for coaches, not client accounts.
      </AppGate>
    );
  }

  const roster = clients ?? [];
  const selected = roster.find((c) => c.id === selId) ?? null;

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <CoachTabs active="clients" />

      {/* List header (title + Add client). On mobile it's hidden while a client detail
          is open, so the drill-down reads as a focused screen. Always shown on md+. */}
      <div className={`mt-6 items-end justify-between gap-3 ${selected ? "hidden md:flex" : "flex"}`}>
        <div>
          <h1 className="display text-3xl">Clients</h1>
          {Array.isArray(clients) && <ClassificationSummary clients={roster} />}
          {Array.isArray(clients) && (() => { const n = roster.filter((c) => missingMetrics(c).length > 0).length; return n > 0 ? <p className="mt-1 text-xs text-danger">{n} client{n !== 1 ? "s" : ""} missing body metrics</p> : null; })()}
          {facts === null && <p className="mt-1 text-xs text-danger">Onboarding status could not be read — a failed load, not "everyone is onboarded".</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 rounded-full border border-ink/15 px-3 py-1.5 text-xs font-semibold">
            <input type="checkbox" checked={showArchived}
              onChange={(e) => { setShowArchived(e.target.checked); setSelId(null); }}
              className="h-4 w-4" />
            Show archived
          </label>
          <label className="flex items-center gap-2 rounded-full border border-ink/15 px-3 py-1.5 text-xs font-semibold">
            <input type="checkbox" checked={missingFilter}
              onChange={(e) => setMissingFilter(e.target.checked)}
              className="h-4 w-4" />
            Missing metrics only
          </label>
          <label className="flex items-center gap-2 rounded-full border border-ink/15 px-3 py-1.5 text-xs font-semibold"
            title="Not onboarded, not paused, and unchanged for 3+ days">
            <input type="checkbox" checked={stuckFilter}
              onChange={(e) => setStuckFilter(e.target.checked)}
              className="h-4 w-4" />
            Stuck{facts instanceof Map ? ` (${roster.filter((c) => isStuck(facts.get(c.id))).length})` : ""}
          </label>
          <button onClick={() => setAdding((v) => !v)}
            className="btn-primary px-3 py-1.5">
            {adding ? "Close" : "Add client"}
          </button>
        </div>
      </div>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}

      {adding && (
        <AddClientForm tenantId={profile?.tenant_id}
          onCreated={(c) => { setAdding(false); reload(); setSelId(c.id); }} />
      )}

      {/* Bulk classifier. Sits above the master–detail and disappears once every
          client is classified, so it is a job with an end rather than permanent
          furniture. Hidden on mobile while a client detail is open, matching the
          drill-down behaviour of the list header above. */}
      {Array.isArray(clients) && (
        <div className={selected ? "hidden md:block" : "block"}>
          <BulkClassify clients={roster} onChanged={reload} />
        </div>
      )}

      {/* Master–detail: two panes side by side on md+, drill-down on mobile.
          Same `selected` state drives both — pure Tailwind responsive visibility. */}
      <div className="mt-5 md:flex md:items-start md:gap-6">
        {/* Roster (master). Fixed-width, independently scrollable sidebar on desktop;
            hidden on mobile once a client is open. */}
        <div className={`${selected ? "hidden md:block" : "block"} md:w-72 md:shrink-0 md:sticky md:top-6 md:max-h-[calc(100vh-2.5rem)] md:overflow-y-auto`}>
          <ul className="glass divide-y divide-ink/10 overflow-hidden">
            {clients === undefined && <li className="p-4 text-sm opacity-60">Loading roster…</li>}
            {clients === null && (
              <li className="p-4 text-sm text-danger">
                Could not load clients — this is a failed read, not an empty roster. Refresh or try again.
              </li>
            )}
            {Array.isArray(clients) && clients.length === 0 && <li className="p-4 text-sm opacity-60">No clients yet.</li>}
            {roster.filter((c) => !missingFilter || missingMetrics(c).length > 0)
              .filter((c) => !stuckFilter || isStuck(facts instanceof Map ? facts.get(c.id) : null)).map((c) => {
              const mm = missingMetrics(c);
              const fact = facts instanceof Map ? facts.get(c.id) : undefined;
              return (
              <li key={c.id}>
                <button type="button" onClick={() => { setDeepTab(null); setSelId(c.id); }}
                  className={`flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-ink/[0.03] ${c.id === selId ? "bg-ink/[0.05]" : ""}`}>
                  <span className="min-w-0 truncate font-bold">
                    {c.display_name}
                    {c.status === "archived" && (
                      <span className="ml-2 rounded-full border border-ink/15 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] opacity-60">
                        Archived
                      </span>
                    )}
                    {originLabel(c.origin) && (
                      <span className="ml-2 rounded-full border border-ink/15 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] opacity-60"
                        title={c.origin === "system" ? "Started with Self-serve plan" : "Imported from Trainerize"}>
                        {originLabel(c.origin)}
                      </span>
                    )}
                    {mm.length > 0 && (
                      <span className="ml-2 rounded-full bg-danger/10 px-2 py-0.5 text-[10px] text-danger" title={`Missing: ${mm.map(metricLabel).join(", ")}`}>
                        {mm.length} missing
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-xs opacity-60">
                    <TypeBadge client={c} />
                    {c.coaching_tier && <span className="rounded-full bg-ink/5 px-2 py-0.5 capitalize">{c.coaching_tier}</span>}
                    <span>{c.status}</span>
                  </span>
                </button>
                {/* Slice 1: one honest line per client. Loading and failed reads look different
                    from a real status; "Onboarded" is the only line that means nothing is owed. */}
                {c.status !== "archived" && (
                  <div className={`-mt-1 px-4 pb-2 text-[11px] leading-snug ${
                    facts === null || (fact && isStuck(fact)) ? "text-danger"
                      : fact && actionOwner(fact.next_action) === "coach" ? "opacity-80"
                      : "opacity-50"}`}>
                    {facts === undefined ? "Status loading…" : facts === null ? "Status unavailable" : statusLine(fact ?? null)}
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        </div>

        {/* Detail. Fills the remaining width on desktop (placeholder when nothing is
            selected); on mobile it replaces the list and carries a Back control. */}
        <div className={`${selected ? "block" : "hidden md:block"} md:min-w-0 md:flex-1`}>
          {selected ? (
            <>
              <button
                type="button"
                onClick={() => { setSelId(null); setDeepTab(null); }}
                className="mb-3 inline-flex min-h-[44px] items-center gap-1 text-sm opacity-70 hover:opacity-100 md:hidden"
              >
                ← Back to clients
              </button>
              <ClientDetail
                key={selected.id}
                client={selected}
                tenantId={profile?.tenant_id}
                initialTab={deepTab}
                onDeepTabConsumed={() => setDeepTab(null)}
                onChanged={reload}
                onRemoved={() => { setSelId(null); setDeepTab(null); reload(); }}
              />
            </>
          ) : (
            <div className="hidden min-h-[300px] items-center justify-center rounded-2xl border border-dashed border-ink/15 text-sm opacity-50 md:flex">
              Select a client to view their details.
            </div>
          )}
        </div>
      </div>

      {/* Import panel stays below both panes; hidden on mobile while a detail is open. */}
      <div className={selected ? "hidden md:block" : "block"}>
        <TrainerizeImport onImported={reload} />
        {/* Platform owner only: who bought Self-serve plan. Buyers live in self-serve tenants
            this roster cannot see; list_system_buyers() is the gated reader. One action:
            move a signed-in buyer onto this roster (convert_system_buyer_to_coaching). */}
        {isOwnerTenant(tenant) && <SystemBuyersSection onConverted={(id) => { reload(); setSelId(id); setDeepTab(null); }} />}
      </div>
    </main>
  );
}

// Add a client record before they ever log in, so the coach can start prepping (assign a
// program, send an intake/invite link). Only name is required; email enables the invite +
// email-match linking. Duplicate email is surfaced (checked in-app + DB unique backstop).
function AddClientForm({ tenantId, onCreated }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [coachingTier, setCoachingTier] = useState("entry");
  const [status, setStatus] = useState("invited");
  // Unset means unclassified. Deliberately not pre-selected to "lifestyle" —
  // a default here would silently classify every client created from now on.
  const [cls, setCls] = useState({ clientType: "", showDate: "", showName: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (!displayName.trim()) { setErr("Name is required."); return; }
    setErr(null); setBusy(true);
    try {
      const c = await createClient({
        tenantId, displayName, email, coachingTier, status,
        clientType: cls.clientType, showDate: cls.showDate, showName: cls.showName,
      });
      onCreated(c);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="glass mt-4 space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="opacity-60">Name *</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required
            className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2" />
        </label>
        <label className="text-sm">
          <span className="opacity-60">Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="client@example.com"
            className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2" />
        </label>
        <label className="text-sm">
          <span className="opacity-60">Tier</span>
          <select value={coachingTier} onChange={(e) => setCoachingTier(e.target.value)}
            className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2">
            <option value="entry">Entry</option>
            <option value="standard">Coaching</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="opacity-60">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2">
            <option value="invited">Invited</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </label>
      </div>
      <ClassificationFields value={cls} onChange={setCls} idPrefix="add" />
      {err && <p className="text-sm text-danger">{err}</p>}
      <button disabled={busy} className="btn-primary">
        {busy ? "Adding…" : "Create client"}
      </button>
    </form>
  );
}

function ClientDetail({ client, tenantId, onChanged, onRemoved, initialTab, onDeepTabConsumed }) {
  const PRIMARY_DETAIL = ["checkins", "messages", "program", "nutrition", "profile"];
  const MORE_DETAIL = ["intake", "workouts", "photos", "videos", "notes", "archive"];
  const allKnown = new Set([...PRIMARY_DETAIL, ...MORE_DETAIL]);
  const safeInitial = initialTab && allKnown.has(initialTab) ? initialTab : "checkins";
  const [tab, setTab] = useState(safeInitial);
  const [moreOpen, setMoreOpen] = useState(() => MORE_DETAIL.includes(safeInitial));
  // The Trainerize archive tab only exists for clients with imported history —
  // for everyone else the tab row is unchanged.
  const [archiveCounts, setArchiveCounts] = useState(null);
  const [archiveFailed, setArchiveFailed] = useState(false);
  useEffect(() => {
    setArchiveCounts(null);
    setArchiveFailed(false);
    getClientArchiveCounts(client.id)
      .then((c) => { setArchiveCounts(c); setArchiveFailed(false); })
      .catch(() => { setArchiveCounts(null); setArchiveFailed(true); });
  }, [client.id]);
  // Deep link / Attention handoff: one-shot tab from URL, then clear parent deepTab
  // so the next client defaults to check-ins (not sticky Nutrition).
  useEffect(() => {
    if (!initialTab) return;
    if (allKnown.has(initialTab)) {
      setTab(initialTab);
      if (MORE_DETAIL.includes(initialTab)) setMoreOpen(true);
    } else {
      setTab("checkins");
    }
    onDeepTabConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot consume
  }, [initialTab, client.id]);
  const hasArchive = (archiveCounts?.total ?? 0) > 0;
  useEffect(() => { if (!hasArchive && tab === "archive") setTab("checkins"); }, [hasArchive, tab]);

  const primaryTabs = PRIMARY_DETAIL;
  const moreTabs = ["intake", "workouts", "photos", "videos", "notes", ...(hasArchive ? ["archive"] : [])];
  function goTab(id) {
    setTab(id);
    if (PRIMARY_DETAIL.includes(id)) setMoreOpen(false);
  }
  return (
    <section className="glass p-5">
      <h2 className="display text-xl sm:text-2xl">{client.display_name}</h2>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs opacity-60">
        <TypeBadge client={client} />
        <span>·</span>
        <span>{client.email ?? "—"}</span>
        <span>·</span>
        <span>{client.subscription_status ?? "no subscription"}</span>
        {client.origin === "system" && (
          <>
            <span>·</span>
            <span title="Bought Self-serve plan first; moved to coaching on this date">
              From Self-serve plan{client.converted_from_client_id && client.joined_at ? ` · moved to coaching ${new Date(client.joined_at).toLocaleDateString()}` : ""}
            </span>
          </>
        )}
      </p>
      {/* A prep client with no show date is stated here rather than left to be
          noticed. The Profile tab is where it gets fixed, so say so. */}
      {prepMissingShowDate(client) && (
        <p className="mt-1 text-xs text-danger">
          Prep client with no show date. Days-out, peak-week timing and late-prep
          physiology all read from it — add it under Profile.
        </p>
      )}
      {client.client_type === "prep" && client.show_date && (
        <p className="mt-1 text-xs opacity-60">
          {client.show_name ? `${client.show_name} · ` : ""}{client.show_date} · {daysOutLabel(client.show_date)}
        </p>
      )}
      {/* Slice 3: one Release. The checklist is the database's own answer, rendered as it
          stands; the per-piece buttons below stay for mid-coaching re-releases. */}
      <ReleasePanel client={client} onReleased={onChanged} />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <IntakeInviteButton client={client} tenantId={tenantId} />
        <AccountInviteButton client={client} />
        <SigninCodeButton client={client} />
        <PingPushButton clientId={client.id} />
      </div>
      <nav className="mt-4 flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-ink/10 text-sm" aria-label="Client detail">
        {primaryTabs.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => goTab(t)}
            className={`-mb-px min-h-[44px] border-b-2 px-2 pb-2 capitalize transition ${
              tab === t ? "border-brand font-bold" : "border-transparent font-medium opacity-50 hover:opacity-80"
            }`}
          >
            {t}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          className={`-mb-px min-h-[44px] border-b-2 px-2 pb-2 font-medium transition ${
            moreOpen || moreTabs.includes(tab)
              ? "border-brand font-bold"
              : "border-transparent opacity-50 hover:opacity-80"
          }`}
        >
          More
        </button>
      </nav>
      {moreOpen && (
        <div className="mt-2 flex flex-wrap gap-2" role="region" aria-label="More client tools">
          {moreTabs.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => goTab(t)}
              className={`min-h-[44px] rounded-xl border px-3 text-sm font-semibold capitalize ${
                tab === t ? "border-brand bg-brand/10" : "border-ink/10 opacity-80 hover:opacity-100"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {archiveFailed && (
        <p className="mt-2 rounded-xl border border-dashed border-ink/20 p-2 text-xs opacity-60">
          Archive status could not be loaded — tab hidden until the source is readable.
        </p>
      )}
      <div className="mt-4">
        {tab === "profile" && (
          <div className="space-y-8">
            <Profile clientId={client.id} onSaved={onChanged} onRemoved={onRemoved} />
            <BodyMetricsConfirm clientId={client.id} onSaved={onChanged} />
          </div>
        )}
        {tab === "checkins" && <Checkins clientId={client.id} />}
        {tab === "intake" && <Intake clientId={client.id} />}
        {tab === "program" && <Program clientId={client.id} tenantId={tenantId} />}
        {tab === "workouts" && <Workouts clientId={client.id} />}
        {tab === "photos" && <CoachClientPhotos clientId={client.id} />}
        {tab === "nutrition" && <Nutrition clientId={client.id} tenantId={tenantId} clientName={client.display_name} />}
        {tab === "videos" && <CoachClientVideos clientId={client.id} tenantId={tenantId} />}
        {tab === "notes" && <Notes clientId={client.id} tenantId={tenantId} />}
        {tab === "messages" && <Messages clientId={client.id} tenantId={tenantId} />}
        {tab === "archive" && <Archive clientId={client.id} counts={archiveCounts} />}
      </div>
    </section>
  );
}

// ── Trainerize archive: imported historical sessions + meal logs, read-only.
// Payloads are verbatim from the Trainerize export — weights are KG (live app data is
// in the tenant unit instead), so every weight is labeled explicitly.
function Archive({ clientId, counts }) {
  const [kind, setKind] = useState(counts?.workouts > 0 ? "workout_session" : "meal");
  return (
    <div>
      <p className="text-xs opacity-60">
        Imported from Trainerize — history preserved as exported (weights in kg). Read-only.
      </p>
      <div className="mt-3 flex gap-2 text-xs">
        {[["workout_session", `Workouts (${counts?.workouts ?? 0})`], ["meal", `Meals (${counts?.meals ?? 0})`]].map(([k, label]) => (
          <button key={k} onClick={() => setKind(k)}
            className={`rounded-full px-3 py-1 ${kind === k ? "bg-ink text-paper" : "border border-ink/15 opacity-70 hover:opacity-100"}`}>
            {label}
          </button>
        ))}
      </div>
      <ArchiveList key={`${clientId}:${kind}`} clientId={clientId} kind={kind} />
    </div>
  );
}

function ArchiveList({ clientId, kind }) {
  const PAGE = 40;
  const [rows, setRows] = useState(undefined);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  const loadMore = useCallback(async (offset) => {
    const batch = await getClientArchive(clientId, kind, { limit: PAGE, offset });
    setFailed(false);
    setRows((prev) => [...(prev ?? []), ...batch]);
    if (batch.length < PAGE) setDone(true);
  }, [clientId, kind]);
  useEffect(() => {
    setRows(undefined);
    setFailed(false);
    setDone(false);
    loadMore(0).catch(() => { setFailed(true); setRows(null); });
  }, [loadMore]);

  if (rows === undefined) return <Muted>Loading…</Muted>;
  if (failed) return <LoadFail>Could not read this archive — failed load, not “nothing imported.”</LoadFail>;
  if (rows.length === 0) return <Muted>Nothing imported in this section.</Muted>;
  return (
    <>
      <ul className="mt-3 space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="rounded-lg border border-ink/10 p-3 text-sm">
            {r.kind === "workout_session" ? <ArchiveSession row={r} /> : <ArchiveMeal row={r} />}
          </li>
        ))}
      </ul>
      {!done && (
        <button onClick={() => loadMore(rows.length).catch(() => {})}
          className="mt-3 rounded-md border border-ink/15 px-3 py-1.5 text-xs hover:bg-ink/[0.03]">
          Load more
        </button>
      )}
    </>
  );
}

const archiveDate = (iso) => (iso ? new Date(iso).toLocaleDateString() : "—");

function ArchiveSession({ row }) {
  const p = row.payload ?? {};
  return (
    <div>
      <div className="flex justify-between">
        <span className="font-medium">{p.workout_name || "Workout"}</span>
        <span className="text-xs opacity-60">
          {archiveDate(row.occurred_at)}
          {p.duration_min != null && ` · ${p.duration_min} min`}
          {p.rpe_avg != null && ` · RPE ${p.rpe_avg}`}
        </span>
      </div>
      <ul className="mt-1 space-y-0.5 text-xs opacity-80">
        {(p.exercises ?? []).map((ex, i) => (
          <li key={i}>
            {ex.name} — {(ex.sets ?? []).map((s) =>
              `${s.weight_kg != null ? `${s.weight_kg} kg` : "–"}×${s.reps ?? "–"}${s.rpe != null ? `@${s.rpe}` : ""}`).join(", ")}
          </li>
        ))}
      </ul>
      {p.notes && <p className="mt-1 text-xs italic opacity-60">{p.notes}</p>}
    </div>
  );
}

function ArchiveMeal({ row }) {
  const p = row.payload ?? {};
  const m = p.macros ?? {};
  // Meals carry a plain calendar date; occurred_at is that date at midnight UTC, which
  // toLocaleDateString would shift a day back in western timezones. Render the date
  // as local-midnight instead (the session_date pattern used app-wide).
  const date = p.date ? new Date(p.date + "T00:00:00").toLocaleDateString() : archiveDate(row.occurred_at);
  return (
    <div>
      <div className="flex justify-between">
        <span className="font-medium capitalize">
          {p.meal_type || "Meal"}
          {"eaten" in p && (
            <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-normal ${p.eaten ? "bg-ink/5" : "bg-brand/10 text-ink"}`}>
              {p.eaten ? "eaten" : "skipped"}
            </span>
          )}
        </span>
        <span className="text-xs opacity-60">{date}</span>
      </div>
      {(m.kcal != null || m.protein_g != null) && (
        <p className="text-xs opacity-60">
          {m.kcal != null && `${m.kcal} kcal`}{m.protein_g != null && ` · P ${m.protein_g}`}{m.carbs_g != null && ` / C ${m.carbs_g}`}{m.fat_g != null && ` / F ${m.fat_g}`}
        </p>
      )}
      <ul className="mt-1 space-y-0.5 text-xs opacity-80">
        {(p.items ?? []).map((it, i) => (
          <li key={i} className="flex justify-between gap-3">
            <span>{it.name}{it.grams != null && <span className="opacity-50"> · {it.grams} g</span>}</span>
            {it.kcal != null && <span className="shrink-0 opacity-50">{it.kcal} kcal</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Checkins({ clientId }) {
  const [rows, setRows] = useState(null);
  // One batched signing call for every check-in's photos (signPhotoPaths takes the
  // whole path list) instead of one storage round-trip per row. null = signing
  // failed; CheckinPhotos then falls back to signing its own row.
  const [urls, setUrls] = useState(null);
  const [failed, setFailed] = useState(false);
  const [err, setErr] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    getClientCheckins(clientId)
      .then(async (r) => {
        const list = r ?? [];
        const paths = list.flatMap((c) => c.photo_urls ?? []).filter(Boolean);
        const m = paths.length ? await signPhotoPaths(paths).catch(() => null) : new Map();
        if (cancelled) return; // a late response must never render under another client
        setRows(list);
        setUrls(m);
        setErr(null);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [clientId, reloadTick]);
  useEffect(() => { setRows(null); }, [clientId]);
  async function seen(id) {
    setErr(null);
    try {
      await markCheckinSeen(id);
      // Optimistic local flip — a full refetch here would re-sign and re-download
      // every photo for one boolean change.
      setRows((prev) => (prev ?? []).map((r) => (r.id === id ? { ...r, coach_seen: true } : r)));
    } catch (e) { setErr(e.message || "Unknown error"); }
  }
  if (rows == null && !failed) return <Muted>Loading check-ins…</Muted>;
  if (failed) {
    return (
      <div>
        <Muted>Could not read check-ins — this is a failed load, not a count of zero.</Muted>
        <button type="button" onClick={() => setReloadTick((t) => t + 1)} className="btn-ghost mt-2 px-4 text-sm">Retry</button>
      </div>
    );
  }
  if (rows.length === 0) return <Muted>No check-ins yet.</Muted>;
  return (
    <div>
      {err && <p className="mb-2 text-sm text-danger" role="alert">Could not mark check-in seen: {err}</p>}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className={`rounded-lg border p-3 text-sm ${r.coach_seen ? "border-ink/10" : "border-brand/50"}`}>
            <div className="flex justify-between">
              <span>{new Date(r.submitted_at).toLocaleDateString()} · {r.weight != null ? r.weight : "—"}</span>
              {r.coach_seen ? <span className="text-xs opacity-50">seen</span>
                : <button onClick={() => seen(r.id)} className="min-h-[44px] rounded bg-brand px-3 py-1.5 text-xs text-brand-text">Mark seen</button>}
            </div>
            <CheckinAnswers answers={r.answers} />
            <CheckinPhotos paths={r.photo_urls} urls={urls} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// Generic answers renderer — works for any tenant's question set without config
// coupling (ids are prettified; composite values formatted).
function CheckinAnswers({ answers }) {
  if (!answers || Object.keys(answers).length === 0) return null;
  const pretty = (k) => k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const fmt = (v) => {
    if (v == null || v === "") return null;
    if (typeof v === "object") {
      if ("choice" in v) return v.detail ? `${v.choice} — ${v.detail}` : v.choice;
      if ("done" in v || "planned" in v) return `${v.done ?? "?"} of ${v.planned ?? "?"}`;
      return JSON.stringify(v);
    }
    return String(v);
  };
  return (
    <ul className="mt-1 space-y-0.5 text-xs opacity-75">
      {Object.entries(answers).map(([k, v]) => {
        const text = fmt(v);
        return text ? <li key={k}><span className="opacity-60">{pretty(k)}:</span> {text}</li> : null;
      })}
    </ul>
  );
}

// Optional tool shown in the Program tab's empty state — generates a training split
// client-side (src/lib/programGen.js, the same movement-selection logic the intake flow
// uses) and, once the coach is happy with the preview, creates + assigns it via the same
// createProgram/assignProgram helpers the standalone Programs library page uses. After
// assignment the client's Program tab shows the normal assigned view, editable via the
// same ProgramBuilder as any other program.
function ProgramGenerator({ clientId, tenantId, onAssigned }) {
  const [opts, setOpts] = useState({
    daysPerWeek: 4, experience: "beginner", equipment: "full_gym", injuriesText: "",
  });
  const [draft, setDraft] = useState(null); // { days, frequency, rationale, substitutions } — not yet persisted
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getClientIntakes(clientId).then((intakes) => {
      if (cancelled || prefilled) return;
      const a = intakes?.[0]?.answers;
      if (!a) return;
      setOpts({
        daysPerWeek: Number(a.days_per_week) || 4,
        experience: a.experience || "beginner",
        equipment: a.equipment || "full_gym",
        injuriesText: Array.isArray(a.injuries) ? a.injuries.filter((x) => x !== "none").join(", ") : "",
      });
      setPrefilled(true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [clientId, prefilled]);

  function generate() {
    setErr(null);
    const injuries = opts.injuriesText.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const plan = generateTrainingProgram({
      daysPerWeek: opts.daysPerWeek, experience: opts.experience, equipment: opts.equipment, injuries,
    });
    setDraft(plan);
  }

  async function assign() {
    setErr(null); setBusy(true);
    try {
      const profile = await getClientProfile(clientId);
      const name = `${profile?.display_name ?? "Client"} — Generated ${new Date().toLocaleDateString()}`;
      const program = await createProgram({ tenantId, name, structure: { days: draft.days } });
      await assignProgram({ programId: program.id, clientIds: [clientId], tenantId });
      setDraft(null);
      await onAssigned();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  if (draft) {
    return (
      <div className="mt-3 rounded-lg border border-ink/10 p-3">
        <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Generated program — preview</h3>
        <p className="mt-1 text-xs opacity-60">
          {draft.frequency.training_days} training / {draft.frequency.rest_days} rest days per week.
        </p>
        <ul className="mt-2 space-y-1 text-sm">
          {draft.days.map((d) => (
            <li key={d.day_id} className="flex items-center justify-between rounded-md border border-ink/10 px-2 py-1.5">
              <span className={d.kind === "rest" ? "opacity-50" : ""}>{d.label}</span>
              <span className="text-xs opacity-50">
                {d.kind === "rest" ? "Rest" : `${d.groups.flatMap((g) => g.exercises).length} exercises`}
              </span>
            </li>
          ))}
        </ul>
        {draft.substitutions.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 rounded-lg border border-brand/30 bg-brand/5 p-2 pl-6 text-xs">
            {draft.substitutions.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        )}
        <p className="mt-2 text-xs opacity-50">{draft.rationale}</p>
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button disabled={busy} onClick={assign} className="rounded-md bg-brand px-3 py-1.5 text-sm text-brand-text disabled:opacity-50">Assign to client</button>
          <button disabled={busy} onClick={generate} className="rounded-md border border-ink/15 px-3 py-1.5 text-sm">Regenerate</button>
          <button disabled={busy} onClick={() => setDraft(null)} className="rounded-md px-3 py-1.5 text-sm opacity-60">Cancel</button>
        </div>
        <p className="mt-2 text-xs opacity-50">Exercise names/sets are editable after assigning, same as any program.</p>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-ink/10 p-3">
      <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Generate a training program</h3>
      <p className="mt-1 text-xs opacity-50">
        Optional — you can still assign an existing template from the Programs library instead.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="text-xs">
          <span className="opacity-60">Days per week</span>
          <select value={opts.daysPerWeek} onChange={(e) => setOpts({ ...opts, daysPerWeek: Number(e.target.value) })}
            className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm">
            {[3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} days</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="opacity-60">Experience</span>
          <select value={opts.experience} onChange={(e) => setOpts({ ...opts, experience: e.target.value })}
            className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm">
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
          </select>
        </label>
        <label className="text-xs">
          <span className="opacity-60">Equipment access</span>
          <select value={opts.equipment} onChange={(e) => setOpts({ ...opts, equipment: e.target.value })}
            className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm">
            <option value="full_gym">Full gym</option>
            <option value="home_basic">Home (basic)</option>
            <option value="bodyweight">Bodyweight only</option>
          </select>
        </label>
        <label className="text-xs">
          <span className="opacity-60">Injuries (comma-separated, optional)</span>
          <input value={opts.injuriesText} onChange={(e) => setOpts({ ...opts, injuriesText: e.target.value })}
            placeholder="e.g. knee, lower_back" className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" />
        </label>
      </div>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      <button disabled={busy} onClick={generate} className="mt-3 rounded-md bg-brand px-3 py-1.5 text-sm text-brand-text disabled:opacity-50">Generate program</button>
    </div>
  );
}

// The client's active program, editable in place. Collapsed = the one-line summary;
// expanded = the SAME ProgramBuilder the Programs page uses, saving to the same
// program record (so its mid-cycle warning applies — this client is on it by definition).
function Program({ clientId, tenantId }) {
  const [data, setData] = useState(undefined);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = useCallback(
    () => getClientProgram(clientId)
      .then((d) => { setFailed(false); setData(d); })
      .catch(() => { setFailed(true); setData(null); }),
    [clientId],
  );
  useEffect(() => { setEditing(false); load(); }, [load]);
  if (data === undefined) return <Muted>Loading…</Muted>;
  if (failed) {
    return <LoadFail>Could not load this client’s program — failed read, not “no program assigned.”</LoadFail>;
  }
  if (!data?.program) {
    return (
      <div>
        <Muted>No active program assigned.</Muted>
        <ProgramGenerator clientId={clientId} tenantId={tenantId} onAssigned={load} />
      </div>
    );
  }

  if (editing) {
    return (
      <ProgramBuilder
        program={data.program}
        tenantId={tenantId}
        onDone={async () => { setEditing(false); await load(); }}
      />
    );
  }

  const days = Array.isArray(data.program.structure?.days) ? data.program.structure.days : [];
  const nDays = days.length;
  return (
    <div className="space-y-3">
      <button onClick={() => setEditing(true)}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-ink/10 px-3 py-2.5 text-left text-sm transition hover:bg-ink/[0.03]">
        <span>
          <span className="font-medium">{data.program.name}</span>
          <span className="ml-2 text-xs opacity-50">{nDays} day{nDays === 1 ? "" : "s"} · on day {data.assignment.current_day_index + 1}</span>
        </span>
        <span className="shrink-0 text-xs opacity-60">Edit program ▸</span>
      </button>
      {days.map((day) => {
        const exercises = (day.groups ?? []).flatMap((g) => g.exercises ?? []);
        return (
          <div key={day.day_id} className="rounded-lg border border-ink/10 p-3">
            <p className="text-sm font-medium">{day.label || "Training day"}</p>
            <ul className="mt-2 space-y-2">
              {exercises.map((ex) => (
                <li key={ex.exercise_id} className="rounded-lg bg-paper/60 p-2">
                  <p className="text-sm">{ex.name}</p>
                  {ex.demo_media_url ? (
                    <DemoDisclosure url={ex.demo_media_url} label={`${ex.name} demo`} />
                  ) : (
                    <p className="mt-1 text-[11px] opacity-45">No demo attached</p>
                  )}
                </li>
              ))}
              {exercises.length === 0 && <li className="text-xs opacity-50">No exercises on this day.</li>}
            </ul>
          </div>
        );
      })}
      <ScheduleAdjustments clientId={clientId} days={days} />
    </div>
  );
}

// Client-initiated day-swap events, newest first — v1 per-client log only (no
// roster-wide rollup; decision 6 in the plan). "not given" renders visually
// distinct from a chip: it is a fact about the flow, not a shame marker on the
// client (twin-facts rule).
function ScheduleAdjustments({ clientId, days }) {
  const [rows, setRows] = useState(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setRows(undefined);
    setFailed(false);
    getClientScheduleAdjustments(clientId)
      .then((r) => { setFailed(false); setRows(r); })
      .catch(() => { setFailed(true); setRows([]); });
  }, [clientId]);

  if (rows === undefined) return null; // don't block the program view on this
  if (failed) {
    return (
      <p className="mt-2 rounded-lg border border-dashed border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
        Could not load schedule adjustments — failed read, not "none made."
      </p>
    );
  }
  if (rows.length === 0) return null; // nothing to report yet — not a gap, just no activity

  const dayLabelById = Object.fromEntries(days.map((d) => [d.day_id, d.label || "Training day"]));

  return (
    <div className="mt-4">
      <h3 className="section-title">Schedule adjustments</h3>
      <ul className="mt-2 space-y-1.5">
        {rows.map((r) => {
          const summary = summarizeAdjustment({
            oldOrder: Array.isArray(r.old_order) ? r.old_order : [],
            newOrder: Array.isArray(r.new_order) ? r.new_order : [],
            dayLabelById,
          });
          const when = r.created_at ? new Date(r.created_at).toLocaleDateString() : "";
          return (
            <li key={r.id} className="rounded-lg border border-ink/10 px-3 py-2 text-xs">
              <span className="opacity-80">
                {summary
                  ? `Moved ${summary.movedLabel} — ${summary.pulledLabel} moved to today`
                  : "Reordered upcoming days"}
              </span>
              <span className="ml-2 opacity-50">· {when}</span>
              {r.reason_tag ? (
                <span className="ml-2 rounded-full bg-ink/5 px-2 py-0.5 font-medium">
                  {reasonChipLabel(r.reason_tag)}
                </span>
              ) : (
                <span className="ml-2 italic opacity-45">reason: not given</span>
              )}
              {r.reason_note && <p className="mt-1 opacity-70">&ldquo;{r.reason_note}&rdquo;</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// A logged set is either strength (weight x reps) or cardio (duration/distance/RPE) —
// distinguished by which fields are actually populated, since both share workout_logs.
function formatSetActual(l) {
  const isCardio = l.duration_seconds != null || l.distance_meters != null;
  if (!isCardio) return `${l.weight ?? "–"}×${l.reps ?? "–"}${l.done ? "" : "?"}`;
  const parts = [];
  if (l.duration_seconds != null) parts.push(`${Math.round(l.duration_seconds / 60)} min`);
  if (l.distance_meters != null) parts.push(`${(l.distance_meters / 1000).toFixed(2)} km`);
  if (l.rpe != null) parts.push(`RPE ${l.rpe}`);
  return (parts.join(", ") || "logged") + (l.done ? "" : "?");
}

// Execution review: what the client actually lifted, session by session. Day and
// exercise names resolve from each session's own program (via its assignment), so
// history reads correctly across cycles; ids edited out of a program fall back.
function Workouts({ clientId }) {
  const [data, setData] = useState(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    setData(undefined);
    getClientWorkouts(clientId)
      .then((d) => { setFailed(false); setData(d); })
      .catch(() => { setFailed(true); setData(null); });
  }, [clientId]);
  if (data === undefined) return <Muted>Loading…</Muted>;
  if (failed) return <LoadFail>Could not load workouts — failed read, not “none logged.”</LoadFail>;
  if (!data || data.sessions.length === 0) return <Muted>No workouts logged yet.</Muted>;

  return (
    <ul className="space-y-2">
      {data.sessions.map((s) => {
        const program = data.programByAssignment[s.assignment_id];
        const days = Array.isArray(program?.structure?.days) ? program.structure.days : [];
        const day = days.find((d) => d.day_id === s.day_id);
        const exName = Object.fromEntries(days.flatMap((d) => (d.groups ?? []).flatMap((g) => (g.exercises ?? []).map((ex) => [ex.exercise_id, ex.name]))));
        const logs = [...(s.workout_logs ?? [])].sort((a, b) => a.set_index - b.set_index);
        const byEx = {};
        for (const l of logs) (byEx[l.exercise_id] ??= []).push(l);
        return (
          <li key={s.id} className="rounded-lg border border-ink/10 p-3 text-sm">
            <div className="flex justify-between">
              <span className="font-medium">{day?.label ?? "Workout"}</span>
              <span className="text-xs opacity-60">
                {new Date(s.session_date + "T00:00:00").toLocaleDateString()}
                {s.status === "in_progress" && <span className="ml-2 rounded-full bg-brand/10 px-2 py-0.5 text-ink">in progress</span>}
              </span>
            </div>
            {program?.name && <p className="text-xs opacity-50">{program.name}</p>}
            <ul className="mt-1 space-y-0.5 text-xs opacity-80">
              {Object.entries(byEx).map(([exId, sets]) => (
                <li key={exId}>
                  {exName[exId] ?? "(removed exercise)"} — {sets.map(formatSetActual).join(", ")}
                </li>
              ))}
              {logs.length === 0 && <li className="opacity-50">No sets logged.</li>}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

// ── Intake: coach-facing display of the submitted consultation answers. Read-only.
// Question set is locked (mirrors src/pages/Intake.jsx); keys the generator consumes and
// the free-form fields both live in answers jsonb. Ordered + labelled for readability;
// any unexpected key still renders (prettified) so nothing is silently dropped.
const INTAKE_ORDER = [
  "goal", "equipment", "days_per_week", "experience", "injuries",
  "allergies", "medications", "meals_per_day", "cardio_regimen", "competition_history",
];
const INTAKE_LABELS = {
  goal: "Primary goal", equipment: "Equipment access", days_per_week: "Days able to train / week",
  experience: "Training experience", injuries: "Injury history / limitations",
  allergies: "Food sensitivities / allergies", medications: "Medical notes",
  meals_per_day: "Typical meals per day", cardio_regimen: "Current cardio regimen",
  competition_history: "Competition history",
};
const INTAKE_VALUE_LABELS = {
  goal: { fat_loss: "Lose fat", muscle_gain: "Build muscle", recomp: "Recomposition (both)", maintain: "Maintain / general health" },
  equipment: { full_gym: "Full gym access", home_basic: "Home setup (dumbbells, bands)", bodyweight: "Bodyweight only" },
  experience: { beginner: "Beginner (< 1 year)", intermediate: "Intermediate (1–3 years)", advanced: "Advanced (3+ years)" },
  injuries: { none: "None", knee: "Knee", shoulder: "Shoulder", lower_back: "Lower back", elbow: "Elbow", wrist: "Wrist" },
};
const prettyKey = (k) => k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
function intakeValueText(key, v) {
  if (v == null || v === "") return null;
  const map = INTAKE_VALUE_LABELS[key];
  if (Array.isArray(v)) return v.map((x) => map?.[x] ?? prettyKey(String(x))).join(", ") || null;
  if (typeof v === "object") return JSON.stringify(v);
  return map?.[v] ?? String(v);
}

function Intake({ clientId }) {
  const [rows, setRows] = useState(undefined);
  const [failed, setFailed] = useState(false);
  const [selId, setSelId] = useState(null);
  useEffect(() => {
    setFailed(false);
    setRows(undefined);
    getClientIntakes(clientId)
      .then((r) => { setFailed(false); setRows(r); setSelId(r[0]?.id ?? null); })
      .catch(() => { setFailed(true); setRows(null); });
  }, [clientId]);

  if (rows === undefined) return <Muted>Loading…</Muted>;
  if (failed) return <LoadFail>Could not load intake — failed read, not “no intake submitted.”</LoadFail>;
  if (rows.length === 0) return <Muted>No intake submitted yet. Use “Email intake form” above to send this client the questionnaire.</Muted>;

  const current = rows.find((r) => r.id === selId) ?? rows[0];
  const answers = current.answers ?? {};
  const orderedKeys = [...INTAKE_ORDER.filter((k) => k in answers), ...Object.keys(answers).filter((k) => !INTAKE_ORDER.includes(k))];
  // health_flags is an array of flag names (intake-submit, update_client_onboarding); older
  // rows may be an object keyed by flag. Object.keys on the array printed "0, 1".
  const hf = current.health_flags;
  const flagNames = Array.isArray(hf) ? hf : hf && typeof hf === "object" ? Object.keys(hf) : [];
  const flags = flagNames.length > 0 ? flagNames : null;

  return (
    <div>
      <p className="text-xs opacity-60">
        Submitted {current.submitted_at ? new Date(current.submitted_at).toLocaleString() : "—"}
        {answers.intake_kind === "screen" ? " · health screen + waiver" : ""}
      </p>
      {flags && (
        <p className="mt-2 rounded-md border border-brand/40 bg-brand/5 px-3 py-2 text-xs text-ink">
          Health flag on this intake — reviewed before programming: {flags.map((f) => prettyKey(String(f))).join(", ")}
        </p>
      )}
      <dl className="mt-3 divide-y divide-ink/10 rounded-lg border border-ink/10">
        {orderedKeys.map((k) => {
          const text = intakeValueText(k, answers[k]);
          if (text == null) return null;
          return (
            <div key={k} className="px-3 py-2">
              <dt className="text-xs uppercase tracking-wide opacity-50">{INTAKE_LABELS[k] ?? prettyKey(k)}</dt>
              <dd className="mt-0.5 text-sm whitespace-pre-wrap">{text}</dd>
            </div>
          );
        })}
      </dl>

      {rows.length > 1 && (
        <div className="mt-4">
          <p className="text-xs font-medium opacity-60">Submissions ({rows.length})</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {rows.map((r, i) => (
              <li key={r.id}>
                <button onClick={() => setSelId(r.id)}
                  className={`rounded-md px-2 py-1 text-xs ${r.id === current.id ? "bg-ink text-paper" : "border border-ink/15 hover:bg-ink/[0.03]"}`}>
                  {r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : "—"}{i === 0 ? " · latest" : ""}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Nutrition: upload one meal-plan PDF per client (replaces on re-upload). Stored in
// the private `resources` bucket; the client sees it on their own dashboard.
function Nutrition({ clientId, tenantId, clientName }) {
  const [plan, setPlan] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [pdfFailed, setPdfFailed] = useState(false);
  const load = useCallback(
    () => getMealPlan({ tenantId, clientId })
      .then((p) => { setPdfFailed(false); setPlan(p); })
      .catch(() => { setPdfFailed(true); setPlan(null); }),
    [tenantId, clientId],
  );
  useEffect(() => { load(); }, [load]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same filename
    if (!file) return;
    if (file.type !== "application/pdf") { setErr("Please choose a PDF file."); return; }
    if (file.size > MEAL_PLAN_MAX_BYTES) { setErr("That PDF is over 20 MB — please upload a smaller file."); return; }
    setErr(null); setBusy(true);
    try { await uploadMealPlan({ tenantId, clientId, file }); await load(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      {/* New-format structured plan (client_meal_plans) — only renders once one exists for
          this client. Coexists with the legacy generator below during the migration; no
          client sees both. */}
      <StructuredMealPlanReview clientId={clientId} clientName={clientName} />

      {/* Generated / structured plan (legacy meal_plans) */}
      <MealPlanGenerator clientId={clientId} tenantId={tenantId} />

      {/* Uploaded PDF (Wave 1) — kept alongside the generated plan */}
      <div className="border-t border-ink/10 pt-5">
        <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Meal plan PDF</h3>
        {plan === undefined ? <Muted>Loading…</Muted> : pdfFailed ? (
          <LoadFail>Could not read meal-plan PDF status — failed load, not “no PDF.”</LoadFail>
        ) : (
          <div className="mt-2">
            {plan ? (
              <div className="flex items-center justify-between rounded-lg border border-ink/10 p-3 text-sm">
                <span>
                  <span className="font-medium">Meal plan (PDF)</span>
                  <span className="block text-xs opacity-60">Uploaded {plan.uploadedAt ? new Date(plan.uploadedAt).toLocaleString() : "—"}</span>
                </span>
                <a href={plan.url} target="_blank" rel="noreferrer" className="rounded-md border border-ink/15 px-2 py-1 text-xs hover:bg-ink/[0.03]">View</a>
              </div>
            ) : (
              <Muted>No PDF uploaded.</Muted>
            )}
            <label className="mt-3 inline-block cursor-pointer rounded-md border border-ink/15 px-3 py-1.5 text-sm hover:bg-ink/[0.03]">
              {busy ? "Uploading…" : plan ? "Replace PDF" : "Upload PDF"}
              <input type="file" accept="application/pdf" onChange={onFile} disabled={busy} className="hidden" />
            </label>
            {err && <p className="mt-2 text-sm text-danger">{err}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// Review + release for the new-format structured plan. Renders nothing when this client has
// no client_meal_plans row. Release is never blocked by the warnings below;
// the screen informs, it does not decide.
function StructuredMealPlanReview({ clientId, clientName }) {
  const [plan, setPlan] = useState(undefined); // undefined=loading, null=none
  const [slots, setSlots] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    const record = await getStructuredPlanRecord(clientId).catch(() => null);
    setPlan(record);
    if (record) setSlots(await getPlanSlotsWithMeals(record.id).catch(() => []));
  }, [clientId]);
  useEffect(() => { load(); }, [load]);

  if (plan === undefined || plan === null) return null;

  async function onRelease() {
    setErr(null); setBusy(true);
    try { setPlan(await releaseStructuredPlan(plan.id)); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const totals = slots ? summarizePlanMacros(slots) : null;
  const distinctMeals = slots
    ? [...new Map(slots.flatMap((s) => [s.meal, s.fallbackMeal, ...s.swapOptions]).filter(Boolean).map((m) => [m.id, m])).values()]
    : [];
  const withPhoto = distinctMeals.filter((m) => m.photo_path).length;

  // Warnings are findings, not blockers — named plainly, never used to disable Release.
  const warnings = [];
  if (slots) {
    const fallbackCounts = new Map();
    for (const s of slots) {
      if (!s.fallbackMeal) continue;
      fallbackCounts.set(s.fallbackMeal.id, (fallbackCounts.get(s.fallbackMeal.id) ?? 0) + 1);
    }
    for (const [mealId, count] of fallbackCounts) {
      if (count > 1) {
        const name = distinctMeals.find((m) => m.id === mealId)?.name ?? "a meal";
        warnings.push(`Bad week repeats "${name}" at ${count} different meal slots.`);
      }
    }
    for (const s of slots) {
      if (!s.fallbackMeal || !s.meal?.kcal) continue;
      // Compare against what the slot actually serves in a good week (meal kcal ×
      // servings), not the meal's raw kcal — servings can scale a meal down (e.g. ¾
      // portion) specifically to hit target, and a fallback that ignores that (by design,
      // per D4) needs to be measured against the number it's actually replacing on screen.
      const servedKcal = Number(s.meal.kcal) * (Number(s.servings) || 1);
      const ratio = servedKcal > 0 ? Number(s.fallbackMeal.kcal) / servedKcal : 0;
      if (ratio >= 1.3) {
        warnings.push(
          `${s.slot_label ?? "A slot"}'s fallback ("${s.fallbackMeal.name}", ${s.fallbackMeal.kcal} kcal) is ${Math.round((ratio - 1) * 100)}% larger than the slot it replaces ("${s.meal.name}", ${Math.round(servedKcal)} kcal as served).`
        );
      }
    }
  }

  return (
    <div className="border-t border-ink/10 pt-5">
      <div className="flex items-center justify-between">
        <h3 className="section-title">Structured plan — {plan.title ?? "untitled"}</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs ${plan.status === "assigned" ? "bg-success/15 text-success" : "bg-brand/10 text-ink"}`}>{plan.status}</span>
      </div>

      {!slots ? (
        <Muted>Loading plan detail…</Muted>
      ) : (
        <div className="mt-2 space-y-2 text-sm">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-70">
            <span>Target {plan.target_calories ?? "—"} kcal · P {plan.target_protein_g ?? "—"} / F {plan.target_fat_g ?? "—"} / C {plan.target_carb_g ?? "—"}</span>
          </div>
          {totals && (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-ink/10 p-2">
                <div className="text-xs font-semibold opacity-60">Good week</div>
                <div className="text-sm">{totals.good.kcal} kcal · P {totals.good.protein_g} / F {totals.good.fat_g} / C {totals.good.carb_g}</div>
              </div>
              <div className="rounded-lg border border-ink/10 p-2">
                <div className="text-xs font-semibold opacity-60">Bad week</div>
                <div className="text-sm">
                  {totals.bad.kcal} kcal
                  {plan.target_calories != null && (
                    <span className={totals.bad.kcal > plan.target_calories ? "text-danger" : "text-success"}>
                      {" "}({totals.bad.kcal > plan.target_calories ? "+" : ""}{totals.bad.kcal - plan.target_calories} vs target)
                    </span>
                  )}
                  {" "}· P {totals.bad.protein_g} / F {totals.bad.fat_g} / C {totals.bad.carb_g}
                </div>
              </div>
            </div>
          )}
          <div className="text-xs opacity-60">
            Photo coverage: {withPhoto} of {distinctMeals.length} meals in this plan have a library photo.
            {withPhoto === 0 && distinctMeals.length > 0 && (
              <span className="mt-1 block text-ink opacity-80">
                None of these meals have photos yet — that is a meal-library gap, not a broken plan. Clients still see the meal name, macros, and bad-week fallback; plates say “No photo yet” until the library catches up.
              </span>
            )}
          </div>
          <div className="space-y-3">
            {(slots ?? []).map((s) => {
              const meal = s.meal;
              if (!meal) return null;
              const url = getMealPhotoUrl(meal.photo_path);
              return (
                <article key={s.id} className="overflow-hidden rounded-lg border border-ink/10">
                  {url ? (
                    <img src={url} alt={meal.photo_alt || meal.name} className="h-40 w-full object-cover" />
                  ) : (
                    <div className="flex h-10 items-center justify-center bg-ink/5 text-xs opacity-50">No photo yet</div>
                  )}
                  <div className="p-2">
                    <p className="text-[11px] uppercase tracking-wide opacity-50">{s.slot_label ?? `Meal ${s.slot_index + 1}`}</p>
                    <p className="text-sm font-medium">{meal.name}</p>
                  </div>
                </article>
              );
            })}
          </div>
          {warnings.length > 0 && (
            <ul className="list-disc space-y-1 rounded-lg border border-brand/30 bg-brand/5 p-2 pl-6 text-xs text-ink">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      <div className="mt-3">
        {plan.status === "draft" ? (
          <button disabled={busy} onClick={onRelease} className="btn-primary">
            {busy ? "Releasing…" : `Release to ${clientName ?? "client"}`}
          </button>
        ) : (
          <span className="text-xs opacity-50">{plan.status === "assigned" ? `Live since ${plan.assigned_at ? new Date(plan.assigned_at).toLocaleString() : "—"}.` : "Archived."}</span>
        )}
      </div>
    </div>
  );
}

// Deterministic meal-plan generator + editor. Coach picks goal/meals/diet, generates a
// draft from the client's profile macros, edits any field, then assigns it to the
// client's Nutrition tab. One plan per client (regenerating/saving replaces it).
function MealPlanGenerator({ clientId, tenantId }) {
  const [record, setRecord] = useState(undefined); // undefined=loading, null=none, object=saved row
  const [draft, setDraft] = useState(null);         // in-progress editable plan (not yet persisted)
  const [opts, setOpts] = useState({
    goal: "recomp",
    mealsPerDay: 4,
    calorieOverride: "",
    dietaryStyle: "omnivore",
    allergies: "",
    weeklyLossLb: "1.0",
    prepPhase: "off_season",
    division: "mens_physique",
    bodyFatPct: "",
    proteinPerKgLbm: String(PROTEIN_PER_KG_LBM_RANGE.default),
    fatPct: String(FAT_PCT_DEFAULT),
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [genFlags, setGenFlags] = useState([]);
  const [prefilled, setPrefilled] = useState(false);

  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(
    () => getMealPlanRecord(clientId)
      .then((r) => { setLoadFailed(false); setRecord(r); })
      .catch(() => { setLoadFailed(true); setRecord(null); }),
    [clientId],
  );
  useEffect(() => { load(); }, [load]);

  // Loaded once on mount so the Generate button can be disabled before any click, not just
  // on the throw inside generate(). undefined = loading, null = read failed, object = loaded.
  // Twin facts: a read failure is a system fact, missing metrics are a client fact — they
  // must not render as the same message.
  const [profile, setProfile] = useState(undefined);
  useEffect(() => {
    let cancelled = false;
    setProfile(undefined);
    getClientMacroInputs(clientId)
      .then((p) => { if (!cancelled) setProfile(p ?? null); })
      .catch(() => { if (!cancelled) setProfile(null); });
    return () => { cancelled = true; };
  }, [clientId]);

  // Prefill body-fat % from the client's own profile (a real, coach-maintained column) —
  // never invented, and still coach-editable here for a one-off "what if" calculation.
  useEffect(() => {
    if (prefilled || !profile) return;
    if (profile.body_fat_pct != null) setOpts((o) => ({ ...o, bodyFatPct: String(profile.body_fat_pct) }));
    setPrefilled(true);
  }, [profile, prefilled]);

  const profileLoading = profile === undefined;
  const profileReadFailed = profile === null;
  const missingMetrics = profile
    ? missingBodyMetrics({
      sex: profile.sex, age: profile.age, heightCm: profile.height_cm,
      weightKg: profile.weight_kg, activity: profile.activity_level,
    })
    : [];
  const metricLabel = (m) => ({
    sex: "Sex", age: "Age", height_cm: "Height", weight_kg: "Weight", activity_level: "Activity level",
  }[m] ?? m);

  async function generate() {
    setErr(null); setBusy(true); setGenFlags([]);
    try {
      const freshProfile = await getClientMacroInputs(clientId);
      if (classificationOf(freshProfile) === "unclassified") {
        throw new Error("This client isn't classified yet (lifestyle or prep) — set it on their Profile tab before generating. Nothing is defaulted.");
      }
      const plan = generateMealPlan({ profile: freshProfile, ...opts });
      setDraft(plan);
      setGenFlags(plan._meta?.flags ?? []);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function save(status) {
    setErr(null); setBusy(true);
    try {
      const saved = await upsertMealPlan({ tenantId, clientId, plan: draft, status });
      setRecord(saved); setDraft(null);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  if (record === undefined) return <Muted>Loading…</Muted>;
  if (loadFailed) {
    return <LoadFail>Could not load the meal plan record — failed read, not “no plan yet.”</LoadFail>;
  }

  // Editing mode: an in-progress draft (freshly generated or opened from a saved row).
  if (draft) {
    return (
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Generated plan — editing</h3>
        <MealPlanEditor plan={draft} onChange={setDraft} />
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button disabled={busy} onClick={() => save("assigned")} className="rounded-md bg-brand px-3 py-1.5 text-sm text-brand-text disabled:opacity-50">Assign to client</button>
          <button disabled={busy} onClick={() => save("draft")} className="rounded-md border border-ink/15 px-3 py-1.5 text-sm">Save draft</button>
          <button disabled={busy} onClick={generate} className="rounded-md border border-ink/15 px-3 py-1.5 text-sm">Regenerate</button>
          <button disabled={busy} onClick={() => setDraft(null)} className="rounded-md px-3 py-1.5 text-sm opacity-60">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Generated plan</h3>

      {record ? (
        <div className="mt-2 rounded-lg border border-ink/10 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium capitalize">{record.title ?? "Meal plan"}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${record.status === "assigned" ? "bg-success/15 text-success" : "bg-brand/10 text-ink"}`}>{record.status}</span>
          </div>
          <p className="mt-1 text-xs opacity-60">{record.calories} kcal · P {record.protein_g} / F {record.fat_g} / C {record.carb_g} · {record.meals?.length ?? 0} meals</p>
          <button onClick={() => setDraft(record)} className="mt-2 rounded-md border border-ink/15 px-2 py-1 text-xs hover:bg-ink/[0.03]">Edit / re-assign</button>
        </div>
      ) : (
        <Muted>No generated plan yet.</Muted>
      )}

      {/* Prep phase / division — always visible, drives both the macro calculator below
          and (peak week only) the separate day-by-day protocol panel. */}
      <div className="mt-3 grid gap-2 rounded-lg border border-ink/10 p-3 sm:grid-cols-2">
        <label className="text-xs">
          <span className="opacity-60">Prep phase</span>
          <select value={opts.prepPhase} onChange={(e) => setOpts({ ...opts, prepPhase: e.target.value })} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm">
            <option value="off_season">Off-season</option>
            <option value="contest_prep">Contest prep</option>
            <option value="peak_week">Peak week</option>
          </select>
        </label>
        <label className="text-xs">
          <span className="opacity-60">Division</span>
          <select value={opts.division} onChange={(e) => setOpts({ ...opts, division: e.target.value })} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm">
            {DIVISIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </label>
      </div>

      {opts.prepPhase === "peak_week" ? (
        <PeakWeekPanel clientId={clientId} tenantId={tenantId} division={opts.division} />
      ) : (
        <>
          {/* Generate controls */}
          <div className="mt-3 grid gap-2 rounded-lg border border-ink/10 p-3 sm:grid-cols-2">
            <label className="text-xs">
              <span className="opacity-60">Goal</span>
              <select value={opts.goal} onChange={(e) => setOpts({ ...opts, goal: e.target.value })} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm">
                <option value="fat_loss">Fat loss</option>
                <option value="recomp">Recomp</option>
                <option value="maintain">Maintain</option>
                <option value="muscle_gain">Muscle gain</option>
              </select>
            </label>
            <div className="text-xs">
              <span className="opacity-60">Classification</span>
              <p className="mt-1 rounded-md border border-ink/15 bg-ink/[0.02] px-2 py-1.5">
                {classificationLabel(profile)}
                <span className="opacity-50"> — follows this client's Profile tab, edit it there.</span>
              </p>
            </div>
            <label className="text-xs sm:col-span-2">
              <span className="opacity-60">How much weight should they drop weekly? (lb)</span>
              <select
                value={opts.weeklyLossLb}
                onChange={(e) => setOpts({ ...opts, weeklyLossLb: e.target.value })}
                className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm"
              >
                {(classificationOf(profile) === "prep"
                  ? ["1.0", "1.5", "2.0", "2.5", "3.0", "3.5", "4.0"]
                  : ["0.5", "1.0", "1.5", "2.0", "2.5", "3.0"]
                ).map((v) => (
                  <option key={v} value={v}>{v} lb/wk</option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] opacity-50">
                Coach sets the rate. Goal weight never blocks.
              </span>
            </label>
            <label className="text-xs">
              <span className="opacity-60">Body fat % (optional — no bloodwork)</span>
              <input type="number" min="1" max="59" step="0.5" value={opts.bodyFatPct}
                onChange={(e) => setOpts({ ...opts, bodyFatPct: e.target.value })} placeholder="visual/caliper estimate"
                className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" />
              <span className="mt-1 block text-[11px] opacity-50">
                {opts.bodyFatPct ? "Protein will be dosed off lean body mass." : "Leave blank to dose protein off bodyweight instead."}
              </span>
            </label>
            {opts.bodyFatPct && (
              <label className="text-xs">
                <span className="opacity-60">Protein (g/kg lean mass)</span>
                <select value={opts.proteinPerKgLbm} onChange={(e) => setOpts({ ...opts, proteinPerKgLbm: e.target.value })} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm">
                  {["2.3", "2.6", "2.9", "3.1"].map((v) => <option key={v} value={v}>{v} g/kg LBM</option>)}
                </select>
              </label>
            )}
            <label className="text-xs">
              <span className="opacity-60">Fat % of calories (floor 15%)</span>
              <input type="number" min="15" max="35" step="1" value={opts.fatPct}
                onChange={(e) => setOpts({ ...opts, fatPct: e.target.value })}
                className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs">
              <span className="opacity-60">Meals / day</span>
              <select value={opts.mealsPerDay} onChange={(e) => setOpts({ ...opts, mealsPerDay: Number(e.target.value) })} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm">
                {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="text-xs">
              <span className="opacity-60">Diet</span>
              <select value={opts.dietaryStyle} onChange={(e) => setOpts({ ...opts, dietaryStyle: e.target.value })} className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm">
                <option value="omnivore">Omnivore</option>
                <option value="pescatarian">Pescatarian</option>
                <option value="vegetarian">Vegetarian</option>
                <option value="vegan">Vegan</option>
              </select>
            </label>
            <label className="text-xs">
              <span className="opacity-60">Calorie override (optional)</span>
              <input type="number" value={opts.calorieOverride} onChange={(e) => setOpts({ ...opts, calorieOverride: e.target.value })} placeholder="auto from profile"
                className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs sm:col-span-2">
              <span className="opacity-60">Allergies / exclusions</span>
              <input value={opts.allergies} onChange={(e) => setOpts({ ...opts, allergies: e.target.value })} placeholder="e.g. dairy, nuts, gluten"
                className="mt-1 w-full rounded-md border border-ink/15 px-2 py-1.5 text-sm" />
            </label>
          </div>
          {profileReadFailed && (
            <p className="mt-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
              Could not load this client's profile — that's a failed read, not missing data. Reopen the client and try again.
            </p>
          )}
          {!profileLoading && !profileReadFailed && missingMetrics.length > 0 && (
            <p className="mt-2 rounded-md border border-brand/30 bg-brand/5 px-3 py-2 text-xs">
              Missing {missingMetrics.map(metricLabel).join(", ")} — add {missingMetrics.length > 1 ? "these" : "this"} on the client's Profile before generating. Nothing will be invented to fill the gap.
            </p>
          )}
          {!profileLoading && !profileReadFailed && missingMetrics.length === 0 && classificationOf(profile) === "unclassified" && (
            <p className="mt-2 rounded-md border border-brand/30 bg-brand/5 px-3 py-2 text-xs">
              This client isn't classified (lifestyle or prep) yet — set it on their Profile tab before generating. Not defaulted to lifestyle.
            </p>
          )}
          {err && <p className="mt-2 text-sm text-danger">{err}</p>}
          {genFlags.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 rounded-lg border border-brand/30 bg-brand/5 p-2 pl-6 text-xs">
              {genFlags.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}
          <button
            disabled={busy || profileLoading || profileReadFailed || missingMetrics.length > 0 || classificationOf(profile) === "unclassified"}
            onClick={generate}
            className="mt-3 rounded-md bg-brand px-3 py-1.5 text-sm text-brand-text disabled:opacity-50"
          >
            {busy ? "Calculating…" : profileLoading ? "Loading…" : "Calculate"}
          </button>
          <p className="mt-2 text-xs opacity-50">
            Uses current weight + the fields above. Goal weight never blocks. Adjust anything and hit Calculate again — review before assigning.
          </p>
        </>
      )}
    </div>
  );
}

// Peak-week day-by-day protocol — a different shape of output from the macro calculator
// above (a multi-day plan, not a single target), so it isn't forced into the meal_plans
// row. Requires the client's show_date; reports the gap rather than guessing one.
function PeakWeekPanel({ clientId, tenantId, division }) {
  const { user } = useAuth();
  const [protocol, setProtocol] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);

  async function calculate() {
    setErr(null); setBusy(true); setSaved(false);
    try {
      const profile = await getClientMacroInputs(clientId);
      const result = generatePeakWeekProtocol({
        sex: profile?.sex, age: profile?.age, heightCm: profile?.height_cm, weightKg: profile?.weight_kg,
        activity: profile?.activity_level, division, showDate: profile?.show_date,
      });
      setProtocol(result);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function saveNote() {
    if (!protocol || protocol.held) return;
    setBusy(true);
    try {
      const lines = [
        `Peak week protocol — ${protocol.days_out} day(s) out, ${protocol.division_posture === "front" ? "front-load (conservative)" : "back-load (aggressive)"} posture.`,
        ...protocol.days.map((d) => `${d.label} (${d.phase}): ${d.calories} kcal · P ${d.protein_g} / F ${d.fat_g} / C ${d.carb_g}g — ${d.guidance}`),
        `Safety: ${protocol.safety.join(" ")}`,
      ];
      await addClientNote({ tenantId, clientId, userId: user?.id, body: lines.join("\n") });
      setSaved(true);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="mt-3 rounded-lg border border-ink/10 p-3">
      <h3 className="text-xs font-medium uppercase tracking-wide opacity-50">Peak week protocol</h3>
      <p className="mt-1 text-xs opacity-50">Natural competitor. No bloodwork. Built off show_date on file.</p>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}

      {protocol?.held && (
        <p className="mt-3 rounded-md border border-brand/40 bg-brand/5 px-3 py-2 text-xs text-ink">{protocol.message}</p>
      )}

      {protocol && !protocol.held && (
        <div className="mt-3 space-y-2">
          <ul className="space-y-1.5">
            {protocol.days.map((d, i) => (
              <li key={i} className="rounded-md border border-ink/10 p-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{d.label} — {d.phase}</span>
                  <span className="text-xs opacity-60">{d.calories} kcal · P {d.protein_g} / F {d.fat_g} / C {d.carb_g}</span>
                </div>
                <p className="mt-1 text-xs opacity-70">{d.guidance}</p>
              </li>
            ))}
          </ul>
          <ul className="list-disc space-y-1 rounded-lg border border-danger/30 bg-danger/5 p-2 pl-6 text-xs">
            {protocol.safety.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
          <p className="text-xs opacity-50">{protocol.note}</p>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={saveNote} className="rounded-md bg-brand px-3 py-1.5 text-sm text-brand-text disabled:opacity-50">
              {saved ? "Saved to client notes ✓" : "Save as client note"}
            </button>
          </div>
        </div>
      )}

      <button disabled={busy} onClick={calculate} className="mt-3 rounded-md border border-ink/15 px-3 py-1.5 text-sm disabled:opacity-50">
        {busy ? "Calculating…" : "Calculate protocol"}
      </button>
    </div>
  );
}

function Messages({ clientId, tenantId }) {
  const [rows, setRows] = useState([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [loadState, setLoadState] = useState("loading"); // loading | ready | failed

  const load = useCallback(async () => {
    setLoadState("loading");
    setErr(null);
    try {
      setRows(await getClientMessages(clientId));
      setLoadState("ready");
    } catch (e) {
      setRows([]);
      setLoadState("failed");
      setErr(e.message || String(e));
    }
  }, [clientId]);
  useEffect(() => { load(); }, [load]);

  async function send(e) {
    e.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const clean = body.trim();
      await sendCoachMessage({ clientId, tenantId, body: clean });
      recordActivity({
        tenantId,
        clientId,
        template: "coach_message_sent",
        detail: { summary: clean.slice(0, 120) },
      }).catch((activityErr) => console.error("activity: coach message was not recorded", activityErr));
      setBody("");
      await load();
    } catch (e2) {
      // Keep the draft — failed send must not erase what the coach typed.
      setErr(e2.message || String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="space-y-2">
        {loadState === "loading" && <p className="text-sm opacity-50">Loading messages…</p>}
        {loadState === "failed" && (
          <p className="rounded-xl border border-dashed border-ink/20 p-3 text-sm text-danger">
            Could not load messages. {err}
          </p>
        )}
        {loadState === "ready" && rows.length === 0 && (
          <p className="text-sm opacity-50">No messages in this thread yet.</p>
        )}
        {loadState === "ready" && rows.map((m) => (
          <div key={m.id} className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${m.sender_role === "coach" ? "ml-auto bg-ink text-paper" : "bg-ink/5"}`}>
            {m.body}
          </div>
        ))}
      </div>
      {err && loadState === "ready" && (
        <p className="mt-2 text-sm text-danger" role="alert">{err}</p>
      )}
      <form onSubmit={send} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide opacity-60">
          Message
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Message this client…"
            aria-label="Message this client"
            disabled={busy || loadState === "failed"}
            className="mt-1 w-full rounded-xl border border-ink/15 px-3 py-2 text-sm font-normal normal-case tracking-normal opacity-100 disabled:opacity-50"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !body.trim() || loadState === "failed"}
          className="btn-primary min-h-[44px] px-4 disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  );
}

// Intake invite: creates the tokenized intake_forms row (14-day expiry) and either puts
// the /intake link on the clipboard or opens the coach's mail client with it pre-filled.
//
// The old single button was labelled "Send intake link" but only ever copied — it sent
// nothing. A label that overstates what a button does is worse than a plain one, because
// the coach walks away believing the client was contacted. Split into two honest actions.
//
// Each click mints a FRESH token (a new intake_forms row), so an older copied link is
// superseded. Copy or email, not both, for the same request.
function IntakeInviteButton({ client, tenantId }) {
  const [state, setState] = useState(null); // null | "copied" | "opened" | error text
  const flash = (s) => { setState(s); setTimeout(() => setState(null), 2500); };

  async function copyLink() {
    try {
      const link = await createIntakeInvite({ tenantId, clientId: client.id });
      await navigator.clipboard.writeText(link);
      flash("copied");
    } catch (e) { setState(e.message); }
  }

  // Short path for a client who is already training: health screen + waiver only, no
  // program rebuild. Paste it into a message; it opens straight into question one.
  async function copyScreenLink() {
    try {
      const link = await createScreenInvite({ tenantId, clientId: client.id });
      await navigator.clipboard.writeText(link);
      flash("screen");
    } catch (e) { setState(e.message); }
  }

  async function emailLink() {
    try {
      const link = await createIntakeInvite({ tenantId, clientId: client.id });
      const { subject, body } = intakeInviteEmail({ displayName: client.display_name, link });
      openMailClient(buildMailto({ to: client.email, subject, body }));
      flash("opened");
    } catch (e) { setState(e.message); }
  }

  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <button onClick={copyLink} className="rounded-md border border-ink/15 px-2 py-1 hover:bg-ink/[0.03]">
        {state === "copied" ? "Intake link copied ✓" : "Copy intake link"}
      </button>
      {/* No email address on the record → nothing to address the message to. */}
      {client.email && (
        <button onClick={emailLink} className="rounded-md border border-ink/15 px-2 py-1 hover:bg-ink/[0.03]">
          {state === "opened" ? "Opening your mail app…" : "Email intake form"}
        </button>
      )}
      <button onClick={copyScreenLink} className="rounded-md border border-ink/15 px-2 py-1 hover:bg-ink/[0.03]">
        {state === "screen" ? "Screen + waiver link copied ✓" : "Copy health screen + waiver link"}
      </button>
      {state && state !== "copied" && state !== "opened" && state !== "screen" && <span className="ml-2 text-danger">{state}</span>}
    </p>
  );
}

// CoachTabs now lives in components/CoachTabs.jsx so the coach home can use it without a
// page importing a page. Re-exported here because seven pages already import it from this
// module; the re-export keeps those imports valid.
export { CoachTabs } from "../components/CoachTabs";

// Generate a single-use account-claim link tied to this client record. The invitee opens
// it, magic-link signs in, and claim_client_invite() links them + mints role='client' —
// the explicit path that avoids the no-profile lockout. Re-clicking rotates the token
// (re-send / expiry recovery).
//
// Two ways out, same mint. "Copy invite link" is unchanged — it works and it is in use.
// "Email invite" mints the link and hands the finished message to the coach's own mail
// client, addressed to the client's stored email; the coach presses send. Nothing is sent
// from the app, so the message arrives from the coach's real address and replies land in
// the coach's real inbox — no sending domain, no SPF/DKIM, and correct on a white-label
// tenant where the sender must be the coach and not us.
//
// Both actions rotate the token (that is createClientInvite's existing behaviour), so an
// invite that was copied a moment ago stops working once a new one is minted. One action
// per send.
function PingPushButton({ clientId }) {
  const [state, setState] = useState("idle");
  const [note, setNote] = useState("");
  async function ping() {
    setNote("");
    setState("busy");
    try {
      const res = await sendClientNudge(clientId, "message");
      if (res?.sent) {
        setState("sent");
        setNote("Ping sent.");
      } else {
        setState("idle");
        const why = res?.reason || res?.results?.push || "not sent";
        setNote(
          why === "notifications off" || why === "skipped"
            ? "They have not turned push on yet."
            : String(why),
        );
      }
    } catch (e) {
      setState("idle");
      setNote(e.message || "Ping failed.");
    }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs">
      <button type="button" onClick={ping} disabled={state === "busy"}
        className="rounded-md border border-ink/15 px-2 py-1 hover:bg-ink/[0.03]">
        {state === "busy" ? "Sending…" : state === "sent" ? "Ping sent" : "Ping phone"}
      </button>
      {note && <span className="opacity-60">{note}</span>}
    </span>
  );
}

// Slice 3 — one Release button with the checklist as it stands (✓ Program draft (5 days) ·
// ✓ Nutrition (21 meals) · ✓ Email · ✗ Health screen flagged). The database owns every rule:
// release_checklist() renders, release_client() refuses naming the first missing item and
// writes nothing on refusal, or publishes + assigns (or records the D6 choice) + mints the
// invite in one transaction. Never silently partial end to end: the sequence in
// lib/releaseChecklist.js runRelease() pre-creates the (inert, idempotent) auth account
// FIRST via client-invite {account_only}, and only then calls the RPC — so a failure at
// either step means nothing was released. The invite goes out through the coach's own mail
// client (lib/mailto.js doctrine); if that fails the link is shown here with a copy action.
function ReleasePanel({ client, onReleased }) {
  // undefined = loading, null = read FAILED, object = the checklist
  const [chk, setChk] = useState(undefined);
  const [noNutrition, setNoNutrition] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { ok, text, claimLink? }
  const load = useCallback(() => {
    setChk(undefined);
    getReleaseChecklist(client.id).then(setChk).catch(() => setChk(null));
  }, [client.id]);
  useEffect(() => { load(); }, [load]);

  const lines = checklistLines(chk, { noNutrition });
  const ready = isReadyToRelease(chk, { noNutrition });
  const claimed = chk?.invite_state === "claimed";
  // Already fully released and in the app: the panel says so and stays out of the way.
  const done = chk && chk.program?.state === "live" && chk.nutrition?.ok && claimed;

  async function release() {
    setBusy(true); setNote(null);
    const r = await runRelease(
      {
        prepareAccount: prepareClientAccount,
        release: releaseClient,
        openInvite: async ({ to, displayName, link }) => {
          const { subject, body } = accountInviteEmail({ displayName, link });
          openMailClient(buildMailto({ to, subject, body }));
        },
      },
      { clientId: client.id, email: client.email, displayName: client.display_name, alreadyClaimed: claimed, noNutrition, buildLink: claimLinkFromPath },
    );
    setNote({ ok: r.ok, text: r.message, claimLink: r.ok ? r.claimLink : null });
    setBusy(false);
    if (r.ok) { onReleased?.(); load(); }
  }

  if (done) {
    return <p className="mt-2 text-xs opacity-60">Released · program live · {chk.nutrition.detail.toLowerCase()} · in the app</p>;
  }
  return (
    <div className="mt-3 rounded-xl border border-ink/10 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ul className="space-y-0.5 text-xs">
          {chk === undefined && <li className="opacity-60">Checking what stands…</li>}
          {chk !== undefined && lines.map((l, i) => (
            <li key={i} className={l.ok === true ? "opacity-80" : "text-danger"}>
              <span className="mr-1 inline-block w-3 text-center">{l.ok === true ? "✓" : l.ok === false ? "✗" : "?"}</span>{l.label}
            </li>
          ))}
          {chk && offerNoNutrition(chk) && (
            <li>
              <label className="mt-1 inline-flex items-center gap-2 text-xs">
                <input type="checkbox" className="h-3.5 w-3.5" checked={noNutrition} onChange={(e) => setNoNutrition(e.target.checked)} />
                No nutrition plan for this client — coaching training only (recorded)
              </label>
            </li>
          )}
        </ul>
        <button type="button" onClick={release} disabled={!ready || busy || chk == null}
          title={ready ? "Publish the program, assign nutrition, and invite — one step" : "Every item above must be ✓ first"}
          className="btn-primary min-h-[44px] px-4 disabled:opacity-40">
          {busy ? "Releasing…" : "Release"}
        </button>
      </div>
      {note && (
        <p className={`mt-2 text-xs ${note.ok ? "text-success" : "text-danger"}`}>
          {note.text}
          {note.claimLink && (
            <button type="button" className="ml-2 rounded-md border border-ink/15 px-2 py-0.5"
              onClick={() => navigator.clipboard?.writeText(note.claimLink)}>Copy invite link</button>
          )}
        </p>
      )}
    </div>
  );
}

function AccountInviteButton({ client }) {
  const [state, setState] = useState(null); // null | "copied" | "opened" | error text
  const flash = (s) => { setState(s); setTimeout(() => setState(null), 2500); };

  async function copyLink() {
    try {
      const link = await createClientInvite(client.id);
      await navigator.clipboard.writeText(link);
      flash("copied");
    } catch (e) { setState(e.message); }
  }

  async function emailInvite() {
    try {
      const link = await createClientInvite(client.id);
      const { subject, body } = accountInviteEmail({ displayName: client.display_name, link });
      openMailClient(buildMailto({ to: client.email, subject, body }));
      flash("opened");
    } catch (e) { setState(e.message); }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <button onClick={copyLink} className="rounded-md border border-ink/15 px-2 py-1 hover:bg-ink/[0.03]">
        {state === "copied" ? "Invite link copied ✓" : "Copy invite link"}
      </button>
      {/* An invite with no address to send it to is a dead button, so it is not offered. */}
      {client.email && (
        <button onClick={emailInvite} className="rounded-md border border-ink/15 px-2 py-1 hover:bg-ink/[0.03]">
          {state === "opened" ? "Opening your mail app…" : "Email invite"}
        </button>
      )}
      {state && state !== "copied" && state !== "opened" && <span className="ml-2 text-danger">{state}</span>}
    </span>
  );
}

// Sign-in code, read over the phone. For the client who cannot find the email — 2026-09-05,
// a client in her 70s on a tablet in the Philippines had no other way in. The coach taps, the
// code shows large, the coach reads it. The client taps "I already have a code" on the sign-in
// screen; if she taps "Send sign-in code" instead, that request replaces this code and the
// coach taps again. Every issuance is written to notification_log by the function.
function SigninCodeButton({ client }) {
  const [state, setState] = useState(null); // null | { code, linked, audit_logged } | error text
  const [busy, setBusy] = useState(false);

  async function getCode() {
    setBusy(true); setState(null);
    try { setState(await getClientSigninCode(client.id)); }
    catch (e) { setState(e.message); }
    setBusy(false);
  }

  // A code is tied to an email; with none on the record there is nothing to issue.
  if (!client.email) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <button onClick={getCode} disabled={busy} className="rounded-md border border-ink/15 px-2 py-1 hover:bg-ink/[0.03] disabled:opacity-50">
        {busy ? "Getting code…" : "Read sign-in code"}
      </button>
      {state && typeof state === "object" && (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <strong className="font-mono text-base tracking-[0.3em]">{state.code}</strong>
          <span className="opacity-60">
            They enter <strong>{client.email}</strong>, tap “I already have a code”, type this.
            {state.linked === "linked" ? " Account attached to this record." : ""}
            {state.audit_logged ? "" : " Audit row did not write — tell the app owner."}
          </span>
        </span>
      )}
      {typeof state === "string" && <span className="text-danger">{state}</span>}
    </span>
  );
}

const numOrNull = (v) => (v === "" || v == null ? null : Number(v));

// Editable client profile + structured stats block. DB stores canonical metric
// (height_cm/weight_kg); the coach toggles lbs/kg + ft-in/cm and values convert only on
// toggle & save (no keystroke jitter). Numeric fields are typed so the future meal-plan
// calculator reads them directly.
function Profile({ clientId, onSaved, onRemoved }) {
  const [meta, setMeta] = useState(null); // name/email/tier/status/age/sex/activity/bodyfat
  const [units, setUnits] = useState("imperial");
  const [wt, setWt] = useState("");                 // display weight (current unit)
  const [hFt, setHFt] = useState(""); const [hIn, setHIn] = useState("");
  const [hCm, setHCm] = useState("");
  const [cls, setCls] = useState({ clientType: "", showDate: "", showName: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [loadedStatus, setLoadedStatus] = useState(null);
  const [archiveArmed, setArchiveArmed] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  useEffect(() => {
    getClientProfile(clientId).then((c) => {
      setMeta({
        tenant_id: c.tenant_id,
        display_name: c.display_name ?? "", email: c.email ?? "",
        coaching_tier: c.coaching_tier ?? "", status: c.status ?? "invited",
        age: c.age ?? "", sex: c.sex ?? "", activity_level: c.activity_level ?? "",
        body_fat_pct: c.body_fat_pct ?? "",
        goal_weight_kg: c.goal_weight_kg ?? "",
      });
      setLoadedStatus(c.status ?? "invited");
      // NULL round-trips as "" in the select and back to null on save, so an
      // unclassified client stays unclassified unless the coach actually picks one.
      setCls({
        clientType: c.client_type ?? "",
        showDate: c.show_date ?? "",
        showName: c.show_name ?? "",
      });
      const pref = c.unit_pref === "metric" ? "metric" : "imperial";
      setUnits(pref);
      if (pref === "metric") {
        setHCm(c.height_cm ?? ""); setWt(c.weight_kg ?? "");
      } else {
        const { ft, in: inch } = cmToFtIn(c.height_cm);
        setHFt(ft); setHIn(inch); setWt(kgToLb(c.weight_kg));
      }
    }).catch((e) => setMsg(e.message));
  }, [clientId]);

  // Convert the current display values across the unit boundary when toggling.
  function switchUnits(next) {
    if (next === units) return;
    if (next === "metric") {
      // from imperial: ft/in → cm, lb → kg
      setHCm(ftInToCm(hFt, hIn) ?? "");
      setWt(lbToKg(wt) ?? "");
    } else {
      // from metric: cm → ft/in, kg → lb
      const { ft, in: inch } = cmToFtIn(numOrNull(hCm));
      setHFt(ft); setHIn(inch);
      setWt(kgToLb(wt) ?? "");
    }
    setUnits(next);
  }

  async function save(e) {
    e.preventDefault();
    if (!meta.display_name.trim()) { setMsg("Name is required."); return; }
    setBusy(true); setMsg(null);
    const height_cm = units === "metric" ? numOrNull(hCm) : ftInToCm(hFt, hIn);
    const weight_kg = units === "metric" ? numOrNull(wt) : lbToKg(wt);
    try {
      const isRestoring = loadedStatus === "archived" && meta.status !== "archived";
      await updateClient(clientId, {
        display_name: meta.display_name.trim(),
        email: meta.email.trim() ? meta.email.trim().toLowerCase() : null,
        coaching_tier: meta.coaching_tier.trim() || null,
        status: meta.status,
        age: meta.age === "" ? null : parseInt(meta.age, 10),
        sex: meta.sex || null,
        activity_level: meta.activity_level || null,
        body_fat_pct: numOrNull(meta.body_fat_pct),
        goal_weight_kg: numOrNull(meta.goal_weight_kg),
        height_cm, weight_kg, unit_pref: units,
        // Classification. Show details are cleared unless the client is prep, so
        // correcting prep -> lifestyle cannot leave a stale show date behind.
        client_type: cls.clientType || null,
        show_date: cls.clientType === "prep" ? (cls.showDate || null) : null,
        show_name: cls.clientType === "prep" ? (cls.showName?.trim() || null) : null,
      });
      if (isRestoring) {
        recordActivity({
          tenantId: meta.tenant_id,
          clientId,
          template: "client_restored",
          detail: { summary: `Restored as ${meta.status}.` },
        }).catch((activityErr) => console.error("activity: client restore was not recorded", activityErr));
      }
      setLoadedStatus(meta.status);
      setMsg("Saved ✓");
      onSaved?.();
      setTimeout(() => setMsg(null), 2500);
    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }

  if (!meta) return <Muted>Loading…</Muted>;
  const set = (k) => (e) => setMeta({ ...meta, [k]: e.target.value });
  const field = "mt-1 w-full rounded-lg border border-ink/15 px-3 py-2";

  return (
    <form onSubmit={save} className="space-y-4 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <label><span className="opacity-60">Name *</span>
          <input value={meta.display_name} onChange={set("display_name")} required className={field} /></label>
        <label><span className="opacity-60">Email</span>
          <input type="email" value={meta.email} onChange={set("email")} className={field} /></label>
        <label><span className="opacity-60">Tier</span>
          <input value={meta.coaching_tier} onChange={set("coaching_tier")} className={field} /></label>
        <label><span className="opacity-60">Status</span>
          <select value={meta.status} onChange={set("status")} className={field}>
            <option value="invited">Invited</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="archived">Archived</option>
          </select></label>
      </div>

      <ClassificationFields value={cls} onChange={setCls} idPrefix="profile" />

      <div className="rounded-lg border border-ink/10 p-3">
        <div className="flex items-center justify-between">
          <span className="font-medium">Stats</span>
          <div className="flex overflow-hidden rounded-md border border-ink/15 text-xs">
            {["imperial", "metric"].map((u) => (
              <button type="button" key={u} onClick={() => switchUnits(u)}
                className={`px-2 py-1 ${units === u ? "bg-ink text-paper" : "opacity-60"}`}>
                {u === "imperial" ? "lb / ft-in" : "kg / cm"}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label><span className="opacity-60">Age</span>
            <input type="number" min="0" max="120" value={meta.age} onChange={set("age")} className={field} /></label>
          <label><span className="opacity-60">Sex</span>
            <select value={meta.sex} onChange={set("sex")} className={field}>
              <option value="">—</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other</option>
            </select></label>

          {units === "metric" ? (
            <label><span className="opacity-60">Height (cm)</span>
              <input type="number" step="0.1" value={hCm} onChange={(e) => setHCm(e.target.value)} className={field} /></label>
          ) : (
            <div><span className="opacity-60">Height</span>
              <div className="mt-1 flex gap-2">
                <input type="number" min="0" placeholder="ft" value={hFt} onChange={(e) => setHFt(e.target.value)}
                  className="w-full rounded-lg border border-ink/15 px-3 py-2" />
                <input type="number" min="0" max="11" placeholder="in" value={hIn} onChange={(e) => setHIn(e.target.value)}
                  className="w-full rounded-lg border border-ink/15 px-3 py-2" />
              </div>
            </div>
          )}

          <label><span className="opacity-60">Weight ({units === "metric" ? "kg" : "lb"})</span>
            <input type="number" step="0.1" value={wt} onChange={(e) => setWt(e.target.value)} className={field} /></label>
          <label><span className="opacity-60">Goal weight ({units === "metric" ? "kg" : "lb"})</span>
            <input type="number" step="0.1" value={meta.goal_weight_kg ? (units === "metric" ? meta.goal_weight_kg : kgToLb(meta.goal_weight_kg)) : ""} onChange={(e) => {
              const raw = e.target.value;
              setMeta({ ...meta, goal_weight_kg: raw === "" ? "" : String(units === "metric" ? Number(raw) : lbToKg(raw)) });
            }} className={field} placeholder={units === "metric" ? "kg" : "lb"} /></label>
          <label><span className="opacity-60">Activity level</span>
            <select value={meta.activity_level} onChange={set("activity_level")} className={field}>
              <option value="">—</option>
              {ACTIVITY_LEVELS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select></label>
          <label><span className="opacity-60">Body fat % (optional)</span>
            <input type="number" step="0.1" min="0" max="75" value={meta.body_fat_pct} onChange={set("body_fat_pct")} className={field} /></label>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button disabled={busy} className="rounded-lg bg-brand px-4 py-2 text-brand-text disabled:opacity-50">
          {busy ? "Saving…" : "Save profile"}
        </button>
        {msg && <span className={msg === "Saved ✓" ? "text-success" : "text-danger"}>{msg}</span>}
      </div>

      <div className="rounded-xl border border-danger/25 bg-danger/5 p-4">
        <h3 className="section-title text-danger">Remove client</h3>
        <p className="mt-2 text-xs leading-relaxed opacity-70">
          Archive hides this client from active coaching surfaces and keeps their history.
          Delete is for clean test records only; real history may block it.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {archiveArmed ? (
            <>
              <button type="button" disabled={busy} onClick={async () => {
                setBusy(true); setMsg(null);
                try {
                  await archiveClient(clientId);
                  recordActivity({
                    tenantId: meta.tenant_id,
                    clientId,
                    template: "client_archived",
                    detail: { summary: "Archived from the coach profile." },
                  }).catch((activityErr) => console.error("activity: client archive was not recorded", activityErr));
                  setMsg("Archived.");
                  onRemoved?.();
                } catch (e) { setMsg(e.message); } finally { setBusy(false); }
              }} className="btn-primary bg-danger">
                Confirm archive
              </button>
              <button type="button" onClick={() => setArchiveArmed(false)} className="btn-ghost">
                Cancel
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setArchiveArmed(true)} className="btn-ghost">
              Archive client
            </button>
          )}
        </div>

        <div className="mt-4 border-t border-danger/20 pt-4">
          {deleteArmed ? (
            <div className="space-y-3">
              <label className="block text-xs">
                <span className="opacity-70">Type the client name to delete: {meta.display_name}</span>
                <input value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-danger/30 px-3 py-2" />
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy || deleteConfirm.trim() !== meta.display_name.trim()}
                  onClick={async () => {
                    setBusy(true); setMsg(null);
                    try {
                      await deleteClient(clientId);
                      onRemoved?.();
                    } catch (e) { setMsg(e.message); } finally { setBusy(false); }
                  }}
                  className="btn-primary bg-danger">
                  Permanently delete
                </button>
                <button type="button" onClick={() => { setDeleteArmed(false); setDeleteConfirm(""); }}
                  className="btn-ghost">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setDeleteArmed(true)}
              className="rounded-xl border border-danger/30 px-4 py-2 text-sm font-semibold text-danger transition hover:bg-danger/10">
              Delete client
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

// Coach-private notes (RLS coach-only). Timestamped, add + edit. v1: no history/timeline.
function Notes({ clientId, tenantId }) {
  const { user } = useAuth();
  const [rows, setRows] = useState(undefined);
  const [failed, setFailed] = useState(false);
  const [body, setBody] = useState("");
  const [editId, setEditId] = useState(null);
  const [editBody, setEditBody] = useState("");
  const [err, setErr] = useState(null);
  const load = useCallback(
    () => getClientNotes(clientId)
      .then((r) => { setFailed(false); setRows(r); })
      .catch(() => { setFailed(true); setRows(null); }),
    [clientId],
  );
  useEffect(() => { load(); }, [load]);

  async function add(e) {
    e.preventDefault();
    if (!body.trim()) return;
    setErr(null);
    try { await addClientNote({ tenantId, clientId, userId: user?.id, body }); setBody(""); await load(); }
    catch (e) { setErr(e.message); }
  }
  async function saveEdit(id) {
    if (!editBody.trim()) return;
    setErr(null);
    try { await updateClientNote(id, editBody); setEditId(null); setEditBody(""); await load(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div>
      <form onSubmit={add} className="flex gap-2">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2}
          placeholder="Add a note about this client…"
          className="flex-1 rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        <button className="self-start rounded-lg bg-brand px-4 py-2 text-sm text-brand-text">Add</button>
      </form>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      {rows === undefined ? <Muted>Loading…</Muted> : failed ? (
        <div className="mt-3"><LoadFail>Could not load notes — failed read, not “no notes yet.”</LoadFail></div>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm opacity-60">No notes yet.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((n) => (
            <li key={n.id} className="rounded-lg border border-ink/10 p-3 text-sm">
              {editId === n.id ? (
                <div>
                  <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={2}
                    className="w-full rounded-lg border border-ink/15 px-3 py-2" />
                  <div className="mt-2 flex gap-2 text-xs">
                    <button onClick={() => saveEdit(n.id)} className="rounded bg-ink px-2 py-1 text-paper">Save</button>
                    <button onClick={() => { setEditId(null); setEditBody(""); }} className="rounded border border-ink/15 px-2 py-1">Cancel</button>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="whitespace-pre-wrap">{n.body}</p>
                  <div className="mt-1 flex items-center justify-between text-xs opacity-50">
                    <span>
                      {new Date(n.created_at).toLocaleString()}
                      {n.updated_at && n.updated_at !== n.created_at ? " · edited" : ""}
                    </span>
                    <button onClick={() => { setEditId(n.id); setEditBody(n.body); }} className="underline">Edit</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Muted({ children }) { return <p className="text-sm opacity-60">{children}</p>; }
function LoadFail({ children }) {
  return (
    <p className="rounded-xl border border-dashed border-danger/40 bg-danger/5 px-3 py-3 text-sm text-danger">
      {children}
    </p>
  );
}

// Phase 4 part A — who bought Self-serve plan (owner only; the parent gates on isOwnerTenant).
// Three states, three renderings: loading, failed read, and a real empty list.
function SystemBuyersSection({ onConverted }) {
  const [rows, setRows] = useState(undefined);
  const [failed, setFailed] = useState(null);
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(null);
  const [note, setNote] = useState(null);
  // Read on mount, not on open: the header must flag a stuck buyer while the panel is closed.
  useEffect(() => {
    if (rows !== undefined) return;
    listSystemBuyers().then(setRows).catch((e) => setFailed(e.message || "read failed"));
  }, [rows]);
  const stuckCount = Array.isArray(rows) ? rows.filter((r) => stuckReasons(r).length > 0).length : 0;
  const stuckNote = (r) => {
    const missing = stuckReasons(r);
    return missing.length > 0
      ? <p className="mt-1 text-xs text-danger">Stuck: paid and submitted intake, no {missing.join(", ")}.</p>
      : null;
  };
  const yesNo = (v) => (v ? "Yes" : "No");
  const day = (v) => (v ? new Date(v).toLocaleDateString() : "—");
  const aiLabel = (r) => (r.ai_connected ? (r.ai_scope === "owner" ? "Full control" : "Read-only") : "No");

  async function move(r) {
    const name = r.display_name || r.email_masked || "this buyer";
    const ok = window.confirm(
      `Move ${name} to coaching?\n\n` +
      "A client row is created on your roster with their numbers copied. Their sign-in moves with them — " +
      "next time they open the app they land in coaching, not SYSTEM. Their AI connection is disconnected " +
      "(they can reconnect from the coaching app). Their SYSTEM history stays on this list.",
    );
    if (!ok) return;
    setMoving(r.client_id); setNote(null);
    try {
      const newId = await convertSystemBuyer(r.client_id);
      const fresh = await listSystemBuyers();
      setRows(fresh);
      setNote(`${name} is now on your roster.`);
      onConverted?.(newId);
    } catch (e) {
      setNote(`Not moved: ${e.message || "unknown error"}`);
    } finally {
      setMoving(null);
    }
  }

  // The state of a buyer's login, in words. Three real facts, three different sentences.
  function moveCell(r) {
    if (r.converted_client_id) return <span className="opacity-70">Moved to coaching {day(r.converted_at)}</span>;
    if (!r.has_account) return <span className="opacity-50" title="No login exists yet, so there is nothing to move.">Never signed in</span>;
    return (
      <button type="button" onClick={() => move(r)} disabled={moving === r.client_id}
        className="btn-ghost min-h-[36px] px-3 text-xs">
        {moving === r.client_id ? "Moving…" : "Move to coaching"}
      </button>
    );
  }

  return (
    <section className="glass mt-6 p-5">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex w-full items-center justify-between text-left min-h-[44px]">
        <span>
          <span className="kicker">SELF-SERVE PLAN</span>
          <span className="display mt-1 block text-xl">Buyers</span>
        </span>
        <span className="text-xs">
          {stuckCount > 0 && <span className="mr-2 font-medium text-danger">{stuckCount} stuck</span>}
          <span className="opacity-60">{open ? "Hide" : "Show"}</span>
        </span>
      </button>
      {open && failed && <p className="mt-3 text-sm text-danger">Could not read the buyer list: {failed}</p>}
      {open && !failed && rows === undefined && <p className="mt-3 text-sm opacity-60">Loading…</p>}
      {open && note && <p className="mt-3 text-sm" role="status">{note}</p>}
      {open && !failed && Array.isArray(rows) && rows.length === 0 && (
        <p className="mt-3 text-sm opacity-70">No Self-serve plan buyers yet.</p>
      )}
      {/* Narrow screens: one card per buyer so all fields remain visible
          without horizontal scrolling. */}
      {open && !failed && Array.isArray(rows) && rows.length > 0 && (
        <ul className="mt-3 space-y-3 md:hidden">
          {rows.map((r) => (
            <li key={r.client_id} className="rounded-xl border border-ink/10 p-3 text-sm">
              <p className="font-medium">{r.display_name || "—"}</p>
              <p className="text-xs opacity-60">{r.email_masked || "no email"} · joined {day(r.joined_at)}</p>
              {stuckNote(r)}
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="opacity-60">Intake</dt><dd>{intakeLabel(r)}</dd>
                <dt className="opacity-60">Program</dt><dd>{yesNo(r.program_published)}</dd>
                <dt className="opacity-60">Meal plan</dt><dd>{yesNo(r.meal_plan_assigned)}</dd>
                <dt className="opacity-60">AI</dt><dd>{aiLabel(r)}</dd>
                <dt className="opacity-60">Last seen</dt><dd>{day(r.last_seen_at)}</dd>
              </dl>
              <div className="mt-3 text-xs">{moveCell(r)}</div>
            </li>
          ))}
          <li className="text-xs opacity-50">Last seen = latest of an AI call, an intake submission, or a profile update. App opens are not tracked.</li>
        </ul>
      )}
      {open && !failed && Array.isArray(rows) && rows.length > 0 && (
        <div className="mt-3 hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide opacity-60">
              <tr>
                <th className="py-2 pr-3">Buyer</th><th className="py-2 pr-3">Joined</th><th className="py-2 pr-3">Intake</th>
                <th className="py-2 pr-3">Program</th><th className="py-2 pr-3">Meal plan</th><th className="py-2 pr-3">AI</th>
                <th className="py-2 pr-3">Last seen</th><th className="py-2">Coaching</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/10">
              {rows.map((r) => (
                <tr key={r.client_id}>
                  <td className="py-2 pr-3">
                    <span className="font-medium">{r.display_name || "—"}</span>
                    <span className="block text-xs opacity-60">{r.email_masked || "no email"}</span>
                    {stuckNote(r)}
                  </td>
                  <td className="py-2 pr-3">{day(r.joined_at)}</td>
                  <td className="py-2 pr-3">{intakeLabel(r)}</td>
                  <td className="py-2 pr-3">{yesNo(r.program_published)}</td>
                  <td className="py-2 pr-3">{yesNo(r.meal_plan_assigned)}</td>
                  <td className="py-2 pr-3">{aiLabel(r)}</td>
                  <td className="py-2 pr-3">{day(r.last_seen_at)}</td>
                  <td className="py-2 text-xs">{moveCell(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs opacity-50">Last seen = latest of an AI call, an intake submission, or a profile update. App opens are not tracked.</p>
        </div>
      )}
    </section>
  );
}
