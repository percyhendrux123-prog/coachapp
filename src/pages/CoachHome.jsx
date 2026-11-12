// ============================================================================
// COACH HOME — "What needs you."
//
// The app's home surface for a coach. This is the app clients train in; the
// challenge is a feature inside it, not the app's identity.
//
// RULE 1 — NO SHAPING LOGIC.
// No ranking, no scoring, no health computation, no filtering that changes which
// items appear or in what order. Everything below is presentation of a payload
// that rm_coach_overview() already shaped. The MCP connector calls the same
// function, so any rule that leaks into this file immediately becomes a rule the
// model does not know about.
//
// RULE 2 — THE APP'S DESIGN SYSTEM, NOTHING ELSE.
// Every colour comes from ink / paper / brand / danger / success (Tailwind, backed
// by --ink-rgb and --paper-rgb which src/lib/theme.js swaps for dark mode). Every
// radius, size and gap comes from the Tailwind scale. Cards are .glass, headings
// are .display, section labels are .section-title, buttons are .btn-primary and
// .btn-ghost — the same classes every other coach page uses.
//
// This page previously shipped its own stylesheet with its own tokens: Bebas Neue
// and a system body font instead of Archivo, a hardcoded dark surface against a
// light app, a 6/10/14/20/28/40 spacing scale off the 4px grid, its own status
// palette, and a second brand mark stacked under the app's nav. It also ignored
// the light/dark toggle completely, because none of its colours were built on the
// variables the toggle flips. Rebuilding on the shared tokens is what makes that
// unrepeatable — there is no longer a second set of values to drift from.
//
// Ordering is by required decision, never chronological. The single chronological
// element is Activity, deliberately last and deliberately small.
// ============================================================================
import { useCallback, useEffect, useState } from "react"; // useCallback: Refresh signals
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { fetchCoachOverview, fetchReminderStatus } from "../lib/coachOverview";
import { listDraftMealPlans, releaseMealPlan } from "../lib/mealPlan";
import { listPendingProgramDrafts, decideProgramDraft, verifyPublishedChain } from "../lib/programDrafts";
import { PREVIEW_ROUTES_ENABLED } from "../lib/previewFlag";
import { CoachTabs } from "../components/CoachTabs";
import AppGate from "../components/AppGate";

const EM_DASH = "—";

export default function CoachHome() {
  const { user, role } = useAuth();
  const [params] = useSearchParams();
  // ?preview is honoured in development and in an explicitly-flagged draft build
  // ONLY (see previewFlag.js). In a production build this is hard-null, so a coach
  // who lands on /coach?preview=steady sees their real data, never a fixture. The
  // fixture module is behind a dynamic import so it is code-split out entirely.
  const previewName = PREVIEW_ROUTES_ENABLED ? params.get("preview") : null;
  const previewTenant = params.get("tenant");

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadOverview = useCallback(async () => {
    if (previewName) {
      const { getFixture } = await import("../lib/coachOverviewFixtures");
      setData(getFixture(previewName, previewTenant));
      setError(null);
      return;
    }
    if (!user || role !== "coach") return;
    setRefreshing(true);
    try {
      setData(await fetchCoachOverview());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setRefreshing(false);
    }
  }, [previewName, previewTenant, user, role]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (previewName) {
          const { getFixture } = await import("../lib/coachOverviewFixtures");
          if (!cancelled) { setData(getFixture(previewName, previewTenant)); setError(null); }
          return;
        }
        // Don't call the read model without a coach session — it would fail on "no tenant in
        // session" and surface as a page error, when the real answer is simply "not signed in".
        if (!user || role !== "coach") return;
        const d = await fetchCoachOverview();
        if (!cancelled) { setData(d); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => { cancelled = true; };
  }, [previewName, previewTenant, user, role]);

  // Signed-out visitors previously fell through to the read-model call and were shown
  // "This page could not load — rm_coach_overview: no tenant in session", which reads as a
  // broken product rather than a locked door. Every sibling coach page gates on the session
  // first; the front door should too. Preview mode is exempt: it renders a fixture and never
  // touches the database, so it has nothing to authorise.
  if (!previewName) {
    if (!user) {
      return (
        <AppGate title="Sign in to see what needs you" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
          Coach Home ranks decisions and signal integrity for your roster.
        </AppGate>
      );
    }
    if (role !== "coach") {
      return (
        <AppGate title="This area is for coaches" actionTo="/client" actionLabel="My coaching" secondaryTo="/" secondaryLabel="Home">
          Clients train under My coaching. Coaches use this home for triage.
        </AppGate>
      );
    }
  }

  if (error) {
    return (
      <Shell>
        <Void tone="unavailable" title="This page could not load"
          body={`${String(error.message || error)} The read model may not be installed on this environment yet.`}
          meta="RPC rm_coach_overview"
          actionLabel="Retry read"
          onAction={loadOverview}
          actionDisabled={refreshing} />
      </Shell>
    );
  }

  if (!data) {
    return (
      <Shell>
        <p className="py-20 text-center text-sm opacity-60">Reading signals{EM_DASH}</p>
      </Shell>
    );
  }

  return (
    <Shell>
      {previewName && (
        <div className="hatch mt-6 rounded-2xl border border-dashed border-ink/25 p-3 text-xs font-semibold uppercase tracking-[0.12em] opacity-70">
          Preview {EM_DASH} fixture &ldquo;{previewName}&rdquo;
          {previewTenant ? `, tenant “${previewTenant}”` : ""}. Not live data.
          Remove ?preview to read the database.
        </div>
      )}

      <header className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="kicker">
            {new Date(data.generated_at || Date.now()).toLocaleDateString("en-GB",
              { weekday: "short", day: "2-digit", month: "short" })}
            {" · "}Updated {relativeTime(data.generated_at)}
          </span>
          <h1 className="display mt-1 text-2xl sm:text-3xl md:text-4xl">What needs you</h1>
          <p className="mt-2 max-w-[52ch] text-sm opacity-60">
            Ranked by what requires a decision, not by what happened last.
            {" "}For AI draft replies and send queue, use{" "}
            <Link to="/coach/cockpit" className="underline opacity-80 hover:opacity-100">Cockpit</Link>
            {" "}under More — Home is triage; Cockpit is assistant drafts.
          </p>
        </div>
        {!previewName && (
          <button
            type="button"
            onClick={loadOverview}
            disabled={refreshing}
            className="btn-ghost w-fit shrink-0"
          >
            {refreshing ? "Refreshing…" : "Refresh signals"}
          </button>
        )}
      </header>

      {/* 1 ── Signal integrity. Always first: nothing below it is readable
              without knowing which feeds are telling the truth. */}
      <SignalIntegrity sources={data.sources} onRefresh={previewName ? null : loadOverview} refreshing={refreshing} />

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <RosterPulse roster={data.roster} sources={data.sources} />
          <AttentionQueue attention={data.attention} suppressed={data.suppressed} />
        </div>
        <div className="space-y-4">
          <Decisions decisions={data.decisions} isPreview={!!previewName} />
          <PrepTimelines timelines={data.timelines} unavailable={data.timelines_unavailable}
            note={data.timelines_note} />
          <Activity activity={data.activity} sources={data.sources} />
        </div>
      </div>

      <UnavailableSignals items={data.unavailable_signals} />
    </Shell>
  );
}

// Same shell every coach page uses, so the front door sits in the same frame as
// its siblings — and carries the nav that used to be missing here entirely.
function Shell({ children }) {
  return (
    <main className="mx-auto max-w-7xl px-5 py-8 sm:px-6 md:py-10">
      <CoachTabs active="home" />
      {children}
    </main>
  );
}

/* ---------------------------------------------------------------------------
   Shared empty/unknown block.
     empty       -> solid. We looked, there is genuinely nothing.
     unavailable -> dashed + hatched. We cannot see, and something is wrong.
   The difference is the whole point of the page and must stay visible.
   --------------------------------------------------------------------------- */
function Void({ tone = "empty", title, body, meta, actionLabel, onAction, actionDisabled = false }) {
  const unavailable = tone === "unavailable";
  return (
    <div className={`rounded-xl border p-4 text-center ${
      unavailable ? "hatch border-dashed border-ink/25" : "border-ink/10"}`}>
      <div className="text-sm font-bold">{title}</div>
      <p className="mx-auto mt-1 max-w-[46ch] text-xs leading-relaxed opacity-60">{body}</p>
      {meta && (
        <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.12em] opacity-45">
          {meta}
        </div>
      )}
      {onAction && actionLabel && (
        <button
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
          className="btn-ghost mt-4 min-h-[44px] px-4 text-sm"
        >
          {actionDisabled ? "Trying again…" : actionLabel}
        </button>
      )}
    </div>
  );
}

function Card({ title, count, children, className = "" }) {
  return (
    <section className={`glass p-4 ${className}`} aria-label={title}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="section-title">{title}</h2>
        {count != null && (
          typeof count === "string" || typeof count === "number"
            ? <span className="text-xs opacity-50">{count}</span>
            : count
        )}
      </div>
      {children}
    </section>
  );
}

/* ---------------------------------------------------------------------------
   1. SIGNAL INTEGRITY
   Rendered 1:1 from sources[]. `note` is printed verbatim — the read model owns
   that sentence so the connector and the coach read the same words.
   --------------------------------------------------------------------------- */
const SOURCE_LABELS = {
  training: "Training", checkins: "Check-ins", messages: "Messages",
  roster: "Roster & programs", nutrition: "Nutrition", billing: "Billing",
};

// Dot colour carries source state. brand = healthy, danger = faulty, muted = never used.
const SOURCE_DOT = {
  live: "bg-brand",
  stale: "bg-brand/50",
  unavailable: "bg-danger",
  not_configured: "bg-ink/25",
};

function SignalIntegrity({ sources = [], onRefresh, refreshing }) {
  // Status must be visible before the coach trusts the queue, but the diagnostic
  // essay must not own the first screen. The compact summary always names a failed
  // source; details expand only when the coach asks for the evidence.
  const needsAttention = sources.some(
    (s) => s.state === "unavailable" || s.state === "stale" || s.state === "not_configured"
  );
  const [open, setOpen] = useState(false);

  const liveCount = sources.filter((s) => s.state === "live").length;
  const summary = needsAttention
    ? sources
        .filter((s) => s.state !== "live")
        .map((s) => `${SOURCE_LABELS[s.key] || s.key}: ${s.state.replace(/_/g, " ")}`)
        .join(" · ")
    : `${liveCount} feed${liveCount === 1 ? "" : "s"} live`;

  return (
    <Card title="Signal integrity" className={`mt-4 ${needsAttention ? "border-danger/30" : ""}`}
      count={(
        <div className="flex items-center gap-2">
          {onRefresh ? (
            <button type="button" onClick={onRefresh} disabled={refreshing}
              className="text-xs font-semibold uppercase tracking-[0.12em] opacity-60 hover:opacity-100 disabled:opacity-40">
              {refreshing ? "Reading…" : "Re-check"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="text-xs font-semibold uppercase tracking-[0.12em] opacity-60 hover:opacity-100"
          >
            {open ? "Hide" : "Details"}
          </button>
        </div>
      )}
    >
      {/* The collapsed card states the integrity verdict without making infrastructure
          own the first viewport. The source-by-source evidence stays one tap away. */}
      <p className={`text-xs ${needsAttention ? "font-semibold text-danger" : "opacity-55"}`}>{summary}</p>

      {open && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {sources.map((s) => (
              <span
                key={s.key}
                title={`${SOURCE_LABELS[s.key] || s.key}: ${s.state}`}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] ${
                  s.state === "unavailable" ? "border-danger/30 text-danger" : "border-ink/10 opacity-70"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${SOURCE_DOT[s.state] || "bg-ink/25"}`} />
                {SOURCE_LABELS[s.key] || s.key}
              </span>
            ))}
          </div>
          <p className="mb-3 mt-3 text-xs leading-relaxed opacity-55">
            These dots are automatic — they reflect whether each feed is reporting right now.
            You can&apos;t edit them by hand. If something looks wrong after a fix, hit{" "}
            <b>Refresh signals</b> (or Re-check) to re-read production. They reset themselves
            the next time the feed is healthy.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {sources.map((s) => (
              <div key={s.key}
                className={`flex gap-2.5 rounded-xl border p-3 ${
                  s.state === "unavailable" ? "border-danger/30" : "border-ink/10"}`}>
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                  SOURCE_DOT[s.state] || "bg-ink/25"}`} />
                <div className="min-w-0">
                  <div className="text-sm font-bold">{SOURCE_LABELS[s.key] || s.key}</div>
                  <p className="mt-0.5 text-xs leading-relaxed opacity-60">{s.note}</p>
                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.12em] opacity-40">
                    {s.state === "live" ? "Live" : s.state === "stale" ? "Stale" : s.state === "unavailable" ? "Unavailable" : s.state === "not_configured" ? "Not configured" : s.state}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   2. ROSTER PULSE
   FOUR treatments. A number and a null each carry two distinct meanings:

     known       -> plain numeral. Unremarkable.
     zero        -> brand-coloured numeral + "NONE LOGGED". A TRUE ZERO on a metric
                    where zero means work was owed and not done. Known with full
                    confidence, and the loudest thing on the card.
     unavailable -> dashed + hatched + "SOURCE UNAVAILABLE". Cannot see, something
                    is wrong.
     untracked   -> dashed, quiet, "NOT TRACKED". Cannot see, nothing is wrong.

   zero and untracked are SIBLINGS, not a value and its error state. Both are true,
   both are the coach's business, and they drive opposite actions: a zero means
   speak to the client, an untracked means nobody is watching that yet and the
   system needs fixing. Never coalesce a null to 0 — that is the bug that has a
   coach message a client who did train.
   --------------------------------------------------------------------------- */
function RosterPulse({ roster = {}, sources = [] }) {
  const stateOf = (key) => sources.find((s) => s.key === key)?.state;

  const treatment = (m) => {
    if (m.value === null || m.value === undefined) {
      return stateOf(m.src) === "not_configured" ? "untracked" : "unknown";
    }
    return m.value === 0 && m.zeroMeans === "failure" ? "zero" : "known";
  };

  // zeroMeans marks the metrics where 0 is an accusation rather than good news. It
  // is a static property of what the metric MEANS, in the same class as its label —
  // not a ranking, score or threshold, so it does not breach RULE 1. It does belong
  // in the read model eventually: the MCP connector reads the same roster object and
  // has no way to know trained_7d = 0 is an alarm while silent_7d = 0 is a relief.
  const metrics = [
    { key: "active", label: "Active", value: roster.active, src: "roster" },
    { key: "paused", label: "Paused", value: roster.paused, src: "roster" },
    { key: "trained_7d", label: "Trained in 7 days", value: roster.trained_7d,
      of: roster.active, src: "training", zeroMeans: "failure" },
    // Zero here is the good outcome — nobody has gone quiet. Never made loud.
    { key: "silent_7d", label: "Silent 7 days+", value: roster.silent_7d, src: "training" },
    { key: "checked_in_7d", label: "Checked in this week", value: roster.checked_in_7d,
      src: "checkins", zeroMeans: "failure" },
  ];

  return (
    <Card title="Roster"
      count={roster.total === 0 ? "Nobody yet" : `${roster.total} on the book`}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {metrics.map((m) => {
          const t = treatment(m);
          const isKnown = t === "known" || t === "zero";
          return (
            // Colour allocation matters here, and it is NOT the brand.
            //   zero        -> danger. A true zero is the one genuinely alarming
            //                  number on the card, and danger is the app's token for
            //                  exactly that. Using brand would be wrong twice: it is
            //                  decoration rather than meaning, and it disappears on a
            //                  tenant whose brand colour is near-black (brand falls
            //                  back to ink), which is precisely the tenant whose loud
            //                  zero would then read as an ordinary number.
            //   unknown     -> hatch + dashed, caption stays MUTED. Deliberately not
            //                  red: if "cannot see" and "really is zero" share a
            //                  colour, the distinction this page exists to protect is
            //                  gone. Which feed is broken is already stated, in red,
            //                  on the signal-integrity card above.
            //   untracked   -> dashed only. Nothing is wrong.
            <div key={m.key}
              className={`rounded-xl border p-3 ${
                t === "zero" ? "border-danger/40 bg-danger/5"
                : t === "unknown" ? "hatch border-dashed border-ink/25"
                : t === "untracked" ? "border-dashed border-ink/20"
                : "border-ink/10"}`}>
              <div className={`display flex items-baseline gap-1 text-3xl ${
                t === "zero" ? "text-danger" : isKnown ? "" : "opacity-30"}`}>
                {isKnown ? m.value : EM_DASH}
                {isKnown && m.of != null && m.key === "trained_7d" && (
                  <span className="text-xs font-medium opacity-50">/ {m.of}</span>
                )}
              </div>
              <div className="mt-2 text-[11px] leading-tight opacity-60">{m.label}</div>
              {t !== "known" && (
                <div className={`mt-1.5 text-[9.5px] font-bold uppercase tracking-[0.12em] ${
                  t === "zero" ? "text-danger" : "opacity-50"}`}>
                  {t === "zero" ? "None logged"
                    : t === "unknown" ? "Source unavailable" : "Not tracked"}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   3. ATTENTION QUEUE
   Already ranked. Render in array order — do not re-sort.

   Every action here routes somewhere real. An action whose destination is not
   known is DROPPED, never rendered: these are styled as primary controls with
   44px targets, so a button that does nothing is worse than no button at all.
   --------------------------------------------------------------------------- */
const BAND_LABEL = { act: "Act", watch: "Watch", decide: "Decide", hold: "Hold" };
// Act = danger (needs you now). Decide/Watch = brand. Hold = muted.
// Matches Cockpit band language so urgency is not re-learned per screen.
const BAND_BAR = {
  act: "bg-danger", decide: "bg-brand", watch: "bg-brand/40", hold: "bg-ink/20",
};

// Action key -> destination. `item` is available so an action can target one person.
const ACTION_ROUTES = {
  review_list: () => "/coach/clients",
  open_client: (item) => item.client_id ? `/coach/clients?client=${item.client_id}` : "/coach/clients",
  draft_message: (item) => item.client_id ? `/coach/inbox?client=${item.client_id}` : "/coach/inbox",
  message: (item) => item.client_id ? `/coach/inbox?client=${item.client_id}` : "/coach/inbox",
  adjust_block: () => "/coach/programs",
  open_program: () => "/coach/programs",
};

function AttentionQueue({ attention = [], suppressed = [] }) {
  const withheld = suppressed.reduce((n, s) => n + (s.withheld_count || 0), 0);
  return (
    <Card title="Attention"
      count={attention.length === 0 ? "Nothing ranked" : `${attention.length} ranked`}>
      {attention.length === 0 && suppressed.length === 0 && (
        <Void title="Nothing needs you"
          body="No client is showing a signal that requires a decision today. This is a real result, not a missing one — every feed above is reporting." />
      )}

      {attention.length > 0 && (
        <div className="space-y-2">
          {attention.map((item, i) => {
            const actions = (item.actions ?? []).filter((a) => ACTION_ROUTES[a.key]);
            return (
              <article key={`${item.signal_type}-${item.client_id || i}`}
                className="flex gap-3 rounded-xl border border-ink/10 p-3">
                <span className={`w-1 shrink-0 rounded-full ${BAND_BAR[item.band] || "bg-ink/20"}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="display text-base">{item.display_name}</div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] ${
                      item.band === "act"
                        ? "border-danger/40 text-danger"
                        : item.band === "decide"
                          ? "border-brand/40 text-brand-fg"
                          : "border-ink/15 opacity-60"}`}>
                      {BAND_LABEL[item.band] || item.band}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed opacity-75">{item.mechanism}</p>
                  {item.evidence?.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] opacity-50">
                      {item.evidence.map((e, j) => <span key={j}>{e.label} · {e.value}</span>)}
                    </div>
                  )}
                  {actions.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {actions.map((a) => (
                        <Link key={a.key} to={ACTION_ROUTES[a.key](item)}
                          className={`${a.primary ? "btn-primary" : "btn-ghost"} inline-flex min-h-[44px] items-center`}>
                          {a.label}
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* The safety element. An absence of data is not evidence of an absence of
          work, and this block is what stops the queue's silence being read as
          "everyone is fine". */}
      {suppressed.map((s) => (
        <div key={s.source_key}
          className="hatch mt-2 rounded-xl border border-dashed border-ink/25 p-3">
          <div className="text-xs font-bold">
            {s.withheld_count} {s.withheld_count === 1 ? "signal" : "signals"} withheld
            {" "}{EM_DASH} {SOURCE_LABELS[s.source_key]?.toLowerCase() || s.source_key} unavailable
          </div>
          <p className="mt-1 text-xs leading-relaxed opacity-60">{s.reason}</p>
        </div>
      ))}

      {withheld > 0 && attention.length === 0 && (
        <div className="mt-2">
          <Void tone="unavailable" title="Ranking is paused"
            body="Every candidate signal today came from a source that is not reporting, so nothing has been ranked. Ranking resumes automatically when the sources report healthy." />
        </div>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   4. DECISIONS — roster-derived, so this card never empties because a feed died.

   Each row is a real control. `meal_plan_unreleased` opens an in-page release
   panel rather than routing away: it is the largest pool of finished-but-invisible
   work in the product, and making the coach navigate to find it is what let 18
   plans sit unreleased in the first place.
   --------------------------------------------------------------------------- */
const DECISION_ROUTES = {
  no_meal_plan: "/coach/clients",
  account_unreachable: "/coach/clients",
  paused_no_resume: "/coach/clients",
  // Slice 1: the four onboarding rows open the roster with the Stuck filter already on.
  intakes_unanswered: "/coach/clients?stuck=1",
  released_no_invite: "/coach/clients?stuck=1",
  invites_unclaimed: "/coach/clients?stuck=1",
  never_trained: "/coach/clients?stuck=1",
};

function Decisions({ decisions = [], isPreview }) {
  const [releasing, setReleasing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const unreleased = decisions.find((d) => d.kind === "meal_plan_unreleased");
  // undefined = still loading, null = the read FAILED, [] = genuinely nothing pending.
  // Three different facts. Collapsing "failed" into "empty" is the exact move that lets
  // work disappear silently, so they are kept apart and rendered differently.
  const [pending, setPending] = useState(undefined);

  // The approve entry point is derived from program_drafts directly, NOT from the read
  // model's draft_approval row. Two reasons, both of which would otherwise hide work:
  //   1. that count selects status='draft' only, so a medical hold is counted as zero, and
  //   2. rm_coach_overview drops any decision whose count is 0 before returning.
  // Together those mean a held draft produces no row at all — and a held draft is precisely
  // the one that needs a human. Asking the table directly makes the control appear whenever
  // something is genuinely pending.
  const loadPending = useCallback(() => {
    if (isPreview) { setPending([]); return; }
    listPendingProgramDrafts().then((r) => setPending(r ?? [])).catch(() => setPending(null));
  }, [isPreview]);
  useEffect(() => { loadPending(); }, [loadPending]);

  const pendingCount = pending?.length ?? 0;
  const heldCount = (pending ?? []).filter((d) => d.held).length;
  const rows = [
    // A failed read is reported as its own row, and NOT as a control. Rendering nothing
    // here would be indistinguishable from "no drafts are waiting" — a claim this code
    // cannot make when the query did not answer.
    ...(pending === null ? [{
      kind: "draft_approval_unavailable",
      title: "Program drafts — could not be read",
      detail: "The drafts table did not answer. This is a failed load, not a count of zero — there may be drafts waiting.",
      count: EM_DASH,
    }] : []),
    ...(pendingCount > 0 ? [{
      kind: "draft_approval",
      title: "Program drafts awaiting approval",
      detail: heldCount > 0
        ? `${heldCount === pendingCount ? "All" : heldCount} held for medical review — no plan was auto-generated for ${heldCount === 1 ? "that one" : "those"}.`
        : "Nothing reaches a client until you approve it here.",
      count: pendingCount,
    }] : []),
    ...decisions.filter((d) => d.kind !== "draft_approval"),
  ];

  return (
    <Card title="Decisions" count="Yours to make">
      {rows.length === 0 ? (
        <Void title="Nothing waiting on you"
          body="No drafts, no unclaimed invites, no gaps in assignment." />
      ) : (
        <div className="space-y-2">
          {rows.map((d) => {
            const route = DECISION_ROUTES[d.kind];
            const inner = (
              <>
                <div className="min-w-0">
                  <div className="text-sm font-bold">{d.title}</div>
                  <div className="mt-0.5 text-xs leading-relaxed opacity-60">{d.detail}</div>
                </div>
                <div className="display shrink-0 text-xl">{d.count}</div>
              </>
            );
            const shell = "flex w-full items-center justify-between gap-3 rounded-xl border border-ink/10 p-3 text-left transition hover:bg-ink/[0.04]";

            if (d.kind === "meal_plan_unreleased") {
              return (
                <button key={d.kind} type="button" className={shell}
                  onClick={() => setReleasing((v) => !v)}>
                  {inner}
                </button>
              );
            }
            if (d.kind === "draft_approval") {
              return (
                <button key={d.kind} type="button" className={shell}
                  onClick={() => setReviewing((v) => !v)}>
                  {inner}
                </button>
              );
            }
            if (route) {
              return <Link key={d.kind} to={route} className={shell}>{inner}</Link>;
            }
            // No destination known — render as a plain statement, never as a control.
            return (
              <div key={d.kind}
                className="flex items-center justify-between gap-3 rounded-xl border border-ink/10 p-3">
                {inner}
              </div>
            );
          })}
        </div>
      )}

      <ReminderStatusRow isPreview={isPreview} />

      {releasing && (
        <ReleaseDraftedPlans isPreview={isPreview} expected={unreleased?.count}
          onClose={() => setReleasing(false)} />
      )}

      {reviewing && (
        <ReviewProgramDrafts isPreview={isPreview} drafts={pending}
          onChanged={loadPending} onClose={() => setReviewing(false)} />
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   Slice 2 — one line under Decisions saying what the automated reminders are doing.
   Four states, kept apart so a sending failure is never silent:
     could not be read · all off · on but no sending address · on and sending.
   Shaped by onboarding_reminder_status(); nothing is computed here.
   --------------------------------------------------------------------------- */
function ReminderStatusRow({ isPreview }) {
  const [s, setS] = useState(undefined); // undefined loading · null failed · object loaded
  useEffect(() => {
    if (isPreview) { setS({ any_on: false, sender_email: null, sent_24h: 0, skipped_no_sender_24h: 0 }); return; }
    fetchReminderStatus().then((r) => setS(r ?? null)).catch(() => setS(null));
  }, [isPreview]);
  if (s === undefined) return null;

  let title, detail, count;
  if (s === null) {
    title = "Reminders — could not be read";
    detail = "The status call did not answer. This is a failed load, not a statement that reminders are off.";
    count = EM_DASH;
  } else if (!s.any_on) {
    title = "Reminders off";
    detail = "Nothing automated goes to a client until you turn a switch on in Settings.";
    count = "off";
  } else if (!s.sender_email) {
    title = "Reminders not sent — no sending address set";
    detail = "A switch is on, but there is no address for the email to leave from. Set one in Settings.";
    count = s.skipped_no_sender_24h > 0 ? s.skipped_no_sender_24h : EM_DASH;
  } else {
    title = "Reminders on";
    detail = `Sending from ${s.sender_email}.` + (s.last_run
      ? ` Last run ${new Date(s.last_run.finished_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${s.last_run.healthy ? "healthy" : "reported a problem"}.`
      : " Has not run yet.");
    count = s.sent_24h;
  }
  return (
    <Link to="/coach/settings#set-reminders"
      className="mt-2 flex w-full items-center justify-between gap-3 rounded-xl border border-dashed border-ink/15 p-3 text-left transition hover:bg-ink/[0.04]">
      <div className="min-w-0">
        <div className="text-sm font-bold">{title}</div>
        <div className="mt-0.5 text-xs leading-relaxed opacity-60">{detail}</div>
      </div>
      <div className="display shrink-0 text-xl">{count}</div>
    </Link>
  );
}

/* ---------------------------------------------------------------------------
   Release panel. Publishes a drafted meal plan to its client's Nutrition tab.

   This writes to real client records, so it is deliberately two-step: the first
   click arms a single row, the second commits it. There is no "release all" —
   publishing 18 plans to 18 people on one click is not a thing that should be one
   click away, and each plan is a separate decision about a separate person.
   --------------------------------------------------------------------------- */
function ReleaseDraftedPlans({ isPreview, expected, onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [armed, setArmed] = useState(null);   // clientId awaiting confirmation
  const [busy, setBusy] = useState(null);     // clientId currently writing
  const [done, setDone] = useState([]);       // clientIds released this session

  useEffect(() => {
    // Fixture mode has no database and must never issue a write path. Say so
    // rather than rendering an empty list that reads as "nothing to release".
    if (isPreview) { setRows([]); return; }
    listDraftMealPlans().then(setRows).catch((e) => setErr(e.message || String(e)));
  }, [isPreview]);

  async function commit(clientId) {
    setBusy(clientId); setErr(null);
    try {
      await releaseMealPlan(clientId);
      setDone((d) => [...d, clientId]);
      setArmed(null);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-brand/30 bg-brand/5 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="section-title">Release drafted plans</h3>
        <button type="button" onClick={onClose} className="text-xs opacity-60 hover:opacity-100">
          Close
        </button>
      </div>

      {isPreview ? (
        <p className="mt-2 text-xs leading-relaxed opacity-70">
          Releasing is disabled in preview {EM_DASH} this view is reading a fixture, and a
          release writes to real client records. Open this page signed in to use it.
        </p>
      ) : err ? (
        <p className="mt-2 text-xs text-danger">{err}</p>
      ) : rows === null ? (
        <p className="mt-2 text-xs opacity-60">Loading drafted plans{EM_DASH}</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-xs opacity-70">
          No drafted plans. Every plan on the roster is already visible to its client.
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs leading-relaxed opacity-70">
            Each of these is a finished plan the client cannot see. Releasing publishes it to
            their Nutrition tab immediately.
            {expected != null && rows.length !== expected && (
              <> {" "}Showing {rows.length}; the count above says {expected}.</>
            )}
          </p>
          <ul className="mt-2 space-y-1.5">
            {rows.map((r) => {
              const released = done.includes(r.clientId);
              return (
                <li key={r.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-ink/10 bg-paper/40 p-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{r.displayName}</div>
                    <div className="text-[11px] opacity-55">
                      {r.title || "Untitled plan"}
                      {r.calories ? ` · ${r.calories} kcal` : ""}
                    </div>
                  </div>
                  {released ? (
                    <span className="shrink-0 text-[11px] font-bold uppercase tracking-[0.1em] text-success">
                      Released
                    </span>
                  ) : armed === r.clientId ? (
                    <span className="flex shrink-0 gap-1.5">
                      <button type="button" disabled={busy === r.clientId}
                        onClick={() => commit(r.clientId)}
                        className="btn-primary px-2.5 py-1 text-xs">
                        {busy === r.clientId ? "Releasing…" : "Confirm"}
                      </button>
                      <button type="button" onClick={() => setArmed(null)}
                        className="btn-ghost px-2.5 py-1 text-xs">
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setArmed(r.clientId)}
                      className="btn-ghost shrink-0 px-2.5 py-1 text-xs">
                      Release
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Program draft review. Approves a drafted plan and publishes it to the client.

   This is the control that did not exist. Until it landed, approve_program_draft
   had no caller anywhere in the app: a draft could sit at 'draft' while the coach
   believed it had gone out, with no error and no trail.

   Three rules this panel exists to enforce:
   - Approving writes to a real client record, so it is two-step, one row at a time.
   - Every failure is shown verbatim. approve_program_draft raises loudly on wrong
     role, wrong tenant, non-pending status and on approving an empty medical hold;
     those messages are the coach's diagnosis and must not be swallowed.
   - Success is CONFIRMED, not assumed. The chain is approve -> publish -> programs
     row -> active assignment, and anything short of all four looks identical to
     failure from here. The rows are read back before this reports "Live".
   --------------------------------------------------------------------------- */
function ReviewProgramDrafts({ isPreview, drafts, onChanged, onClose }) {
  const [armed, setArmed] = useState(null);       // draftId awaiting confirmation
  const [busy, setBusy] = useState(null);         // draftId currently writing
  const [err, setErr] = useState(null);
  const [results, setResults] = useState({});     // draftId -> { ok, text }

  async function commit(draft, decision) {
    setBusy(draft.id); setErr(null);
    try {
      const outcome = await decideProgramDraft({ draftId: draft.id, decision });
      if (decision === "reject") {
        setResults((r) => ({ ...r, [draft.id]: { ok: true, text: "Rejected" } }));
      } else {
        // Returned a program id. That is a claim, not a result — go and look.
        const chain = await verifyPublishedChain({
          programId: outcome.program_id, clientId: draft.clientId,
        });
        // publish drops a stale medical-hold placeholder rather than shipping it as a
        // meal plan. That is the right call, but it must never be silent — the client
        // now has a program with no nutrition attached, and only the coach can fix it.
        const note = outcome.nutrition_dropped
          ? "Published with no nutrition plan — the draft still held the medical-hold placeholder, which was dropped rather than sent. Build their plan next."
          : null;
        setResults((r) => ({
          ...r,
          [draft.id]: chain.ok
            ? { ok: true, text: "Live", note }
            : { ok: false, text: chain.detail, note },
        }));
        if (!chain.ok) setErr(`${draft.displayName}: ${chain.detail}`);
      }
      setArmed(null);
      onChanged?.();
    } catch (e) {
      // Surfaced verbatim, and the row is NOT marked done.
      setErr(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-brand/30 bg-brand/5 p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="section-title">Review program drafts</h3>
        <button type="button" onClick={onClose} className="text-xs opacity-60 hover:opacity-100">
          Close
        </button>
      </div>

      {isPreview ? (
        <p className="mt-2 text-xs leading-relaxed opacity-70">
          Approving is disabled in preview {EM_DASH} this view is reading a fixture, and an
          approval publishes a program to a real client. Open this page signed in to use it.
        </p>
      ) : drafts === null ? (
        <p className="mt-2 text-xs text-danger">
          Could not read the drafts table, so nothing is listed. This is a failure to load,
          not an absence of pending drafts {EM_DASH} do not read it as "nothing to approve".
        </p>
      ) : drafts.length === 0 ? (
        <p className="mt-2 text-xs opacity-70">
          No drafts pending. Every generated plan has been approved or rejected.
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs leading-relaxed opacity-70">
            Approving publishes the plan and assigns it to the client immediately {EM_DASH} it
            becomes the program they see when they open the app.
          </p>
          {err && <p className="mt-2 text-xs text-danger">{err}</p>}
          <ul className="mt-2 space-y-1.5">
            {drafts.map((d) => {
              const result = results[d.id];
              // A medical hold with no plan built cannot be approved — the function
              // refuses it. Say so here rather than letting the coach discover it by
              // pressing a button that raises.
              const blocked = d.held && d.dayCount === 0;
              // Approving replaces whatever is currently active, unconditionally (see
              // listPendingProgramDrafts). This is not blocked — a coach may genuinely
              // want to replace an old plan with this draft — but it must never be a
              // surprise, so it is a loud warning rather than a silent swap.
              const hasConflict = !!d.activeProgramName;
              return (
                <li key={d.id}
                  className={`rounded-lg border p-2.5 ${
                    hasConflict ? "border-danger/40 bg-danger/5" : "border-ink/10 bg-paper/40"}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">
                        {d.displayName}
                        {d.held && (
                          <span className="ml-2 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-ink">
                            Medical hold
                          </span>
                        )}
                        {hasConflict && (
                          <span className="ml-2 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-danger">
                            Already has a plan
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[11px] opacity-55">
                        {d.dayCount > 0
                          ? `${d.dayCount} training ${d.dayCount === 1 ? "day" : "days"}`
                          : "No training days — nothing was generated"}
                        {d.healthFlags.length > 0 && ` · flags: ${d.healthFlags.join(", ")}`}
                        {d.generatedAt && ` · ${new Date(d.generatedAt).toLocaleDateString()}`}
                      </div>
                    </div>
                    {result ? (
                      <span className={`shrink-0 text-[11px] font-bold uppercase tracking-[0.1em] ${
                        result.ok ? "text-success" : "text-danger"}`}>
                        {result.text}
                      </span>
                    ) : blocked ? (
                      <Link to={`/coach/clients?client=${d.clientId}`}
                        className="btn-ghost shrink-0 px-2.5 py-1 text-xs">
                        Build plan
                      </Link>
                    ) : armed === d.id ? (
                      <span className="flex shrink-0 gap-1.5">
                        <button type="button" disabled={busy === d.id}
                          onClick={() => commit(d, "approve")}
                          className="btn-primary px-2.5 py-1 text-xs">
                          {busy === d.id ? "Publishing…" : hasConflict ? "Replace it and approve" : "Confirm approve"}
                        </button>
                        <button type="button" disabled={busy === d.id}
                          onClick={() => commit(d, "reject")}
                          className="btn-ghost px-2.5 py-1 text-xs text-danger">
                          Reject
                        </button>
                        <button type="button" onClick={() => setArmed(null)}
                          className="btn-ghost px-2.5 py-1 text-xs">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button type="button" onClick={() => setArmed(d.id)}
                        className="btn-ghost shrink-0 px-2.5 py-1 text-xs">
                        Review
                      </button>
                    )}
                  </div>
                  {blocked && (
                    <p className="mt-1.5 text-[11px] leading-relaxed opacity-60">
                      A health flag was raised, so no plan was generated. Build the plan on
                      their profile first {EM_DASH} approving is refused until one exists.
                    </p>
                  )}
                  {hasConflict && !result && (
                    <p className="mt-1.5 text-[11px] font-medium leading-relaxed text-danger">
                      {d.displayName} already has an active plan, "{d.activeProgramName}"
                      {d.activeAssignedAt && ` (assigned ${new Date(d.activeAssignedAt).toLocaleDateString()})`}.
                      Approving this draft replaces it immediately {EM_DASH} their current
                      plan is not deleted, just deactivated, but the client will see this one instead.
                    </p>
                  )}
                  {result?.note && (
                    <p className="mt-1.5 text-[11px] font-medium leading-relaxed text-ink">
                      {result.note}
                    </p>
                  )}
                  {d.rationale && (
                    <p className="mt-1.5 text-[11px] leading-relaxed opacity-55">{d.rationale}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   5. PREP TIMELINES
   `unavailable` is a declared schema gap, not an empty list — the rail says which
   column is missing and switches itself on when it exists. As of 2026-07-30
   clients.show_date DOES exist and the read model reports unavailable = false, so
   the live rail shows the "no dates set" empty state instead.
   --------------------------------------------------------------------------- */
function PrepTimelines({ timelines = [], unavailable, note }) {
  return (
    <Card title="Prep timelines"
      count={unavailable ? "Unavailable" : `${timelines.length} dated`}>
      {unavailable ? (
        <Void tone="unavailable" title="No dated timelines" body={note} />
      ) : timelines.length === 0 ? (
        <Void title="No dates set"
          body="Nobody on the roster has a show date. Undated clients are excluded from this rail, not ranked lower on it." />
      ) : (
        <div className="space-y-3">
          {timelines.map((tl) => (
            <div key={tl.client_id}>
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-sm font-bold">{tl.display_name}</div>
                <div className="text-[10px] font-bold uppercase tracking-[0.1em] opacity-55">
                  {tl.weeks_out} weeks out
                </div>
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink/10">
                <div className="h-full rounded-full bg-brand"
                  style={{ width: `${Math.max(0, Math.min(100, 100 - tl.weeks_out * 4))}%` }} />
              </div>
              <div className="mt-1 text-[11px] opacity-55">
                {new Date(tl.event_date).toLocaleDateString("en-GB",
                  { day: "numeric", month: "short" })} · {tl.note}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   6. ACTIVITY — the only chronological block, deliberately last and small.
   An empty feed gets the SOLID treatment, not the hatched one: we know, and there
   is nothing. That difference is the whole point.
   --------------------------------------------------------------------------- */
function Activity({ activity = [], sources = [] }) {
  const trainingDown = sources.some(
    (s) => s.key === "training" && (s.state === "unavailable" || s.state === "stale"),
  );
  return (
    <Card title="Activity" count="Last 24h">
      {activity.length === 0 ? (
        <Void tone={trainingDown ? "unavailable" : "empty"}
          title={trainingDown ? "Cannot say" : "Nothing in the last 24 hours"}
          body={trainingDown
            ? "The training feed is not reporting, so an empty activity list here would be misleading rather than informative."
            : "The feed is genuinely empty, not broken. Every source above is reporting."}
          meta={trainingDown ? "Source unavailable" : null} />
      ) : (
        <ul className="divide-y divide-ink/10 text-sm">
          {activity.map((e, i) => (
            <li key={i} className="flex gap-3 py-2">
              <time className="shrink-0 text-xs tabular-nums opacity-45">
                {new Date(e.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              </time>
              <span className="min-w-0"><b>{e.display_name}</b> <span className="opacity-70">{e.summary}</span></span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
   Signals the read model knows about but cannot compute on this schema. Stated
   plainly rather than silently omitted — a missing signal the coach believes is
   running is the same class of error as a false zero.
   --------------------------------------------------------------------------- */
function UnavailableSignals({ items = [] }) {
  if (!items.length) return null;
  return (
    <div className="mt-4">
      <Card title="Not yet computable" count={items.length}>
        <div className="space-y-2">
          {items.map((s) => (
            <div key={s.signal_type} className="rounded-xl border border-ink/10 p-3">
              <div className="text-sm font-bold capitalize">{s.signal_type.replace(/_/g, " ")}</div>
              <p className="mt-0.5 text-xs leading-relaxed opacity-60">{s.reason}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function relativeTime(iso) {
  if (!iso) return "just now";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 90) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 36 * 3600) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86400)} d ago`;
}
