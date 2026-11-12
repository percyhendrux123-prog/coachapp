import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { linkParts, isSameOrigin } from "../lib/linkify";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import AppGate from "../components/AppGate";
import {
  countUnreadCoachMessagesAfter,
  getLatestCoachMessageCursor,
  getMyClient, getMyProgram, listCheckins, submitCheckin,
  listMessages, listResources,
  getCheckinConfig, uploadCheckinPhotos, listMyActivity,
  requestCheckinAssessment, mintMyIntakeToken,
} from "../lib/client";
import { recordActivity } from "../lib/activity";
import { getSession, startSession, listSessionLogs, logSet, closeDay, listHistory, getLastPerformance } from "../lib/workouts";
import { MCP_ENDPOINT, createClientToken, listTokens, revokeToken } from "../lib/connector";
import { claudeInstallUrl } from "../lib/claudeInstall";
import { getTenantBranding } from "../lib/license";
import { getMealPlan, getAssignedMealPlan } from "../lib/mealPlan";
import { getAssignedStructuredPlan, getPlanSlotsWithMeals, summarizePlanMacros, getMealPhotoUrl } from "../lib/clientMealPlan";
import {
  listMealAdherenceForDate, upsertMealAdherence, ymdLocal,
  adherenceLabel, MEAL_ADHERENCE_STATUSES,
} from "../lib/mealAdherence";
import { getClientMonthHistory, monthGrid, ymd, startOfDay } from "../lib/clientHistory";
import { getMyForwardSchedule } from "../lib/clientSchedule";
import { resolveEffectiveDays } from "../lib/effectiveDays";
import { adjustMySchedule, REASON_CHIPS } from "../lib/scheduleAdjustments";
import { getMyConsistency } from "../lib/consistency";
import { getMyProgressTrends } from "../lib/progressTrends";
import { createKeyedWriteQueue } from "../lib/writeQueue";
import TrendChart from "../components/TrendChart";
import { classificationOf } from "../lib/clientType";
import ProgramDayStrip from "../components/ProgramDayStrip";
import DemoVideoPreview, { DemoDisclosure } from "../components/DemoVideoPreview";
import { primaryTabsFor, moreTabsFor, isSelfServeMode } from "../lib/clientTabs";
import { copyFor, NUTRITION_SCOPE_LINE } from "../lib/systemMode";
import AboutPage from "../components/AboutPage";
import ClientVideos from "../components/ClientVideos";
import ClientBrief from "../components/ClientBrief";
import CommunityHub from "../components/CommunityHub";
import FirstRun from "../components/FirstRun";
import StandardCard from "../components/StandardCard";
import { paymentUrlWithCoupon } from "../lib/settings";
import { disablePush, enablePush, pushSupport, supportMessage } from "../lib/push";
import { readOutcome } from "../lib/readOutcome";
import {
  messageLastSeenKey,
  unreadBadgeLabel,
} from "../lib/clientMessagePresence";
import { useClientMessagePresence } from "../lib/useClientMessagePresence";
import { useClientAccountBranding } from "../lib/useClientAccountBranding";
import { whiteLabelOwnedSurfaces } from "../lib/tenantIdentity";
import ClientMessageComposer, { ClientMessageThread } from "../components/ClientMessageComposer";
import SubstituteRequest from "../components/SubstituteRequest";
import { formatHeight, formatWeight, KEEP_CASE } from "../lib/profileDisplay";

const CARDIO_MACHINES_IMAGE = "/assets/cardio-machines.jpg";
const CARDIO_TERMS = [
  "cardio", "conditioning", "finisher", "treadmill", "incline walk", "walk",
  "elliptical", "stair", "bike", "cycle", "recumbent", "rower", "rowing",
  "air bike", "spin bike", "steady", "interval",
];

// Real programs still carry pre-cardio-support entries where "cardio" only exists as a
// name string on an otherwise-strength exercise (e.g. "Finisher: incline walk" with
// target_reps "12 min") — the name heuristic stays as a fallback for those so they keep
// getting the cardio machine image, but a real ex.type: "cardio" always wins first.
function isCardioExercise(ex) {
  if (ex?.type === "cardio") return true;
  const normalized = (ex?.name ?? "").toLowerCase();
  return CARDIO_TERMS.some((term) => normalized.includes(term));
}

const METERS_PER_MILE = 1609.34;
function metersFromDistanceInput(value, unit) {
  if (value === "" || value == null) return "";
  const n = Number(value);
  if (Number.isNaN(n)) return "";
  return unit === "km" ? n * 1000 : n * METERS_PER_MILE;
}
function distanceInputFromMeters(meters, unit) {
  if (meters == null) return "";
  return unit === "km" ? +(meters / 1000).toFixed(2) : +(meters / METERS_PER_MILE).toFixed(2);
}
function formatCardioActual(row) {
  if (!row) return null;
  const parts = [];
  if (row.duration_seconds != null) parts.push(`${Math.round(row.duration_seconds / 60)} min`);
  if (row.distance_meters != null) parts.push(`${(row.distance_meters / 1000).toFixed(2)} km`);
  if (row.rpe != null) parts.push(`RPE ${row.rpe}`);
  return parts.length ? parts.join(", ") : null;
}
// A logged set is either strength (weight x reps) or cardio (duration/distance/RPE),
// distinguished by which fields are actually populated since both share workout_logs.
function formatSetActual(l) {
  const cardio = formatCardioActual(l);
  return cardio ?? `${l.weight ?? "–"}×${l.reps ?? "–"}`;
}

function CardioMachineImage({ compact = false }) {
  return (
    <img
      src={CARDIO_MACHINES_IMAGE}
      alt="Common cardio machine options"
      loading="lazy"
      className={`${compact ? "mt-2 max-h-28" : "mt-2 max-h-36"} w-full rounded-lg border border-ink/10 object-cover`}
    />
  );
}

// Phase 3 client coaching dashboard. Role-gated; RLS scopes everything to this client.
// The tenant's white-label config (welcome/about content, feature flags) drives what
// renders — flags default ON when unset so pre-flag tenants are unchanged.
//
// Shell: primary tabs (Program / Nutrition / Check-in / Brief) + More for the rest.
// Mobile uses a fixed bottom bar with short labels; desktop keeps full labels.
// Videos stay separate from Resources (numbered shelf vs open-file list).
// Tab order and its rationale live in lib/clientTabs.js, shared with
// ClientPreview's mock nav so the two bars cannot drift.
const KNOWN_TABS = new Set([
  "program", "nutrition", "history", "progress", "check-in", "brief", "messages", "activity",
  "videos", "resources", "content", "community", "profile", "settings", "about",
]);
const MORE_TAB_IDS = new Set([
  "messages", "activity", "history", "progress", "videos", "resources", "content", "community", "profile", "settings", "about",
]);

function preferredScrollBehavior() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

function MessageUnreadBadge({ count }) {
  const label = unreadBadgeLabel(count);
  if (!label) return null;
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-danger px-1.5 text-[10px] font-bold leading-none tabular-nums text-paper"
    >
      {label}
    </span>
  );
}

export default function Client() {
  const { user, role, profile, tenant } = useAuth();
  const ownedSurfaces = whiteLabelOwnedSurfaces(tenant);
  const [me, setMe] = useState(null);
  const [meOwnerUserId, setMeOwnerUserId] = useState(null);
  const [meFailed, setMeFailed] = useState(false);
  const [tab, setTab] = useState("program");
  const [moreOpen, setMoreOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const pendingScroll = useRef(null);
  // The More sheet docks on top of the bottom bar. The bar can change height (a wrapped
  // label under the phone's text scaling), so the sheet reads the real height instead of
  // assuming 3.75rem and overlapping it. 60 matches the unscaled bar until the first read.
  const [navEl, setNavEl] = useState(null);
  const [navHeight, setNavHeight] = useState(60);
  const activeTabRef = useRef("program");
  // Bumped by ProgramTab after a schedule adjustment (day swap) saves — TodayStrip
  // sits above ProgramTab on the same screen and fetched its own "today" summary
  // once on mount, so without this it could keep showing the pre-swap day after
  // ProgramTab's own card may already have refreshed to the new one.
  const [scheduleVersion, setScheduleVersion] = useState(0);
  const bumpScheduleVersion = useCallback(() => setScheduleVersion((v) => v + 1), []);

  const resetTabForAccountTransition = useCallback(() => {
    setTab("program");
    setMoreOpen(false);
  }, []);
  const {
    branding,
    brandingState,
    messagingOn,
    reloadBranding: loadBranding,
  } = useClientAccountBranding({
    userId: user?.id,
    role,
    activeTabRef,
    loadBrandingFn: getTenantBranding,
    onAccountTransition: resetTabForAccountTransition,
  });
  const mode = branding?.mode;

  useEffect(() => {
    if (role !== "client" || !user?.id) {
      setMe(null);
      setMeOwnerUserId(null);
      return;
    }
    let cancelled = false;
    const loadingUserId = user.id;
    setMeFailed(false);
    setMe(null);
    setMeOwnerUserId(loadingUserId);
    getMyClient()
      .then((c) => {
        if (cancelled) return;
        setMe(c);
        setMeFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMe(null);
        setMeFailed(true);
      });
    return () => { cancelled = true; };
  }, [role, user?.id]);

  // Deep link: /client?tab=activity (and other tab ids). Settings "See everything…"
  // uses this so the link is a real action, not a no-op refresh of Program.
  useEffect(() => {
    const wanted = searchParams.get("tab");
    if (!wanted) return;
    const allowedOwnedTab = wanted !== "content" || ownedSurfaces.content;
    if (KNOWN_TABS.has(wanted) && allowedOwnedTab) {
      activeTabRef.current = wanted;
      setTab(wanted);
      // The selected More destination is the destination, not the chooser. Keeping
      // the sheet closed prevents a deep link from landing behind a half-screen overlay.
      setMoreOpen(false);
    } else {
      activeTabRef.current = "program";
      setTab("program");
    }
    setSearchParams((p) => { p.delete("tab"); return p; }, { replace: true });
  }, [ownedSurfaces.content, searchParams, setSearchParams]);

  const ownedMe = meOwnerUserId === user?.id ? me : null;
  const messageKey = useMemo(
    () => messageLastSeenKey({ userId: user?.id, clientId: ownedMe?.id }),
    [user?.id, ownedMe?.id],
  );

  const {
    rows: messageRows,
    loadState: messageLoadState,
    readError: messageReadError,
    unreadCount: messageUnreadCount,
    refreshMessages,
  } = useClientMessagePresence({
    messageKey,
    enabled: messagingOn,
    clientId: ownedMe?.id,
    activeTabRef,
    listMessagesFn: listMessages,
    latestCoachCursorFn: getLatestCoachMessageCursor,
    countUnreadFn: countUnreadCoachMessagesAfter,
  });

  useEffect(() => {
    if (!messagingOn && tab === "messages") {
      activeTabRef.current = "program";
      setTab("program");
    }
  }, [messagingOn, tab]);

  // A bookmarked ?tab=brief (or any coach-only tab) must not land a self-serve buyer on a
  // screen that no longer exists for them. Computed locally rather than from the primaryTabs/
  // moreTabs consts below, which are declared after the early returns further down and are
  // not in scope for a hook that (per rules-of-hooks) must sit with the other hooks above them.
  useEffect(() => {
    if (!isSelfServeMode(mode)) return;
    const allowed = new Set([
      ...primaryTabsFor(mode).map((t) => t.id),
      ...moreTabsFor({ mode, messagingOn, ownedContent: ownedSurfaces.content }).map((t) => t.id),
    ]);
    if (!allowed.has(tab)) go("program");
  }, [mode, tab, messagingOn, ownedSurfaces.content]); // eslint-disable-line react-hooks/exhaustive-deps -- go is a plain in-component function, recreated every render; including it would fire this effect on every render

  // Callback ref, not useRef: the bar lives past several early returns, so this has to fire
  // when the node actually mounts rather than on the shell's first render.
  useEffect(() => {
    if (!navEl) return;
    const read = () => setNavHeight(Math.round(navEl.getBoundingClientRect().height) || 60);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(navEl);
    return () => ro.disconnect();
  }, [navEl]);

  useEffect(() => {
    const id = pendingScroll.current;
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    pendingScroll.current = null;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [tab]);

  if (!user) {
    return (
      <AppGate title="Sign in to view your coaching" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
        Your program, meals, and check-ins live here once you’re signed in.
      </AppGate>
    );
  }
  if (role !== "client") {
    return (
      <AppGate title="Client coaching area" actionTo="/coach" actionLabel="Go to coach" secondaryTo="/" secondaryLabel="Home">
        This screen is for coaching clients. Coaches use the coach area.
      </AppGate>
    );
  }
  if (meFailed) {
    return (
      <AppGate title="Could not load your coaching profile" actionTo="/login" actionLabel="Sign in again" secondaryTo="/" secondaryLabel="Home">
        {copyFor(mode, "profile_load_failed")}
      </AppGate>
    );
  }

  const ctx = { clientId: ownedMe?.id, tenantId: profile?.tenant_id };
  const primaryTabs = primaryTabsFor(mode);
  const visibleMessageRows = messageRows;
  const visibleMessageLoadState = messageLoadState;
  const visibleMessageReadError = messageReadError;
  const visibleMessageUnreadCount = messageUnreadCount;
  const moreTabs = moreTabsFor({ mode, messagingOn, ownedContent: ownedSurfaces.content });
  const moreIds = new Set(moreTabs.map((t) => t.id));
  const onMore = moreIds.has(tab);

  function go(id, { scrollTo } = {}) {
    activeTabRef.current = id;
    setTab(id);
    setMoreOpen(false);
    if (id === "messages") refreshMessages({ force: true }).catch(() => {});
    if (scrollTo) {
      pendingScroll.current = scrollTo;
      requestAnimationFrame(() => {
        const el = document.getElementById(scrollTo);
        if (el) {
          pendingScroll.current = null;
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
      return;
    }
    window.scrollTo({ top: 0, behavior: preferredScrollBehavior() });
  }

  if (ownedMe && ownedMe.welcome_seen === false) {
    return (
      <FirstRun
        clientId={ownedMe.id}
        branding={branding}
        onDone={() => setMe((prev) => (prev ? { ...prev, welcome_seen: true } : prev))}
      />
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-5 pb-36 pt-7 sm:px-6 md:pb-12 md:pt-10">
      {tab === "program" && (
        <>
          <div className="flex items-end justify-between gap-3">
            <div>
              <span className="kicker">{branding?.app_name || branding?.coach_display_name || "Coaching"}</span>
              <h1 className="display mt-1 text-3xl">
                {ownedMe?.display_name ? ownedMe.display_name.split(" ")[0] : "Your coaching"}
              </h1>
            </div>
            {/* "entry"/"standard" is coach
                vocabulary — as a bare capitalized word next to the client's name it
                read as an unexplained label. The tier still shows on Profile. */}
          </div>

          {branding?.welcome_message && (
            <p className="glass mt-4 px-4 py-3 text-sm">
              {branding.welcome_message}
              {branding.coach_display_name && (
                <span className="mt-0.5 block text-xs opacity-60">— {branding.coach_display_name}</span>
              )}
            </p>
          )}

          <PayCoach branding={branding} mode={mode} />

          {ctx.clientId && (
            <TodayStrip
              ctx={ctx}
              scheduleVersion={scheduleVersion}
              onProgram={() => go("program", { scrollTo: "client-program" })}
              onNutrition={() => go("nutrition", { scrollTo: "client-nutrition" })}
              onCheckin={() => go("check-in", { scrollTo: "client-checkin" })}
              mode={mode}
            />
          )}
        </>
      )}

      {/* Desktop / tablet primary strip */}
      <nav
        aria-label="Client navigation"
        className="mt-5 hidden border-b border-ink/10 text-sm md:flex md:flex-wrap md:gap-x-4 md:gap-y-1"
      >
        {primaryTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => go(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={`-mb-px border-b-2 pb-2 transition ${
              tab === t.id ? "border-brand font-bold" : "border-transparent font-medium opacity-60 hover:opacity-80"
            }`}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-label={visibleMessageUnreadCount > 0 ? `More, ${visibleMessageUnreadCount} unread messages` : "More"}
          aria-expanded={moreOpen}
          aria-controls="client-more-nav"
          className={`-mb-px border-b-2 pb-2 transition ${
            onMore || moreOpen ? "border-brand font-bold" : "border-transparent font-medium opacity-60 hover:opacity-80"
          }`}
        >
          <span className="inline-flex items-center gap-1.5">
            More
            <MessageUnreadBadge count={visibleMessageUnreadCount} />
          </span>
        </button>
      </nav>

      {/* Desktop / tablet More — in-flow flex wrap (no dangling empty grid cells) */}
      {moreOpen && (
        <div id="client-more-nav" className="mt-3 hidden flex-wrap gap-2 md:flex">
          {moreTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => go(t.id)}
              aria-label={t.id === "messages" && visibleMessageUnreadCount > 0 ? `Messages, ${visibleMessageUnreadCount} unread` : t.label}
              aria-current={tab === t.id ? "page" : undefined}
              className={`grow-0 basis-[7.5rem] rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition min-h-[44px] ${
                tab === t.id
                  ? "border-brand bg-brand/10 text-ink"
                  : "border-ink/10 bg-ink/[0.03] opacity-80 hover:opacity-100"
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span>{t.label}</span>
                {t.id === "messages" && <MessageUnreadBadge count={visibleMessageUnreadCount} />}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-6">
        {tab === "brief" && (
          <ClientBrief
            branding={branding}
            state={brandingState}
            onRetry={loadBranding}
            showPrepDesk={classificationOf(me) === "prep"}
            showKnowledge={ownedSurfaces.knowledge}
          />
        )}
        {tab === "program" && (
          <div id="client-program" className="scroll-mt-24">
            <ProgramTab key={`${ctx.tenantId}:${ctx.clientId}`} ctx={ctx} onOpenHistory={() => go("history")} onScheduleAdjusted={bumpScheduleVersion} mode={mode} messagingOn={messagingOn} />
          </div>
        )}
        {tab === "nutrition" && (
          <div id="client-nutrition" className="scroll-mt-24">
            <NutritionTab ctx={ctx} client={ownedMe} mode={mode} />
          </div>
        )}
        {tab === "history" && <HistoryTab ctx={ctx} onOpenProgram={() => go("program")} />}
        {tab === "progress" && <ProgressTab ctx={ctx} />}
        {tab === "check-in" && (
          <div id="client-checkin" className="scroll-mt-24">
            <CheckinTab ctx={ctx} branding={branding} mode={mode} />
          </div>
        )}
        {tab === "messages" && messagingOn && (
          <MessagesTab
            key={`${ctx.tenantId}:${ctx.clientId}`}
            ctx={ctx}
            rows={visibleMessageRows}
            loadState={visibleMessageLoadState}
            readError={visibleMessageReadError}
            reload={refreshMessages}
          />
        )}
        {tab === "activity" && <ActivityTab />}
        {tab === "videos" && <ClientVideos ctx={ctx} />}
        {tab === "resources" && <ResourcesTab />}
        {tab === "content" && ownedSurfaces.content && <ContentTab />}
        {tab === "community" && <CommunityHub ctx={ctx} brand={branding} />}
        {tab === "profile" && (
          <ProfileTab me={ownedMe} branding={branding} userEmail={user.email} ctx={ctx} userId={user.id} mode={mode} />
        )}
        {tab === "about" && <AboutPage branding={branding} />}
        {tab === "settings" && (
          <SettingsTab
            email={user?.email}
            client={ownedMe}
            onClient={(next) => setMe(next)}
            onOpenActivity={() => go("activity")}
            mode={mode}
          />
        )}
      </div>

      {/* Mobile More sheet — docks above the fixed bar so it doesn't shove page content.
          Its offset is measured from the bar rather than hardcoded at 3.75rem, because the
          bar is now allowed to grow a line taller when the phone's text scaling demands it.
          A scrim sits under it so the page behind (often a half-finished check-in form)
          reads as backgrounded, not as live content the sheet happens to float over —
          tapping the scrim closes, same as tapping More again. */}
      {moreOpen && (
        <button
          type="button"
          aria-label="Close More"
          onClick={() => setMoreOpen(false)}
          style={{ bottom: `${navHeight}px` }}
          className="fixed inset-x-0 top-0 z-30 cursor-default bg-ink/45 backdrop-blur-[2px] md:hidden"
        />
      )}
      {moreOpen && (
        <div
          id="client-more-nav-mobile"
          role="region"
          aria-label="More client tools"
          style={{ bottom: `${navHeight}px` }}
          className="fixed inset-x-0 z-40 max-h-[min(50vh,22rem)] overflow-y-auto border-t border-ink/10 bg-paper/98 px-3 py-3 shadow-[0_-8px_24px_rgba(0,0,0,0.08)] backdrop-blur-md md:hidden"
        >
          <div className="mx-auto mb-2 flex max-w-2xl items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-[0.12em] opacity-60">More</span>
            <button
              type="button"
              onClick={() => setMoreOpen(false)}
              className="min-h-[36px] rounded-lg px-3 text-xs font-semibold opacity-60 hover:opacity-100"
            >
              Close
            </button>
          </div>
          <div className="mx-auto grid max-w-2xl grid-cols-2 gap-2">
            {moreTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => go(t.id)}
                aria-label={t.id === "messages" && visibleMessageUnreadCount > 0 ? `Messages, ${visibleMessageUnreadCount} unread` : t.label}
                aria-current={tab === t.id ? "page" : undefined}
                className={`min-h-[44px] rounded-xl border px-3 py-3 text-left text-sm font-semibold transition ${
                  tab === t.id
                    ? "border-brand bg-brand/10 text-ink"
                    : "border-ink/10 bg-ink/[0.03] opacity-80"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span>{t.label}</span>
                  {t.id === "messages" && <MessageUnreadBadge count={visibleMessageUnreadCount} />}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mobile bottom nav — short labels so five items fit narrow phones.
          whitespace-nowrap used to live on these buttons, which meant that when the phone's
          own text scaling pushed a label past its share of the row (Android at 200%: "Check"
          overruns by 22px), the glyphs ran straight over the neighbouring tab. A label is now
          allowed to take a second line, and break-words catches the single word that still
          will not fit, so tabs crowd their own box instead of each other's. */}
      <nav
        ref={setNavEl}
        className="fixed inset-x-0 bottom-0 z-50 border-t border-ink/10 bg-paper/95 px-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-md md:hidden"
        aria-label="Client navigation"
      >
        <div className="mx-auto flex max-w-2xl items-stretch justify-between gap-0.5">
          {primaryTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => go(t.id)}
              aria-label={t.label}
              aria-current={tab === t.id ? "page" : undefined}
              className={`relative flex min-h-[52px] min-w-0 flex-1 items-center justify-center break-words px-0.5 py-2 text-center text-[11px] font-semibold leading-tight transition ${
                tab === t.id && !moreOpen
                  ? "text-ink after:absolute after:inset-x-3 after:top-0 after:h-0.5 after:rounded-full after:bg-brand"
                  : "text-ink/55"
              }`}
            >
              {t.short}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-label={visibleMessageUnreadCount > 0 ? `More, ${visibleMessageUnreadCount} unread messages` : "More"}
            aria-expanded={moreOpen}
            aria-controls="client-more-nav-mobile"
            className={`relative flex min-h-[52px] min-w-0 flex-1 items-center justify-center break-words px-0.5 py-2 text-center text-[11px] font-semibold leading-tight transition ${
              onMore || moreOpen
                ? "text-ink after:absolute after:inset-x-3 after:top-0 after:h-0.5 after:rounded-full after:bg-brand"
                : "text-ink/55"
            }`}
          >
            <span className="inline-flex items-center gap-1">
              More
              <MessageUnreadBadge count={visibleMessageUnreadCount} />
            </span>
          </button>
        </div>
      </nav>
    </main>
  );
}

/** Compact “today” card — program day + meal slots. Not a second program UI. */
function TodayStrip({ ctx, scheduleVersion, onProgram, onNutrition, onCheckin, mode }) {
  const [pack, setPack] = useState(undefined);

  // scheduleVersion is a dependency, not read inside — it exists purely so a bump
  // from ProgramTab's onAdjusted (a same-screen schedule swap) forces this effect
  // to refetch. Without it this strip only ever loaded once on mount and could
  // keep showing the pre-swap day after the card below it had already refreshed
  // Keep both views consistent.
  const load = useCallback(() => {
    let cancelled = false;
    void scheduleVersion; // referenced only so the dependency below isn't "unnecessary" to the linter
    setPack(undefined);
    (async () => {
      try {
        const [programRead, structuredRead, legacyRead] = await Promise.all([
          readOutcome(getMyProgram()),
          readOutcome(ctx.clientId ? getAssignedStructuredPlan(ctx.clientId) : Promise.resolve(null)),
          readOutcome(ctx.clientId ? getAssignedMealPlan(ctx.clientId) : Promise.resolve(null)),
        ]);
        const programFailed = programRead.state === "failed";
        const mealsFailed = structuredRead.state === "failed" || legacyRead.state === "failed";
        const program = programRead.state === "ready" ? programRead.value : null;
        const structured = structuredRead.state === "ready" ? structuredRead.value : null;
        const legacyMeal = legacyRead.state === "ready" ? legacyRead.value : null;
        let mealSlots = 0;
        let mealLogged = 0;
        if (structured?.id) {
          const day = ymdLocal();
          // Plans store identical days; day_index 0 is the assigned template (see clientMealPlan.js).
          const slots = await getPlanSlotsWithMeals(structured.id, 0).catch(() => []);
          mealSlots = Array.isArray(slots) ? slots.length : 0;
          const logs = await listMealAdherenceForDate(day).catch(() => []);
          mealLogged = (logs ?? []).filter((l) => l.status === "logged" || l.status === "fallback").length;
        } else if (legacyMeal) {
          const meals = Array.isArray(legacyMeal.meals) ? legacyMeal.meals : [];
          mealSlots = meals.length || 1;
          const day = ymdLocal();
          const logs = await listMealAdherenceForDate(day).catch(() => []);
          mealLogged = (logs ?? []).filter((l) => l.status === "logged" || l.status === "fallback").length;
        }
        if (cancelled) return;
        const { days } = resolveEffectiveDays(program?.program, program?.assignment);
        const activeIndex = program?.assignment?.current_day_index ?? 0;
        const day = days[activeIndex];
        const exCount = Array.isArray(day?.groups)
          ? day.groups.reduce((n, g) => n + (g.exercises?.length ?? 0), 0)
          : 0;
        setPack({
          hasProgram: Boolean(program),
          programName: program?.program?.name ?? null,
          dayLabel: day?.name || day?.label || (program ? `Day ${activeIndex + 1}` : null),
          dayNum: program ? activeIndex + 1 : null,
          dayTotal: days.length || null,
          exCount,
          mealSlots,
          mealLogged,
          hasMeals: mealSlots > 0,
          programFailed,
          mealsFailed,
        });
      } catch {
        if (!cancelled) setPack(null);
      }
    })();
    return () => { cancelled = true; };
  }, [ctx.clientId, scheduleVersion]);

  useEffect(() => load(), [load]);

  if (pack === undefined) {
    return (
      <div className="mt-5 overflow-hidden rounded-2xl bg-ink px-5 py-6 text-paper" aria-live="polite">
        <div className="h-3 w-24 animate-pulse rounded-full bg-paper/20" />
        <div className="mt-4 h-8 w-2/3 animate-pulse rounded-lg bg-paper/15" />
        <div className="mt-6 h-12 w-full animate-pulse rounded-xl bg-paper/10" />
      </div>
    );
  }
  if (!pack) return null;

  const noProgram = !pack.hasProgram;
  const noMeals = !pack.hasMeals;

  return (
    <section className="mt-5 select-none overflow-hidden rounded-2xl bg-ink text-paper shadow-[0_20px_60px_-34px_rgba(10,10,10,0.7)]">
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-paper/60">
              Today{pack.dayNum != null && pack.dayTotal != null ? ` · Day ${pack.dayNum} of ${pack.dayTotal}` : ""}
            </span>
            <h2 className="display mt-2 text-2xl sm:text-3xl">
            {pack.programFailed ? "Program unavailable" : noProgram ? "No program yet" : pack.dayLabel}
            </h2>
          {pack.hasProgram && (
            <p className="mt-2 text-sm leading-relaxed text-paper/65">
              {pack.programName && <span>{pack.programName}</span>}
              {pack.programName && pack.exCount > 0 ? <span aria-hidden="true"> · </span> : null}
              {pack.exCount > 0 ? <span>{pack.exCount} exercises</span> : null}
            </p>
          )}
          {pack.programFailed ? (
            <p className="mt-2 text-sm text-danger">Could not verify today&apos;s program.</p>
          ) : noProgram && (
            <p className="mt-2 text-sm text-paper/65">{copyFor(mode, "no_program")}</p>
          )}
          </div>
        </div>

        <div className="mt-6 grid gap-2 sm:grid-cols-3">
        {pack.hasProgram && (
          <button type="button" onClick={onProgram} className="inline-flex min-h-[48px] items-center justify-center rounded-xl bg-paper px-4 py-2 text-sm font-bold text-ink transition-transform active:scale-[0.98] sm:col-span-3">
            Open workout
          </button>
        )}
        {pack.mealsFailed ? (
          <span className="flex min-h-[48px] items-center rounded-xl border border-dashed border-danger/50 px-3 py-2 text-xs text-danger">
            Could not verify meals
          </span>
        ) : pack.hasMeals ? (
          <button type="button" onClick={onNutrition} className="flex min-h-[48px] items-center justify-between rounded-xl border border-paper/15 bg-paper/[0.06] px-3 py-2 text-left text-sm transition-colors hover:bg-paper/10 active:bg-paper/15 sm:col-span-2">
            <span>{pack.mealLogged >= pack.mealSlots ? "Meals complete" : "Meals"}</span>
            <span className="font-bold tabular-nums">{pack.mealLogged}/{pack.mealSlots}</span>
          </button>
        ) : (
          <span className="flex min-h-[48px] items-center rounded-xl border border-dashed border-paper/20 px-3 py-2 text-xs text-paper/55 sm:col-span-2">
            No meal plan assigned
          </span>
        )}
        <button type="button" onClick={onCheckin} className="min-h-[48px] rounded-xl border border-paper/15 bg-paper/[0.06] px-3 py-2 text-sm font-semibold transition-colors hover:bg-paper/10 active:bg-paper/15">
          Check-in
        </button>
        {(pack.programFailed || pack.mealsFailed) && (
          <button type="button" onClick={load} className="min-h-[48px] rounded-xl border border-paper/20 px-3 py-2 text-sm font-semibold">
            Retry
          </button>
        )}
        </div>
      </div>

      {noMeals && noProgram && !pack.programFailed && !pack.mealsFailed && (
        <p className="border-t border-paper/10 px-5 py-4 text-xs text-paper/60 sm:px-6">{copyFor(mode, "nothing_assigned")}</p>
      )}
    </section>
  );
}

// Optional, collapsed: a client can point their own AI at their own data. Two levels —
// read-only, or "read + relay" (comms): the AI can also message the coach, flag issues,
// log sets and complete the current day ON the client's behalf. It can never change the
// program or nutrition plan — that stays the coach's.
// This block is the entire client AI surface.
function AIOptIn({ ctx, userId, mode, appName }) {
  // One-tap path (2026-09-04): Anthropic's prefill link opens Claude's "Add custom
  // connector" dialog with our name + address already in it. The name is the tenant's own
  // app name (white-label), never the platform owner's for a coached tenant.
  const installUrl = claudeInstallUrl({ name: appName || "My coaching app", endpoint: MCP_ENDPOINT });
  const [tokens, setTokens] = useState([]);
  const [scope, setScope] = useState("read");
  const [reveal, setReveal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const load = useCallback(() => listTokens().then(setTokens).catch(() => {}), []);
  useEffect(() => { if (ctx.clientId) load(); }, [ctx.clientId, load]);
  const active = tokens.filter((t) => !t.revoked_at);

  async function create() {
    setErr(null); setBusy(true);
    // Self-serve tenants have no coach — message_coach/flag_issue would write into a
    // messages row nobody will ever read (CoachInbox is only reachable by a signed-in
    // coach, and this tenant has none), and the DB trigger refuses 'comms' there outright.
    // 'owner' (full control) is self-serve-only for the same reason, DB-enforced. Clamped
    // here regardless of UI state, not just hidden below, so a stale scope value can never
    // actually request an option this tenant doesn't offer.
    const effectiveScope = isSelfServeMode(mode) ? (scope === "owner" ? "owner" : "read") : scope;
    try { setReveal(await createClientToken({ tenantId: ctx.tenantId, clientId: ctx.clientId, userId, label: "My AI", scope: effectiveScope })); await load(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <details className="glass mt-6 p-4 text-sm">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide opacity-60">
        Connect your own AI
      </summary>
      <p className="mt-2 max-w-lg text-xs opacity-70">{copyFor(mode, "ai_optin_body")}</p>
      {/* Primary path (2026-09-03): no token to copy. Claude opens our sign-in page; the buyer
          enters their email, the 6-digit code, and picks read / full there. */}
      {installUrl && (
        <a href={installUrl} target="_blank" rel="noreferrer" className="btn-primary mt-3 inline-block px-3 py-1.5 text-xs">
          Connect to Claude
        </a>
      )}
      <ol className="mt-3 max-w-lg list-decimal space-y-1 pl-5 text-xs opacity-80">
        <li>Press <b>Connect to Claude</b>. Claude opens with this app already filled in — press <b>Continue</b> there.</li>
        <li>Sign in with this email, enter the code, choose what your AI may do. Done.</li>
      </ol>
      <details className="mt-2 max-w-lg text-xs opacity-70">
        <summary className="cursor-pointer">Using ChatGPT or another AI? Add it by hand.</summary>
        <p className="mt-1">
          In that AI's settings, add a custom connector with this address:{" "}
          <code className="rounded bg-paper px-1">{MCP_ENDPOINT}</code>
          <button type="button" onClick={() => navigator.clipboard?.writeText(MCP_ENDPOINT).catch(() => {})} className="ml-2 rounded-md border border-ink/15 px-2 py-0.5">copy</button>
        </p>
      </details>
      <p className="mt-3 text-xs font-semibold uppercase tracking-wide opacity-60">Advanced · create a code by hand</p>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={scope === "read"} onChange={() => setScope("read")} /> read-only
        </label>
        {!isSelfServeMode(mode) && (
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={scope === "comms"} onChange={() => setScope("comms")} /> read + relay
          </label>
        )}
        {isSelfServeMode(mode) && (
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={scope === "owner"} onChange={() => setScope("owner")} /> full control
          </label>
        )}
      </div>
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
      {reveal && (
        <div
          role="status"
          className="mt-3 rounded-lg border border-brand/40 bg-brand/10 p-3 text-xs"
        >
          <p className="font-medium">Copy this token now — it won&apos;t be shown again.</p>
          <code className="mt-1 block overflow-x-auto rounded bg-paper px-2 py-1 font-mono">{reveal}</code>
          <p className="mt-2 opacity-80">Endpoint: <code className="rounded bg-paper px-1">{MCP_ENDPOINT}</code> — add it as a custom
            connector in your AI app with header <code className="rounded bg-paper px-1">authorization: Bearer &lt;token&gt;</code>.</p>
          <button type="button" onClick={() => setReveal(null)} className="mt-2 rounded-md border border-ink/15 px-2 py-1">Done</button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={create} disabled={busy || !ctx.clientId} className="rounded-md bg-brand px-3 py-1.5 text-xs text-brand-text">
          {busy ? "Creating…" : scope === "comms" ? "Create read + relay token" : scope === "owner" ? "Create full-control token" : "Create read-only token"}
        </button>
        {active.map((t) => (
          <span key={t.id} className="flex items-center gap-2 text-xs opacity-70">
            {t.label} · {t.scope === "comms" ? "read + relay" : t.scope === "owner" ? "full control" : "read-only"} · {t.last_used_at ? `used ${new Date(t.last_used_at).toLocaleDateString()}` : "never used"}
            <button type="button" onClick={async () => { if (confirm(`Revoke "${t.label}"? This AI loses access immediately.`)) { await revokeToken(t.id); await load(); } }} className="text-danger hover:underline">revoke</button>
          </span>
        ))}
      </div>
    </details>
  );
}

function ProgramTab({ ctx, onOpenHistory, onScheduleAdjusted, mode, messagingOn = false }) {
  const [data, setData] = useState(undefined);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  // viewIndex = which program day is on screen (any day). activeIndex stays assignment progress.
  const [viewIndex, setViewIndex] = useState(null);
  const load = useCallback(
    () => getMyProgram()
      .then((d) => { setFailed(false); setData(d); })
      .catch(() => { setFailed(true); setData(null); }),
    [],
  );
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (data?.assignment && viewIndex == null) {
      setViewIndex(data.assignment.current_day_index ?? 0);
    }
  }, [data, viewIndex]);

  if (data === undefined) return <Muted>Loading…</Muted>;
  if (failed) {
    return (
      <EmptyState
        title="Could not load your program"
        body={copyFor(mode, "program_load_failed")}
        actionLabel="Retry program"
        onAction={load}
      />
    );
  }
  if (!data) {
    return (
      <EmptyState
        title="No program assigned yet"
        body={copyFor(mode, "no_program_title_body")}
      />
    );
  }
  const { assignment, program } = data;
  // Reordered per assignment.day_order (a client schedule adjustment) when set,
  // else the program's own order — see effectiveDays.js. current_day_index always
  // indexes into THIS resolved order.
  const { days } = resolveEffectiveDays(program, assignment);
  const activeIndex = assignment.current_day_index ?? 0;
  const idx = viewIndex == null ? activeIndex : Math.min(Math.max(0, viewIndex), Math.max(0, days.length - 1));
  const day = days[idx];
  const isActiveDay = idx === activeIndex;
  const isPastDay = idx < activeIndex;
  const isFutureDay = idx > activeIndex;
  const hasLaterDays = days.length - activeIndex - 1 > 0;

  async function onClosed(res) {
    setNotice(res?.cycled ? "Block complete — nice work. Starting your next cycle from day 1." : null);
    const next = await getMyProgram().catch(() => null);
    setData(next);
    if (next?.assignment) setViewIndex(next.assignment.current_day_index ?? 0);
  }

  async function onAdjusted() {
    setAdjustOpen(false);
    setNotice(null);
    const next = await getMyProgram().catch(() => null);
    setData(next);
    if (next?.assignment) setViewIndex(next.assignment.current_day_index ?? 0);
    // Tells TodayStrip (a sibling above this tab) it needs to refetch too — see
    // that component's own comment.
    onScheduleAdjusted?.();
  }

  return (
    <div>
      <span className="kicker">
        {isActiveDay ? "Today’s work" : isPastDay ? "Earlier day" : "Looking ahead"}
        {" · "}Day {idx + 1} of {days.length}
      </span>
      <h2 className="display mt-1 text-xl sm:text-2xl">{program?.name ?? "Your program"}</h2>
      <p className="mt-1 text-xs opacity-60">
        Browse every day in your block. You can only start and finish the day marked <b>Now</b>.
      </p>

      <div className="mt-4">
        <ProgramDayStrip
          days={days}
          viewIndex={idx}
          activeIndex={activeIndex}
          onSelect={setViewIndex}
        />
      </div>

      {/* Quiet, not primary — a convenience for the days ahead, not the screen's main
          action. Only offered from today's own card, and only when there's a later day
          in the block to trade with. */}
      {isActiveDay && hasLaterDays && (
        <button
          type="button"
          onClick={() => setAdjustOpen(true)}
          className="mt-3 text-xs font-semibold underline opacity-60 hover:opacity-90"
        >
          Can&apos;t do this today? Adjust schedule
        </button>
      )}

      {notice && (
        <>
          <p className="mt-2 rounded-lg bg-ink/5 px-3 py-2 text-sm">{notice}</p>
          {isSelfServeMode(mode) && <StandardCard compact />}
        </>
      )}

      {isFutureDay && (
        <p className="mt-3 rounded-lg border border-ink/10 bg-ink/[0.02] px-3 py-2 text-xs opacity-70">
          Preview only — this day isn&apos;t unlocked yet. Your current day is Day {activeIndex + 1}.
        </p>
      )}
      {isPastDay && (
        <p className="mt-3 rounded-lg border border-ink/10 bg-ink/[0.02] px-3 py-2 text-xs opacity-70">
          Looking back — sets you logged show here when available. Logging is on History too.
        </p>
      )}

      {day ? (
        <SubstituteRequest key={`${ctx.tenantId}:${ctx.clientId}`} ctx={ctx}
          enabled={!!ctx.clientId && !!ctx.tenantId && messagingOn && !isSelfServeMode(mode)}>
          {(ask, reportWorkoutError) => (
            <DayCard
              key={`${assignment.id}:${day.day_id}:${idx}`}
              day={day}
              assignment={assignment}
              ctx={ctx}
              onClosed={onClosed}
              interactive={isActiveDay}
              onAskSubstitute={ask}
              onWorkoutError={reportWorkoutError}
            />
          )}
        </SubstituteRequest>
      ) : (
        <Muted>Program details are being finalized.</Muted>
      )}

      <div className="mt-8 rounded-xl border border-ink/10 p-4 text-sm">
        <p className="font-medium">Finished work lives on History</p>
        <p className="mt-1 text-xs opacity-60">
          History is your log book — workouts, meals, and check-in days. Only sessions you finish land there.
        </p>
        {onOpenHistory && (
          <button type="button" onClick={onOpenHistory} className="btn-primary mt-3 px-3 py-1.5 text-xs">
            Open History
          </button>
        )}
      </div>

      {adjustOpen && (
        <AdjustScheduleSheet
          days={days}
          activeIndex={activeIndex}
          assignmentId={assignment.id}
          onClose={() => setAdjustOpen(false)}
          onAdjusted={onAdjusted}
          mode={mode}
        />
      )}
    </div>
  );
}

// Bottom sheet: swap today's day with one later day in the block. Single swap per
// interaction (no drag-to-reorder — that's a fast follow, not v1). Two steps: pick
// the day, plain-language preview + confirm; then an optional, structured reason —
// Skip is a real, equally-weighted button, not a dark pattern (no
// "are you sure," no streak-shaming).
function AdjustScheduleSheet({ days, activeIndex, assignmentId, onClose, onAdjusted, mode }) {
  const [pickedIdx, setPickedIdx] = useState(null);
  const [step, setStep] = useState("pick"); // "pick" | "reason"
  const [reasonTag, setReasonTag] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const todayDay = days[activeIndex];
  const remaining = days
    .map((d, i) => ({ day: d, index: i }))
    .filter(({ index }) => index > activeIndex);

  // A swap always displaces TODAY's slot (activeIndex) — if today's own session
  // already has logged sets, swapping it away would strand that progress the same
  // way an inactive-assignment swap can. Checked before the picker
  // is ever shown, not after a target is chosen. Tri-state, not a
  // plain boolean: undefined = still checking (never flashes "free to swap" before
  // the real read lands), "failed" = a failed read, which fails CLOSED — an unknown
  // state is never treated as "safe."
  const [startedCheck, setStartedCheck] = useState(undefined); // undefined | { started: boolean } | "failed"

  const checkStarted = useCallback(() => {
    if (!todayDay?.day_id) { setStartedCheck({ started: false }); return; }
    setStartedCheck(undefined);
    getSession({ assignmentId, dayId: todayDay.day_id })
      .then((s) => (s ? listSessionLogs(s.id) : Promise.resolve([])))
      .then((logs) => setStartedCheck({ started: (logs ?? []).length > 0 }))
      .catch(() => setStartedCheck("failed"));
  }, [assignmentId, todayDay?.day_id]);

  useEffect(() => { checkStarted(); }, [checkStarted]);

  async function confirmSwap(reasonTagValue, noteValue) {
    if (pickedIdx == null) return;
    // Defense in depth — the picker UI below is already gated on startedCheck, but
    // this guards the write itself against ever firing if that state changed out
    // from under the sheet (e.g. a set was logged in another tab mid-flow).
    if (startedCheck?.started) { setErr("You've already started this day — finish it, or its log stays behind."); return; }
    setBusy(true);
    setErr(null);
    try {
      const dayIds = days.map((d) => d.day_id);
      const newOrder = [...dayIds];
      [newOrder[activeIndex], newOrder[pickedIdx]] = [newOrder[pickedIdx], newOrder[activeIndex]];
      await adjustMySchedule({
        assignmentId,
        newOrder,
        reasonTag: reasonTagValue || null,
        reasonNote: (noteValue || "").trim() || null,
      });
      await onAdjusted();
    } catch (e) {
      setErr(e.message || "Could not save this change. Try again.");
      setBusy(false);
    }
  }

  const picked = pickedIdx != null ? days[pickedIdx] : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Adjust schedule"
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center"
    >
      <div className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-paper p-5 sm:rounded-2xl">
        {step === "pick" && (
          <>
            <div className="flex items-center justify-between">
              <h3 className="display text-lg">Adjust schedule</h3>
              <button type="button" onClick={onClose} className="text-xs font-semibold opacity-60">Close</button>
            </div>
            <p className="mt-1 text-xs opacity-60">{copyFor(mode, "schedule_swap_note")}</p>

            {startedCheck === undefined ? (
              <p className="mt-4 text-xs opacity-60">Checking today&apos;s progress…</p>
            ) : startedCheck === "failed" ? (
              <p className="mt-4 rounded-xl border border-dashed border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
                Could not verify whether today has already started — failed read, not
                &ldquo;free to swap.&rdquo;
                <button type="button" onClick={checkStarted} className="ml-2 underline">Retry</button>
              </p>
            ) : startedCheck.started ? (
              <p className="mt-4 rounded-xl border border-ink/10 bg-ink/[0.02] px-3 py-3 text-sm">
                You&apos;ve already started this day — finish it, or its log stays behind.
              </p>
            ) : picked == null ? (
              <ul className="mt-4 space-y-2">
                {remaining.map(({ day, index }) => (
                  <li key={day.day_id}>
                    <button
                      type="button"
                      onClick={() => setPickedIdx(index)}
                      className="flex w-full min-h-[44px] items-center justify-between rounded-xl border border-ink/15 px-3 py-2 text-left text-sm hover:bg-ink/[0.03]"
                    >
                      <span>{day.label || (day.kind === "rest" ? "Rest day" : "Training day")}</span>
                      <span className="text-xs opacity-50">Day {index + 1}</span>
                    </button>
                  </li>
                ))}
                {remaining.length === 0 && (
                  <p className="text-xs opacity-60">No later days left in this block to swap with.</p>
                )}
              </ul>
            ) : (
              <div className="mt-4">
                <p className="rounded-xl border border-ink/10 bg-ink/[0.02] px-3 py-3 text-sm">
                  Do <b>{picked.label || "this day"}</b> today — <b>{todayDay?.label || "today's day"}</b> moves
                  to Day {pickedIdx + 1}.
                </p>
                {err && <p className="mt-2 text-sm text-danger">{err}</p>}
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setPickedIdx(null)}
                    disabled={busy}
                    className="min-h-[44px] rounded-xl border border-ink/15 px-4 text-sm font-semibold"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep("reason")}
                    disabled={busy}
                    className="btn-primary min-h-[44px] flex-1 px-4"
                  >
                    Confirm swap
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {step === "reason" && (
          <>
            <h3 className="display text-lg">{copyFor(mode, "schedule_reason_heading")}</h3>
            <p className="mt-1 text-xs opacity-60">Optional. Skipping is fine — it&apos;s recorded either way.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {REASON_CHIPS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setReasonTag((v) => (v === c.value ? null : c.value))}
                  aria-pressed={reasonTag === c.value}
                  className={`min-h-[44px] rounded-full border px-4 text-sm font-semibold transition ${
                    reasonTag === c.value
                      ? "border-ink bg-ink text-paper"
                      : "border-ink/15 bg-paper hover:bg-ink/[0.03]"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <label className="mt-3 block text-xs font-semibold uppercase tracking-wide opacity-60">
              Note (optional)
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={280}
                className="mt-1 w-full rounded-xl border border-ink/15 px-3 py-2 text-sm font-normal normal-case tracking-normal"
                placeholder={copyFor(mode, "schedule_reason_placeholder")}
              />
            </label>
            {err && <p className="mt-2 text-sm text-danger">{err}</p>}
            <div className="mt-4 flex items-center gap-3">
              {/* Skip is exactly as prominent as Confirm — a legitimate choice, not a
                  buried default. Both write the adjustment; only the reason differs. */}
              <button
                type="button"
                onClick={() => confirmSwap(null, null)}
                disabled={busy}
                className="min-h-[44px] flex-1 rounded-xl border border-ink/15 px-4 text-sm font-semibold"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={() => confirmSwap(reasonTag, note)}
                disabled={busy}
                className="btn-primary min-h-[44px] flex-1 px-4"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Day card: interactive only for the assignment's current day; otherwise browse/preview.
const REST_SECONDS = 90;
const DEFAULT_LOG_ROW = { weight: "", reps: "", duration_seconds: "", distance_meters: "", rpe: "", done: false };

// Flatten a day's groups into one ordered list of {exercise, set} steps for the
// focused, one-at-a-time session view. A "straight" group finishes one exercise's
// sets before starting the next; a "superset" group interleaves — set 1 of exercise
// A, set 1 of B, set 2 of A, set 2 of B — matching how the two are meant to be
// performed back-to-back, not sequentially.
function flattenSteps(groups) {
  const steps = [];
  for (const g of groups ?? []) {
    const exs = g.exercises ?? [];
    if (g.type === "superset" && exs.length > 1) {
      const maxSets = Math.max(...exs.map((e) => (e.sets ?? []).length));
      for (let i = 0; i < maxSets; i++) {
        for (const ex of exs) {
          const s = (ex.sets ?? [])[i];
          if (s) steps.push({ exercise: ex, set: s, group: g, partners: exs });
        }
      }
    } else {
      for (const ex of exs) {
        for (const s of ex.sets ?? []) steps.push({ exercise: ex, set: s, group: g, partners: [ex] });
      }
    }
  }
  return steps;
}

function DayCard({ day, assignment, ctx, onClosed, interactive = true, onAskSubstitute, onWorkoutError }) {
  const [session, setSession] = useState(null);
  const [logs, setLogs] = useState({});
  // Mirrors `logs` synchronously (not on React's next render), because two saveSet
  // calls fired close together — e.g. a reps-field blur immediately followed by a
  // Mark-done click — both need to see each other's write when they compute `prev`.
  // Reading from `logs` (state) directly, both calls would capture the SAME
  // pre-update snapshot from the render they closed over, and whichever network
  // write lands last would silently overwrite the other's field with a stale value
  // — observed live: a done:true from the Mark click getting clobbered back to
  // false by a reps-blur's write that started a moment earlier but landed after.
  const logsRef = useRef({});
  // logsReady gates defaultValue inputs so resume does not paint empty fields
  // before session logs arrive (defaultValue only applies on first mount).
  const [logsReady, setLogsReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [failedSave, setFailedSave] = useState(null);
  const failedSavesRef = useRef({});
  const cardActiveRef = useRef(true);
  const isRest = day.kind === "rest";

  useEffect(() => {
    cardActiveRef.current = true;
    return () => { cardActiveRef.current = false; onWorkoutError?.(null); };
  }, [onWorkoutError]);

  function publishSaveErrors() {
    const first = Object.values(failedSavesRef.current)[0] ?? null;
    setFailedSave(first);
    setErr(first?.message ?? null);
    if (cardActiveRef.current) onWorkoutError?.(first);
  }

  function rememberSaveFailure(key, exerciseId, setIndex, values, generation, message) {
    failedSavesRef.current[key] = {
      key, values, pending: false, message,
      retry: () => {
        // A newer blur may already own this set before a Retry click lands.
        if (writeGenRef.current[key] === generation) saveSet(exerciseId, setIndex, values);
      },
    };
  }

  function askButton(exercise) {
    if (!interactive || !onAskSubstitute) return null;
    return (
      <button type="button" className="mt-2 flex min-h-[44px] w-full items-center text-left text-xs font-semibold underline text-brand-fg"
        onClick={(e) => onAskSubstitute({
          key: `${assignment.id}:${day.day_id}:${exercise.exercise_id}`,
          exercise: exercise.name,
          day: day.label || "Training day",
        }, e.currentTarget)}>
        Ask coach for substitute
      </button>
    );
  }

  // Per-set-key write serialization + a generation counter.
  // The queue guarantees two writes for the SAME set can never land on
  // the network out of order; the generation counter guarantees a write's own
  // success/failure handling (advancing the step, reverting on error) only ever acts
  // if nothing newer has been written for that key since — an older failure must
  // never stomp a newer success. One queue instance for the life of this card.
  const writeQueueRef = useRef(null);
  if (writeQueueRef.current === null) writeQueueRef.current = createKeyedWriteQueue();
  const writeGenRef = useRef({});

  // Refs onto the currently-mounted weight/reps inputs, read directly at the moment
  // of a Mark tap — see the Mark button's onPointerDown below for why.
  const wtInputRef = useRef(null);
  const repsInputRef = useRef(null);
  // Set true by a Mark button's onPointerDown, cleared by its own onClick — swallows
  // the native click that follows a pointer tap (mouse) so the toggle doesn't fire
  // twice. Keyboard activation (Enter/Space) never fires pointerdown, so it always
  // reaches onClick untouched.
  const markPointerHandledRef = useRef(false);

  function setLog(key, value) {
    logsRef.current = { ...logsRef.current, [key]: value };
    setLogs(logsRef.current);
  }

  const steps = useMemo(() => flattenSteps(day.groups), [day]);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeInitialized = useRef(false);
  const [restEndsAt, setRestEndsAt] = useState(null); // epoch ms, or null when no rest running
  const [restRemaining, setRestRemaining] = useState(0);
  const [lastPerf, setLastPerf] = useState({}); // exercise_id -> {weight,reps} | null (checked, none) | undefined (loading)

  const stepKey = (st) => `${st.exercise.exercise_id}:${st.set.set_index}`;
  const isStepDone = (st) => !!logs[stepKey(st)]?.done;

  // On first load of a resumed/started session, jump straight to the first
  // not-yet-done step rather than always starting back at step 1 — this only runs
  // once per session load, not on every `logs` update, so it doesn't fight with
  // manual navigation or auto-advance.
  useEffect(() => {
    if (!logsReady || !session || activeInitialized.current || steps.length === 0) return;
    activeInitialized.current = true;
    const firstIncomplete = steps.findIndex((st) => !isStepDone(st));
    setActiveIndex(firstIncomplete === -1 ? steps.length - 1 : firstIncomplete);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logsReady, session, steps]);

  const activeStep = steps[activeIndex] ?? null;

  // Rest-timer countdown, recomputed from a wall-clock end time (not a decrementing
  // counter) so it stays correct across re-renders and tab backgrounding.
  useEffect(() => {
    if (!restEndsAt) { setRestRemaining(0); return; }
    const tick = () => setRestRemaining(Math.max(0, Math.round((restEndsAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [restEndsAt]);

  // Last-time ghost text, fetched lazily per exercise the client actually lands on
  // (not the whole day at once) and cached for the life of this card.
  useEffect(() => {
    if (!interactive || !activeStep || !ctx.clientId) return;
    const exerciseId = activeStep.exercise.exercise_id;
    if (Object.prototype.hasOwnProperty.call(lastPerf, exerciseId)) return;
    setLastPerf((m) => ({ ...m, [exerciseId]: undefined }));
    getLastPerformance({ clientId: ctx.clientId, exerciseId })
      .then((row) => setLastPerf((m) => ({ ...m, [exerciseId]: row ?? null })))
      .catch(() => setLastPerf((m) => ({ ...m, [exerciseId]: null })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStep, interactive, ctx.clientId]);

  useEffect(() => {
    if (isRest) return;
    setLogsReady(false);
    getSession({ assignmentId: assignment.id, dayId: day.day_id })
      .then((s) => s && loadSession(s)).catch(() => { setLogsReady(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment.id, day.day_id]);

  async function loadSession(s) {
    // Load logs before mounting weight/reps inputs so resume shows saved values.
    const rows = await listSessionLogs(s.id);
    logsRef.current = Object.fromEntries(rows.map((r) => [`${r.exercise_id}:${r.set_index}`, r]));
    setLogs(logsRef.current);
    setSession(s);
    setLogsReady(true);
  }

  async function start() {
    if (!interactive) return;
    setErr(null); setBusy(true);
    setLogsReady(false);
    try {
      await loadSession(await startSession({ assignment, dayId: day.day_id, clientId: ctx.clientId, tenantId: ctx.tenantId }));
    } catch (e) { setErr(e.message); setLogsReady(true); } finally { setBusy(false); }
  }

  async function saveSet(exerciseId, setIndex, patch) {
    if (!interactive || !session) return;
    const key = `${exerciseId}:${setIndex}`;
    const myGen = (writeGenRef.current[key] ?? 0) + 1;
    writeGenRef.current[key] = myGen;
    if (failedSavesRef.current[key]) {
      failedSavesRef.current[key] = { ...failedSavesRef.current[key], pending: true };
      publishSaveErrors();
    }

    // Read from the ref, not the `logs` state closure — a weight/reps blur and a
    // Mark-done click can both fire within the same tick, before either's setLogs
    // has been through a render. Reading the ref means the second call always
    // builds on the first call's write instead of a stale pre-write snapshot.
    // "Usable" (not just non-nullish, for defense in depth):
    // a stale revert leaving behind `{}` must not be mistaken for real prior data on
    // the NEXT write, or that next write would send weight:null/reps:null over real
    // server data.
    const prev = logsRef.current[key];
    const hasUsablePrev = !!prev && Object.keys(prev).length > 0;
    const wasDone = !!prev?.done;
    const unresolved = failedSavesRef.current[key];
    // A failed weight blur followed by a successful reps blur must carry both
    // actuals, not silently discard the still-visible weight after the revert.
    // New values supersede older ones. Do not implicitly retry a failed Mark:
    // completion still needs an explicit Mark or Retry, never an Ask/blur.
    const recoveredActuals = Object.fromEntries(Object.entries(unresolved?.values ?? {}).filter(([field]) => field !== "done"));
    const next = { ...(hasUsablePrev ? prev : DEFAULT_LOG_ROW), ...recoveredActuals, ...patch };
    const desired = { ...next, done: Object.hasOwn(patch, "done") ? patch.done : (unresolved?.values.done ?? next.done) };
    setLog(key, next);

    try {
      // Serialized per set-key: this write's own network call cannot
      // start until every earlier write for the SAME set has already settled, so a
      // slow blur-save and a fast Mark-save can never land on the server out of
      // order and leave a stale payload silently winning.
      await writeQueueRef.current.enqueue(key, () => logSet({
        sessionId: session.id, clientId: ctx.clientId, tenantId: ctx.tenantId,
        exerciseId, setIndex, weight: next.weight, reps: next.reps,
        durationSeconds: next.duration_seconds, distanceMeters: next.distance_meters, rpe: next.rpe,
        done: next.done,
      }));
      if (writeGenRef.current[key] === myGen) {
        // Success resolves only this set's failure. Other sets remain visible,
        // including in the modal; they must not disappear behind its inert page.
        if (failedSavesRef.current[key]) {
          if (desired.done === next.done) delete failedSavesRef.current[key];
          else rememberSaveFailure(key, exerciseId, setIndex, desired, myGen, "Set completion is still not saved. Retry or mark the set again.");
          publishSaveErrors();
        }
      }
      // Freshly marked done (not un-marked) — start the rest clock and move on to the
      // next step. Only fires on a real false→true transition, not toggling off; only
      // AFTER the write actually confirms (a failed save can never
      // leave the client staring at the next step); and only if nothing newer has
      // been written for this key since this call started (myGen check) — a slow,
      // now-stale write settling late must not re-trigger an advance that a newer
      // write already handled or superseded.
      if (next.done && !wasDone && writeGenRef.current[key] === myGen) {
        setRestEndsAt(Date.now() + REST_SECONDS * 1000);
        setActiveIndex((i) => Math.min(i + 1, steps.length - 1));
      }
    } catch (e) {
      // Only revert if nothing newer has landed for this key since this call started
      // — an older failure must never stomp a newer success. Revert
      // target is the same "usable" prior state computed above, not a bare `prev ?? {}`.
      if (writeGenRef.current[key] === myGen) {
        setLog(key, hasUsablePrev ? prev : {});
        rememberSaveFailure(key, exerciseId, setIndex, desired, myGen, e.message || "Could not save this input.");
        publishSaveErrors();
      }
    }
  }

  async function finish() {
    if (!interactive) return;
    setErr(null); setBusy(true);
    try {
      const res = await closeDay({ assignmentId: assignment.id, dayId: day.day_id });
      await onClosed(res);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const exercises = (day.groups ?? []).flatMap((g) => g.exercises ?? []);

  if (isRest) {
    return (
      <div className="glass mt-4 p-4">
        <p className="text-sm"><span className="font-bold">{day.label || "Rest day"}</span> — recovery counts as training.</p>
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
        {interactive ? (
          <button onClick={finish} disabled={busy} className="btn-primary mt-3 px-3 py-1.5">
            {busy ? "Saving…" : "Complete rest day"}
          </button>
        ) : (
          <p className="mt-2 text-xs opacity-60">Rest day — open your current day to mark it complete.</p>
        )}
      </div>
    );
  }

  // Preview / past: full exercise list + demos, no start button unless interactive.
  if (!interactive || !session) {
    return (
      <div className="glass mt-4 p-4">
        <p className="display text-base">{day.label || "Training day"}</p>
        {/* The one action this screen exists for, before the browsing material —
            starting must never require scrolling past demo cards.
            The list below is reference, not the path. */}
        {interactive && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button onClick={start} disabled={busy || !ctx.clientId} className="btn-primary min-h-[44px] px-4 py-2">
              {busy ? "Starting…" : "Start workout"}
            </button>
            <span className="text-xs opacity-60">{exercises.length} exercise{exercises.length === 1 ? "" : "s"} below</span>
          </div>
        )}
        <ul className="mt-3 space-y-3">
          {exercises.map((ex) => {
            const isCardio = isCardioExercise(ex);
            return (
              <li key={ex.exercise_id} className="rounded-lg border border-ink/10 bg-paper/60 p-3">
                <div className="flex items-start justify-between gap-2 text-sm">
                  <span className="font-medium">
                    {ex.name}
                    <span className="mt-0.5 block text-xs font-normal opacity-60">
                      {ex.type === "cardio"
                        ? [
                            ex.cardio?.target_duration_min ? `${ex.cardio.target_duration_min} min` : null,
                            ex.cardio?.target_distance ? `${ex.cardio.target_distance} ${ex.cardio.target_distance_unit ?? "mi"}` : null,
                            ex.cardio?.target_intensity_rpe ? `RPE ${ex.cardio.target_intensity_rpe}` : null,
                          ].filter(Boolean).join(" · ") || "cardio"
                        : `${(ex.sets ?? []).length} sets × ${(ex.sets ?? [])[0]?.target_reps ?? "?"}`}
                    </span>
                  </span>
                </div>
                {askButton(ex)}
                <DemoDisclosure url={ex.demo_media_url} label={`${ex.name} demo`} />
                {isCardio && <CardioMachineImage compact />}
                {session && interactive === false && (ex.sets ?? []).some((_, i) => logs[`${ex.exercise_id}:${i}`]) && (
                  <ul className="mt-2 space-y-0.5 text-xs opacity-70">
                    {(ex.sets ?? []).map((s) => {
                      const row = logs[`${ex.exercise_id}:${s.set_index}`];
                      if (!row) return null;
                      return (
                        <li key={s.set_index}>
                          {ex.type === "cardio"
                            ? (formatCardioActual(row) ?? "logged") + (row.done ? " ✓" : "")
                            : `Set ${s.set_index + 1}: ${row.weight ?? "–"} × ${row.reps ?? "–"}${row.done ? " ✓" : ""}`}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      </div>
    );
  }

  if (interactive && session && !logsReady) {
    return (
      <div className="glass mt-4 p-4">
        <p className="display text-base">{day.label || "Training day"}</p>
        <p className="mt-3 text-sm opacity-60">Loading your logged sets…</p>
      </div>
    );
  }

  if (!activeStep) {
    return (
      <div className="glass mt-4 p-4">
        <p className="display text-base">{day.label || "Training day"}</p>
        <p className="mt-3 text-sm opacity-60">No exercises in this day.</p>
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
        <button onClick={finish} disabled={busy} className="btn-primary mt-4 px-3 py-1.5">
          {busy ? "Finishing…" : "Finish workout"}
        </button>
      </div>
    );
  }

  const doneCount = steps.filter(isStepDone).length;
  const ex = activeStep.exercise;
  const s = activeStep.set;
  const row = logs[stepKey(activeStep)] ?? {};
  const setNum = s.set_index + 1;
  const totalSetsForEx = (ex.sets ?? []).length;
  const wtId = `wt-${ex.exercise_id}-${s.set_index}`;
  const repsId = `reps-${ex.exercise_id}-${s.set_index}`;
  const durId = `dur-${ex.exercise_id}-${s.set_index}`;
  const distId = `dist-${ex.exercise_id}-${s.set_index}`;
  const rpeId = `rpe-${ex.exercise_id}-${s.set_index}`;
  const isSuperset = activeStep.group.type === "superset" && activeStep.partners.length > 1;
  const partnerNames = isSuperset ? activeStep.partners.map((p) => p.name) : [];
  const last = lastPerf[ex.exercise_id];
  const allDone = doneCount === steps.length;

  return (
    <div className="glass mt-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="display text-base">{day.label || "Training day"}</p>
        <span className="shrink-0 text-xs font-semibold opacity-60">{doneCount}/{steps.length} sets</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
        <div
          className="h-full rounded-full bg-brand transition-all"
          style={{ width: `${steps.length ? (doneCount / steps.length) * 100 : 0}%` }}
        />
      </div>

      {isSuperset && (
        <p className="mt-3 rounded-lg border border-brand/30 bg-brand/5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-brand-fg">
          Superset — {partnerNames.join(" + ")}
        </p>
      )}

      <div className="mt-3 rounded-lg border border-ink/10 p-3">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">{ex.name}</span>
          {ex.type !== "cardio" && (
            <span className="text-xs font-semibold uppercase tracking-wide opacity-60">Set {setNum} of {totalSetsForEx}</span>
          )}
        </div>
        {askButton(ex)}
        {ex.demo_media_url && (
          <DemoVideoPreview url={ex.demo_media_url} label={`${ex.name} demo`} compact />
        )}
        {isCardioExercise(ex) && <CardioMachineImage compact />}

        {ex.type === "cardio" ? (
          <>
            {last && formatCardioActual(last) && (
              <p className="mt-2 text-xs opacity-60">Last time: {formatCardioActual(last)}</p>
            )}
            <div className="mt-3 rounded-xl border border-ink/10 bg-paper/50 p-3">
              <p className="text-xs font-bold uppercase tracking-wide opacity-60">
                {[
                  ex.cardio?.target_duration_min ? `${ex.cardio.target_duration_min} min target` : null,
                  ex.cardio?.target_distance ? `${ex.cardio.target_distance} ${ex.cardio.target_distance_unit ?? "mi"} target` : null,
                  ex.cardio?.target_intensity_rpe ? `RPE ${ex.cardio.target_intensity_rpe}` : null,
                ].filter(Boolean).join(" · ") || "Cardio"}
              </p>
              {/* Fixed 2x2 grid, not flex-wrap — a fixed column count
                  depends only on viewport width, never on the input values themselves,
                  so a Mark tap's own re-render can never reflow this row mid-interaction. */}
              <div className="mt-2 grid grid-cols-2 items-end gap-2">
                <label htmlFor={durId} className="text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  Minutes
                  <input
                    id={durId}
                    type="number"
                    inputMode="numeric"
                    placeholder={ex.cardio?.target_duration_min != null ? String(ex.cardio.target_duration_min) : "—"}
                    defaultValue={row.duration_seconds != null ? Math.round(row.duration_seconds / 60) : ""}
                    key={durId}
                    onBlur={(e) => saveSet(ex.exercise_id, s.set_index, {
                      duration_seconds: e.target.value === "" ? "" : Number(e.target.value) * 60,
                    })}
                    className="mt-1 min-h-[44px] w-full rounded-xl border border-ink/15 px-3 py-2 text-sm font-normal normal-case tracking-normal opacity-100"
                  />
                </label>
                <label htmlFor={distId} className="text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  {`Distance (${ex.cardio?.target_distance_unit ?? "mi"})`}
                  <input
                    id={distId}
                    type="number"
                    step="0.1"
                    inputMode="decimal"
                    placeholder={ex.cardio?.target_distance != null ? String(ex.cardio.target_distance) : "—"}
                    defaultValue={row.distance_meters != null ? distanceInputFromMeters(row.distance_meters, ex.cardio?.target_distance_unit ?? "mi") : ""}
                    key={distId}
                    onBlur={(e) => saveSet(ex.exercise_id, s.set_index, {
                      distance_meters: metersFromDistanceInput(e.target.value, ex.cardio?.target_distance_unit ?? "mi"),
                    })}
                    className="mt-1 min-h-[44px] w-full rounded-xl border border-ink/15 px-3 py-2 text-sm font-normal normal-case tracking-normal opacity-100"
                  />
                </label>
                <label htmlFor={rpeId} className="text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  RPE
                  <input
                    id={rpeId}
                    type="number"
                    min="1"
                    max="10"
                    inputMode="numeric"
                    placeholder={ex.cardio?.target_intensity_rpe != null ? String(ex.cardio.target_intensity_rpe) : "—"}
                    defaultValue={row.rpe ?? ""}
                    key={rpeId}
                    onBlur={(e) => saveSet(ex.exercise_id, s.set_index, { rpe: e.target.value })}
                    className="mt-1 min-h-[44px] w-full rounded-xl border border-ink/15 px-3 py-2 text-sm font-normal normal-case tracking-normal opacity-100"
                  />
                </label>
                {/* Fires on pointerdown — arrives before the blur/
                    keyboard-collapse reflow a same-motion tap would otherwise race. */}
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    markPointerHandledRef.current = true;
                    saveSet(ex.exercise_id, s.set_index, { done: !row.done });
                  }}
                  onClick={() => {
                    if (markPointerHandledRef.current) { markPointerHandledRef.current = false; return; }
                    saveSet(ex.exercise_id, s.set_index, { done: !row.done });
                  }}
                  aria-pressed={!!row.done}
                  aria-label={row.done ? "Cardio done" : "Mark cardio done"}
                  className={`min-h-[44px] w-full rounded-xl px-3 text-sm font-semibold transition active:scale-[0.98] ${
                    row.done
                      ? "bg-ink text-paper"
                      : "border border-ink/15 bg-paper/60 hover:bg-ink/[0.04]"
                  }`}
                >
                  {row.done ? "Done" : "Mark"}
                </button>
              </div>
              {s.notes && <p className="mt-2 text-xs opacity-60">{s.notes}</p>}
            </div>
          </>
        ) : (
          <>
            {last && (
              <p className="mt-2 text-xs opacity-60">
                Last time: {last.weight ?? "–"} × {last.reps ?? "–"}
              </p>
            )}

            <div className="mt-3 rounded-xl border border-ink/10 bg-paper/50 p-3">
              <p className="text-xs font-bold uppercase tracking-wide opacity-60">Set {setNum}</p>
              {/* Fixed 3-column grid, not flex-wrap — a fixed column
                  count depends only on viewport width, never on the input values
                  themselves, so a Mark tap's own re-render can never reflow this row
                  mid-interaction and shift Mark out from under a landing tap/click. */}
              <div className="mt-2 grid grid-cols-3 items-end gap-2">
                <label htmlFor={wtId} className="text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  Weight
                  <input
                    id={wtId}
                    ref={wtInputRef}
                    type="number"
                    step="0.5"
                    inputMode="decimal"
                    placeholder={s.target_weight != null ? String(s.target_weight) : "—"}
                    defaultValue={row.weight ?? ""}
                    key={wtId}
                    onBlur={(e) => saveSet(ex.exercise_id, s.set_index, { weight: e.target.value })}
                    className="mt-1 min-h-[44px] w-full rounded-xl border border-ink/15 px-3 py-2 text-sm font-normal normal-case tracking-normal opacity-100"
                  />
                </label>
                <label htmlFor={repsId} className="text-[11px] font-semibold uppercase tracking-wide opacity-60">
                  Reps
                  <input
                    id={repsId}
                    ref={repsInputRef}
                    type="number"
                    inputMode="numeric"
                    placeholder={s.target_reps != null ? String(s.target_reps) : "—"}
                    defaultValue={row.reps ?? ""}
                    key={repsId}
                    onBlur={(e) => saveSet(ex.exercise_id, s.set_index, { reps: e.target.value })}
                    className="mt-1 min-h-[44px] w-full rounded-xl border border-ink/15 px-3 py-2 text-sm font-normal normal-case tracking-normal opacity-100"
                  />
                </label>
                {/* Fires on pointerdown, reading both inputs' CURRENT
                    DOM values directly — this arrives before the blur/keyboard-collapse
                    reflow a same-motion "type reps, tap Mark" gesture would otherwise
                    race, and sends one write instead of leaving a separate blur-write to
                    race it. preventDefault suppresses the touch browser's
                    synthesized trailing click; markPointerHandledRef swallows the mouse
                    equivalent so the toggle can't double-fire; a pure keyboard Enter/Space
                    press never fires pointerdown at all, so it always reaches onClick. */}
                <button
                  type="button"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    markPointerHandledRef.current = true;
                    saveSet(ex.exercise_id, s.set_index, {
                      weight: wtInputRef.current?.value ?? row.weight ?? "",
                      reps: repsInputRef.current?.value ?? row.reps ?? "",
                      done: !row.done,
                    });
                  }}
                  onClick={() => {
                    if (markPointerHandledRef.current) { markPointerHandledRef.current = false; return; }
                    saveSet(ex.exercise_id, s.set_index, {
                      weight: wtInputRef.current?.value ?? row.weight ?? "",
                      reps: repsInputRef.current?.value ?? row.reps ?? "",
                      done: !row.done,
                    });
                  }}
                  aria-pressed={!!row.done}
                  aria-label={row.done ? `Set ${setNum} done` : `Mark set ${setNum} done`}
                  className={`min-h-[44px] w-full rounded-xl px-3 text-sm font-semibold transition active:scale-[0.98] ${
                    row.done
                      ? "bg-ink text-paper"
                      : "border border-ink/15 bg-paper/60 hover:bg-ink/[0.04]"
                  }`}
                >
                  {row.done ? "Done" : "Mark"}
                </button>
              </div>
              {s.notes && <p className="mt-2 text-xs opacity-60">{s.notes}</p>}
            </div>
          </>
        )}
      </div>

      {/* Always mounted — an idle empty state at the SAME height,
          not conditionally unmounted, so starting/skipping rest never shifts the
          Back/Next row below it. That mount/unmount was how a rushed second tap
          used to land on "Skip rest" instead of "Next". */}
      <div
        className={`mt-3 flex items-center justify-between rounded-lg border px-3 py-2 transition-opacity ${
          restRemaining > 0 ? "border-ink/10 bg-ink/[0.02] opacity-100" : "invisible border-transparent opacity-0"
        }`}
        aria-hidden={restRemaining <= 0}
      >
        <span className="text-sm font-semibold tabular-nums">
          {restRemaining > 0
            ? `Rest ${Math.floor(restRemaining / 60)}:${String(restRemaining % 60).padStart(2, "0")}`
            : " "}
        </span>
        <button
          type="button"
          onClick={() => setRestEndsAt(null)}
          tabIndex={restRemaining > 0 ? 0 : -1}
          className="text-xs font-semibold underline opacity-60"
        >
          Skip rest
        </button>
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}
          disabled={activeIndex === 0}
          className="min-h-[44px] rounded-xl border border-ink/15 px-3 text-sm font-semibold disabled:opacity-30"
        >
          ‹ Back
        </button>
        <span className="text-xs opacity-60">Step {activeIndex + 1} of {steps.length}</span>
        <button
          type="button"
          onClick={() => setActiveIndex((i) => Math.min(steps.length - 1, i + 1))}
          disabled={activeIndex === steps.length - 1}
          className="min-h-[44px] rounded-xl border border-ink/15 px-3 text-sm font-semibold disabled:opacity-30"
        >
          Next ›
        </button>
      </div>

      {/* Honest finish line — finishing is always allowed with sets
          undone (no gate), but the count is stated plainly rather
          than the screen going silent whenever it isn't a clean sweep. */}
      {allDone ? (
        <p className="mt-3 text-xs font-semibold text-brand-fg">All sets logged — tap Finish workout when you're done.</p>
      ) : (
        <p className="mt-3 text-xs opacity-70">
          {doneCount} of {steps.length} {doneCount === 1 ? "set" : "sets"} marked done will be recorded.
        </p>
      )}
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      {failedSave && <button type="button" disabled={failedSave.pending} onClick={failedSave.retry} className="min-h-[44px] text-sm underline disabled:opacity-50">{failedSave.pending ? "Saving workout input…" : "Retry workout save"}</button>}
      <button onClick={finish} disabled={busy} className="btn-primary mt-4 px-3 py-1.5">
        {busy ? "Finishing…" : "Finish workout"}
      </button>
    </div>
  );
}

// Recent completed sessions under Program (compact). Full calendar is History tab.
function History({ program }) {
  const [rows, setRows] = useState(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    listHistory(8)
      .then((r) => { setFailed(false); setRows(r); })
      .catch(() => { setFailed(true); setRows([]); });
  }, []);
  if (rows === undefined) {
    return <p className="mt-6 text-xs opacity-60">Loading recent finishes…</p>;
  }
  if (failed) {
    return (
      <p className="mt-6 rounded-xl border border-dashed border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
        Could not load recent finishes — failed read, not “none yet.” Check the History tab or try again.
      </p>
    );
  }
  const completed = rows.filter((r) => r.status === "complete");
  if (completed.length === 0) {
    return (
      <p className="mt-6 text-xs opacity-60">
        No finished workouts in this short list yet. Finish a session above, then check the History tab.
      </p>
    );
  }

  const days = Array.isArray(program?.structure?.days) ? program.structure.days : [];
  const dayName = Object.fromEntries(days.map((d) => [d.day_id, d.label]));
  const exName = Object.fromEntries(days.flatMap((d) => (d.groups ?? []).flatMap((g) => (g.exercises ?? []).map((ex) => [ex.exercise_id, ex.name]))));

  return (
    <div className="mt-8">
      <h3 className="section-title">Recent finishes</h3>
      <ul className="mt-2 space-y-2">
        {completed.map((s) => (
          <li key={s.id} className="rounded-lg border border-ink/10 p-3 text-sm">
            <div className="flex justify-between">
              <span className="font-medium">{dayName[s.day_id] ?? "Workout"}</span>
              <span className="opacity-60">{new Date(s.session_date + "T00:00:00").toLocaleDateString()}</span>
            </div>
            {(s.workout_logs ?? []).filter((l) => l.done).length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-xs opacity-70">
                {Object.entries(groupLogs(s.workout_logs)).map(([exId, sets]) => (
                  <li key={exId}>
                    {exName[exId] ?? "(removed exercise)"} — {sets.map(formatSetActual).join(", ")}
                  </li>
                ))}
              </ul>
            ) : (
              // Twin-facts disclosure — "finished" and "finished with
              // nothing logged" are different facts and must read differently, same
              // as HistoryTab's own calendar detail already does.
              <p className="mt-1 text-xs opacity-60">No sets marked done.</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Client History = the log book (workouts, meals, check-ins). No logging buttons here.
// Days until `dateStr` (local midnight), or null if unset/unparseable — never a
// guessed countdown. Mirrors src/lib/peakWeek.js's daysUntil refusal pattern.
function daysUntilDate(dateStr) {
  if (!dateStr) return null;
  const target = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((startOfDay(target).getTime() - startOfDay().getTime()) / 86400000);
}

function HistoryTab({ ctx, onOpenProgram }) {
  const [cursor, setCursor] = useState(() => {
    const d = startOfDay();
    d.setDate(1);
    return d;
  });
  const [pack, setPack] = useState(undefined);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState(() => ymd(new Date()));
  const [program, setProgram] = useState(null);
  const [checkinDates, setCheckinDates] = useState(() => new Set());
  const [checkinMarkersFailed, setCheckinMarkersFailed] = useState(false);
  // Forward schedule (planned days, check-in due dates, block end, show countdown).
  // Tri-state like `pack` above: undefined = loading, null = failed read, object = ready.
  // A failed forward read must never look like "no upcoming schedule" — see the
  // dedicated banner below, matching the house tri-state convention.
  const [forward, setForward] = useState(undefined);
  const [forwardErr, setForwardErr] = useState(null);
  // Consistency isn't keyed to the visible month — it's always "as of today" — so
  // it gets its own single-fetch effect below rather than reloading on month shift.
  const [consistency, setConsistency] = useState(undefined);
  const [consistencyErr, setConsistencyErr] = useState(null);

  const monthKey = `${cursor.getFullYear()}-${cursor.getMonth()}`;
  const { month, cells } = monthGrid(cursor);
  const rangeFrom = ymd(cells[0]);
  const rangeTo = ymd(cells[41]);

  const load = useCallback(() => {
    setErr(null);
    setPack(undefined);
    getClientMonthHistory({ fromDate: cells[0], toDate: cells[41] })
      .then(setPack)
      .catch((e) => { setPack(null); setErr(e.message || String(e)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, rangeFrom, rangeTo]);

  const loadForward = useCallback(() => {
    setForwardErr(null);
    setForward(undefined);
    getMyForwardSchedule({ fromDate: cells[0], toDate: cells[41] })
      .then(setForward)
      .catch((e) => { setForward(null); setForwardErr(e.message || String(e)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, rangeFrom, rangeTo]);

  const loadConsistency = useCallback(() => {
    setConsistencyErr(null);
    setConsistency(undefined);
    getMyConsistency()
      .then(setConsistency)
      .catch((e) => { setConsistency(null); setConsistencyErr(e.message || String(e)); });
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadForward(); }, [loadForward]);
  useEffect(() => { loadConsistency(); }, [loadConsistency]);
  useEffect(() => {
    getMyProgram().then((d) => setProgram(d?.program ?? null)).catch(() => setProgram(null));
  }, []);
  useEffect(() => {
    listCheckins()
      .then((rows) => {
        const s = new Set();
        for (const r of rows ?? []) {
          if (!r.submitted_at) continue;
          const d = new Date(r.submitted_at);
          s.add(ymd(d));
        }
        setCheckinMarkersFailed(false);
        setCheckinDates(s);
      })
      .catch(() => {
        setCheckinMarkersFailed(true);
        setCheckinDates(new Set());
      });
  }, []);

  const days = Array.isArray(program?.structure?.days) ? program.structure.days : [];
  const dayName = Object.fromEntries(days.map((d) => [d.day_id, d.label]));
  const exName = Object.fromEntries(days.flatMap((d) => (d.groups ?? []).flatMap((g) => (g.exercises ?? []).map((ex) => [ex.exercise_id, ex.name]))));

  function shiftMonth(delta) {
    const d = new Date(cursor);
    d.setMonth(d.getMonth() + delta);
    d.setDate(1);
    setCursor(startOfDay(d));
  }

  const monthLabel = month.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const sessionsByDate = pack?.sessionsByDate ?? {};
  const mealsByDate = pack?.mealsByDate ?? {};
  const daySessions = sessionsByDate[selected] ?? [];
  const dayMeals = mealsByDate[selected] ?? [];
  const thisMonth = month.getMonth();
  const selectedHasCheckin = checkinDates.has(selected);

  // Forward-schedule derived lookups. `forward` is undefined while loading and null
  // on a failed read — both resolve to the safe "nothing to show yet" empty shapes
  // below rather than throwing, so the past-history half of this tab keeps working
  // even if the forward read fails.
  const plannedByDate = forward?.planned?.byDate ?? {};
  const plannedState = forward?.planned?.state; // undefined while loading/failed
  const checkinRows = forward?.checkins?.rows ?? [];
  const checkinsState = forward?.checkins?.state;
  const dueByDate = Object.fromEntries(checkinRows.map((r) => [r.due_on, r]));
  const blockEndsOn = forward?.blockEndsOn ?? null;
  const showDate = forward?.showDate ?? null;
  const showDaysOut = daysUntilDate(showDate);
  const selectedPlanned = plannedByDate[selected];
  const selectedDue = dueByDate[selected];
  const isSelectedToday = selected === ymd(new Date());

  return (
    <div>
      <span className="kicker">Calendar</span>
      <h2 className="display mt-1 text-2xl">Calendar</h2>
      <p className="mt-1 text-xs opacity-60">
        Past: finished workouts, meal marks, check-in days. Future: your planned training days and
        check-in due dates. Mark meals on Meals. Train on Train.
      </p>

      {consistency === null && (
        <p className="glass mt-3 px-4 py-3 text-xs text-danger">
          Could not load your consistency — failed read, not zero weeks. {consistencyErr}
          <button type="button" onClick={loadConsistency} className="ml-2 underline">Retry</button>
        </p>
      )}
      {consistency && consistency.state === "not_tracked" && (
        <p className="glass mt-3 px-4 py-3 text-xs opacity-70">
          Consistency isn’t measured yet — no program assigned.
        </p>
      )}
      {consistency && consistency.state === "tracked" && (
        // Three labeled metrics instead of one wrapping sentence. The zeros
        // stay exactly as loud as the streaks — a tracked zero is real signal, and
        // softening it would be motivation, not diagnosis.
        <div className="glass mt-3 grid grid-cols-3 divide-x divide-ink/10 px-1 py-3 text-center">
          <div className="px-2">
            <div className="text-lg font-bold leading-none tabular-nums">{consistency.weekStreak}</div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.08em] opacity-60">{consistency.weekStreak === 1 ? "week at standard" : "weeks at standard"}</div>
          </div>
          <div className="px-2">
            <div className="text-lg font-bold leading-none tabular-nums">{consistency.thisWeek.completed}<span className="text-sm font-normal opacity-60">/{consistency.thisWeek.target}</span></div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.08em] opacity-60">this week</div>
          </div>
          <div className="px-2">
            <div className="text-lg font-bold leading-none tabular-nums">{consistency.last28.completed}<span className="text-sm font-normal opacity-60">/{consistency.last28.target}</span></div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.08em] opacity-60">last 28 days</div>
          </div>
        </div>
      )}

      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      {checkinMarkersFailed && (
        <p className="mt-2 rounded-xl border border-dashed border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
          Check-in day markers could not load — calendar dots may be incomplete, not “no check-ins.”
        </p>
      )}
      {forward === null && (
        <p className="mt-2 rounded-xl border border-dashed border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
          Could not load your upcoming schedule — failed read, not an empty calendar. {forwardErr}
          <button type="button" onClick={loadForward} className="ml-2 underline">Retry</button>
        </p>
      )}
      {forward && plannedState === "not_tracked" && (
        <p className="mt-2 rounded-xl border border-dashed border-ink/25 bg-ink/[0.02] px-3 py-2 text-xs opacity-70">
          No program assigned — planned days aren’t projected.
        </p>
      )}
      {forward && checkinsState === "not_scheduled" && (
        <p className="mt-2 rounded-xl border border-dashed border-ink/25 bg-ink/[0.02] px-3 py-2 text-xs opacity-70">
          No check-in due dates on the calendar yet — you can still check in any time from the Check tab.
        </p>
      )}
      {showDate && showDaysOut != null && showDaysOut >= 0 && (
        <p className="mt-2 inline-block rounded-full bg-brand/10 px-3 py-1 text-xs font-semibold text-brand-fg">
          {forward?.showName || "Show day"} — {showDaysOut === 0 ? "today" : `${showDaysOut} days out`}
        </p>
      )}

      <div className="mt-4 flex items-center justify-between">
        <button type="button" onClick={() => shiftMonth(-1)} className="btn-ghost min-h-[44px] min-w-[44px] px-2.5 py-1 text-sm">←</button>
        <span className="text-sm font-bold">{monthLabel}</span>
        <button type="button" onClick={() => shiftMonth(1)} className="btn-ghost min-h-[44px] min-w-[44px] px-2.5 py-1 text-sm">→</button>
      </div>

      {pack === undefined && <Muted>Loading {monthLabel}…</Muted>}
      {pack === null && (
        <div className="mt-3 rounded-xl border border-dashed border-danger/40 bg-danger/5 p-3 text-sm text-danger" role="alert">
          Could not load {monthLabel}. Prior-month data is not shown here.
          <button type="button" onClick={load} className="ml-2 underline">Retry</button>
        </div>
      )}

      {pack && <>
      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] uppercase opacity-60">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => <div key={w}>{w}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1.5">
        {cells.map((d) => {
          const key = ymd(d);
          // Split "complete" into two different facts (twin-facts
          // rule): a session finished WITH at least one done set is real training
          // signal; a session finished with nothing logged is not — closeDayCore
          // only requires the row to exist, so a rushed/mistaken Finish tap (or a
          // swallowed Mark tap forcing repeated Finish taps) must not read
          // identically to a real workout.
          const cellSessions = sessionsByDate[key] ?? [];
          const hasWReal = cellSessions.some((s) => s.status === "complete" && (s.workout_logs ?? []).some((l) => l.done));
          const hasWEmpty = cellSessions.some((s) => s.status === "complete" && !(s.workout_logs ?? []).some((l) => l.done));
          const hasOpen = cellSessions.some((s) => s.status !== "complete");
          const hasM = (mealsByDate[key] ?? []).length > 0;
          const hasC = checkinDates.has(key);
          const planned = plannedByDate[key];
          // Real session data always wins over a projection — same principle as the
          // coach calendar (schedule.js: "past/present -> real workout_sessions
          // (truth); today/future -> a projection"). Without this, today's cell would
          // show two visually identical hollow-ring dots when a session is already
          // in progress: the real "workout started" marker and the redundant plan.
          const hasPlannedTraining = planned?.kind === "training" && !hasWReal && !hasWEmpty && !hasOpen;
          const isDue = Boolean(dueByDate[key]);
          const isBlockEnd = blockEndsOn === key;
          const isShowDate = showDate === key;
          const inMonth = d.getMonth() === thisMonth;
          const isSel = key === selected;
          // Four marker types: empty-finish is its own distinct fact,
          // not folded into "done".
          // The glance decodes: filled brand = done, muted filled = finished with
          // nothing logged, ring = planned/in progress, diamond = due or milestone.
          const anyDone = hasWReal || hasM || hasC;
          const anyEmptyFinish = hasWEmpty;
          const anyPlanned = (hasOpen && !hasWReal && !hasWEmpty) || hasPlannedTraining;
          const anyMilestone = isDue || isBlockEnd || isShowDate;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelected(key)}
              aria-label={`${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}${hasWReal ? ", workout" : ""}${hasWEmpty ? ", workout finished with nothing logged" : ""}${hasM ? ", meals" : ""}${hasC ? ", check-in" : ""}${hasOpen && !hasWReal && !hasWEmpty ? ", workout in progress" : ""}${hasPlannedTraining ? ", planned training" : ""}${isDue ? ", check-in due" : ""}${isBlockEnd ? ", program block ends" : ""}${isShowDate ? ", show day" : ""}`}
              aria-pressed={isSel}
              className={`flex min-h-[44px] flex-col items-center justify-center rounded-xl border px-0.5 py-2 text-center text-sm transition ${
                isSel ? "border-brand bg-paper shadow-sm" : "border-ink/10 bg-paper/40"
              } ${inMonth ? "" : /* structural month-boundary dimming (matches CoachCalendar),
                deliberately below the 60 text floor — whole-cell de-emphasis, not label text */ "opacity-35"}`}
            >
              <div className="text-sm font-semibold leading-none">{d.getDate()}</div>
              <div className="mt-1.5 flex min-h-[6px] justify-center gap-1">
                {anyDone && <span className="h-1.5 w-1.5 rounded-full bg-brand" title="Done — tap for detail" />}
                {anyEmptyFinish && <span className="h-1.5 w-1.5 rounded-full bg-ink/30" title="Finished, nothing logged — tap for detail" />}
                {anyPlanned && <span className="h-1.5 w-1.5 rounded-full border border-brand" title="Planned or in progress" />}
                {anyMilestone && <span className="h-1.5 w-1.5 rotate-45 border border-ink/60" title="Due or milestone" />}
              </div>
            </button>
          );
        })}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] opacity-60">
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" /> done</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-ink/30" aria-hidden="true" /> finished, nothing logged</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full border border-brand" aria-hidden="true" /> planned or in progress</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rotate-45 border border-ink/60" aria-hidden="true" /> due or milestone</span>
        <span>— tap a day for the detail</span>
      </p>

      <div className="mt-6 space-y-4">
        <h3 className="section-title">
          {new Date(selected + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
        </h3>

        {selectedHasCheckin && (
          <p className="rounded-lg border border-brand/30 bg-brand/5 px-3 py-2 text-xs font-medium text-brand-fg">
            Check-in submitted this day
          </p>
        )}

        {selectedPlanned?.kind === "training" && daySessions.length === 0 && (
          <p className="rounded-lg border border-brand/20 bg-brand/5 px-3 py-2 text-xs font-medium opacity-80">
            Planned: {selectedPlanned.label || "Training"}
          </p>
        )}
        {/* Only offered on today — a swap only ever moves today's day, and only the
            Program tab has the full pick-a-day flow (kept in one place, not
            duplicated here). */}
        {isSelectedToday && selectedPlanned && onOpenProgram && (
          <button
            type="button"
            onClick={onOpenProgram}
            className="text-xs font-semibold underline opacity-60 hover:opacity-90"
          >
            Can&apos;t do this today? Adjust schedule on Program
          </button>
        )}
        {selectedDue && (
          <p className="rounded-lg border border-ink/20 bg-ink/[0.03] px-3 py-2 text-xs font-medium opacity-80">
            Check-in due ({selectedDue.cadence} cadence)
          </p>
        )}
        {blockEndsOn === selected && (
          <p className="rounded-lg border border-dashed border-ink/25 bg-ink/[0.02] px-3 py-2 text-xs opacity-70">
            Program block ends
          </p>
        )}
        {showDate === selected && (
          <p className="rounded-lg border border-ink/25 bg-ink/[0.02] px-3 py-2 text-xs font-medium opacity-80">
            {forward?.showName || "Show day"}
          </p>
        )}

        <div>
          <p className="text-xs font-semibold uppercase opacity-60">Workouts</p>
          {daySessions.length === 0 ? (
            <p className="mt-1 text-sm opacity-60">No session this day. Finish a workout on Program for it to appear.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {daySessions.map((s) => (
                <li key={s.id} className="rounded-lg border border-ink/10 p-3 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{dayName[s.day_id] ?? "Workout"}</span>
                    <span className="text-xs capitalize opacity-60">{s.status}</span>
                  </div>
                  {(s.workout_logs ?? []).filter((l) => l.done).length > 0 ? (
                    <ul className="mt-1 space-y-0.5 text-xs opacity-70">
                      {Object.entries(groupLogs(s.workout_logs)).map(([exId, sets]) => (
                        <li key={exId}>
                          {exName[exId] ?? "(removed exercise)"} — {sets.map(formatSetActual).join(", ")}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs opacity-60">No sets marked done.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="text-xs font-semibold uppercase opacity-60">Meals</p>
          {dayMeals.length === 0 ? (
            <p className="mt-1 text-sm opacity-60">
              No meal marks this day. Log on the Nutrition tab (Logged / Skipped / Backup).
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5 text-sm">
              {dayMeals.map((m) => (
                <li key={m.id} className="flex justify-between rounded-lg border border-ink/10 px-3 py-2">
                  <span>{m.slot_label || `Meal ${m.slot_index + 1}`}</span>
                  <span className="text-xs font-semibold opacity-70">{adherenceLabel(m.status)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      </>}
      {/* ctx reserved for future client-scoped filters */}
      {ctx?.clientId ? null : null}
    </div>
  );
}

const LIFTS_SHOWN = 6;

function ProgressTab() {
  const [trends, setTrends] = useState(undefined); // undefined=loading, null=failed, object=ready
  const [err, setErr] = useState(null);
  const [unitPref, setUnitPref] = useState("imperial");

  const load = useCallback(() => {
    setErr(null);
    setTrends(undefined);
    getMyProgressTrends()
      .then(setTrends)
      .catch((e) => { setTrends(null); setErr(e.message || String(e)); });
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    getMyClient().then((c) => {
      const u = String(c?.unit_pref || "imperial").toLowerCase();
      setUnitPref(u === "metric" || u === "kg" ? "metric" : "imperial");
    }).catch(() => {});
  }, []);

  // No unit conversion here, on purpose. checkins.weight / progress_weights.weight /
  // workout_logs.weight all store the number exactly as the client typed it into a
  // field labeled with their own unit pref (see CheckinTab's `Weight (${weightUnit})`
  // and submitCheckin passing it through raw) — they are display-unit values, not
  // canonical kg. Converting with kgToLb here would double-convert an imperial
  // client's 180 lb into ~397 lb. The pref only picks the label.
  const weightUnit = unitPref === "metric" ? " kg" : " lb";
  const formatWeight = (v) => Math.round(v * 10) / 10;

  return (
    <div>
      <span className="kicker">Progress</span>
      <h2 className="display mt-1 text-2xl">Progress</h2>
      <p className="mt-1 text-xs opacity-60">
        Weight and lift trends, built from what you've already logged on check-ins and workouts.
      </p>

      {trends === undefined && <Muted>Loading…</Muted>}
      {trends === null && (
        <div className="mt-3 rounded-xl border border-dashed border-danger/40 bg-danger/5 p-3 text-sm text-danger" role="alert">
          Could not load your progress — failed read, not empty trends. {err}
          <button type="button" onClick={load} className="ml-2 underline">Retry</button>
        </div>
      )}

      {trends && (
        <>
          <section className="glass mt-4 p-4">
            <h3 className="section-title">Weight</h3>
            {trends.weight.state === "not_tracked" ? (
              <p className="mt-2 text-sm opacity-60">
                No weigh-ins logged yet — weight is recorded with your check-ins.
              </p>
            ) : (
              <div className="mt-2">
                <TrendChart
                  points={trends.weight.points.map((p) => ({ date: p.date, value: formatWeight(p.value) }))}
                  unit={weightUnit}
                />
              </div>
            )}
          </section>

          <section className="mt-4">
            <h3 className="section-title">Lifts</h3>
            {trends.lifts.state === "not_tracked" ? (
              <p className="mt-2 text-sm opacity-60">
                No sets logged yet — lift trends build up as you finish training days.
              </p>
            ) : trends.lifts.series.length === 0 ? (
              <p className="mt-2 text-sm opacity-60">
                Everything logged so far belongs to an earlier program version — nothing from your
                current program yet.
              </p>
            ) : (
              <div className="mt-2 space-y-3">
                {trends.lifts.series.length > LIFTS_SHOWN && (
                  <p className="text-xs opacity-60">
                    Showing your {LIFTS_SHOWN} most-logged lifts of {trends.lifts.series.length}.
                  </p>
                )}
                {trends.lifts.series.slice(0, LIFTS_SHOWN).map((lift) => (
                  <div key={lift.exerciseId} className="glass p-4">
                    <p className="text-sm font-semibold">{lift.label ?? "(exercise)"}</p>
                    <TrendChart
                      points={lift.points.map((p) => ({ date: p.date, value: formatWeight(p.bestWeight) }))}
                      unit={weightUnit}
                    />
                  </div>
                ))}
              </div>
            )}
            {trends.lifts.omittedEarlierExercises > 0 && (
              <p className="mt-2 text-xs opacity-60">
                {trends.lifts.omittedEarlierExercises} earlier-program {trends.lifts.omittedEarlierExercises === 1 ? "exercise isn't" : "exercises aren't"} shown.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function groupLogs(logs) {
  const by = {};
  for (const l of [...(logs ?? [])].sort((a, b) => a.set_index - b.set_index)) {
    if (!l.done) continue;
    (by[l.exercise_id] ??= []).push(l);
  }
  return by;
}

// Check-in form driven by the tenant's published question set (snapshot.checkin).
// Tenants without one get the legacy weight+note form. The tenant feature flags
// (progress_weight_on / progress_photos_on) gate weight + photos on top of the
// question-set config — either switch off hides the feature.
function CheckinTab({ ctx, branding, mode }) {
  const [config, setConfig] = useState(undefined);
  const [rows, setRows] = useState([]);
  const [configFailed, setConfigFailed] = useState(false);
  const [historyState, setHistoryState] = useState("loading");
  const [answers, setAnswers] = useState({});
  const [weight, setWeight] = useState("");
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(false);
  const [unitPref, setUnitPref] = useState("imperial");
  // Non-fatal problems from a check-in that otherwise saved (e.g. the weight row or a
  // photo failing to reach the trend/timeline). Surfaced instead of swallowed.
  const [warnings, setWarnings] = useState([]);

  // Draft autosave: a check-in interrupted by a call or an
  // app switch must not cost the answers. Per-device convenience only — localStorage,
  // guarded, cleared on submit. Photos are files and cannot be drafted; they are the
  // one thing re-picked after an interruption.
  const draftKey = `coachapp-checkin-draft-${ctx.clientId ?? "anon"}`;
  const draftRestored = useRef(false);
  useEffect(() => {
    if (draftRestored.current || !ctx.clientId) return;
    draftRestored.current = true;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (draft && typeof draft === "object") {
        if (typeof draft.weight === "string") setWeight(draft.weight);
        if (draft.answers && typeof draft.answers === "object") setAnswers(draft.answers);
      }
    } catch { /* a broken draft is discarded, never fatal */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot restore per mount
  }, [ctx.clientId]);
  useEffect(() => {
    if (!draftRestored.current) return;
    try {
      const hasContent = weight !== "" || Object.keys(answers).length > 0;
      if (hasContent) localStorage.setItem(draftKey, JSON.stringify({ weight, answers }));
      else localStorage.removeItem(draftKey);
    } catch { /* storage unavailable — the draft convenience simply doesn't apply */ }
  }, [weight, answers, draftKey]);

  const load = useCallback(() => {
    setHistoryState("loading");
    return listCheckins()
      .then((next) => { setRows(next ?? []); setHistoryState("ready"); })
      .catch(() => { setRows([]); setHistoryState("failed"); });
  }, []);
  const loadConfig = useCallback(() => {
    setConfig(undefined);
    setConfigFailed(false);
    return getCheckinConfig()
      .then((next) => { setConfig(next); setConfigFailed(false); })
      .catch(() => { setConfig(null); setConfigFailed(true); });
  }, []);
  useEffect(() => {
    load();
    loadConfig();
    getMyClient().then((c) => {
      const u = String(c?.unit_pref || "imperial").toLowerCase();
      setUnitPref(u === "metric" || u === "kg" ? "metric" : "imperial");
    }).catch(() => {});
  }, [load, loadConfig]);

  const allQuestions = config?.fields?.questions ?? [{ id: "note", text: "How did the week go?", type: "text" }];
  const questions = allQuestions.filter((q) => shouldShowQuestion(q, answers));
  const wantWeight = (config?.fields?.weight ?? true) && branding?.progress_weight_on !== false;
  const wantPhotos = (config?.fields?.photos ?? false) && branding?.progress_photos_on !== false;
  const weightUnit = unitPref === "metric" ? "kg" : "lb";

  // A long form with no length cue reads as bottomless. "X of N" is honest progress:
  // every field is answerable, none is enforced-required (the question config carries
  // no requiredness — inventing one here would be a fabricated rule, not a UX fix).
  const answeredCount =
    questions.filter((q) => {
      const v = answers[q.id];
      if (v == null || v === "") return false;
      if (typeof v === "object") return Object.values(v).some((x) => x != null && x !== "");
      return true;
    }).length + (wantWeight && weight !== "" ? 1 : 0);
  const totalCount = questions.length + (wantWeight ? 1 : 0);

  async function submit(e) {
    e.preventDefault();
    if (configFailed) { setErr("Check-in setup could not be verified. Retry before submitting."); return; }
    setErr(null); setBusy(true);
    try {
      const photoPaths = files.length ? await uploadCheckinPhotos({ tenantId: ctx.tenantId, clientId: ctx.clientId, files }) : [];
      // Only the questions actually shown to him this submit — a stale answer
      // from a question that became hidden (e.g. he fixed a short session
      // count) must never be sent as if he'd answered it.
      const visibleIds = new Set(questions.map((q) => q.id));
      const visibleAnswers = Object.fromEntries(
        Object.entries(answers).filter(([id]) => visibleIds.has(id))
      );
      const res = await submitCheckin({ ...ctx, weight, answers: visibleAnswers, photoPaths });
      recordActivity({
        tenantId: ctx.tenantId,
        clientId: ctx.clientId,
        template: "checkin_submitted",
        detail: { summary: "Check-in submitted from the client app." },
      }).catch((activityErr) => console.error("activity: check-in was not recorded", activityErr));
      // Best-effort, same as above — the check-in is already saved. A failure
      // here (no API key configured yet, a slow model call) means the coach
      // has no read on this check-in yet, not that anything went wrong.
      requestCheckinAssessment(res.id).catch((assessErr) => console.error("checkin-assess: no read generated", assessErr));
      setWarnings(res?.warnings ?? []);
      setAnswers({}); setWeight(""); setFiles([]); setDone(true); await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  if (config === undefined) return <Muted>Loading…</Muted>;

  if (configFailed) return (
    <div className="glass p-4 text-sm text-danger" role="alert">
      Check-in setup could not load. The fallback form is disabled so you do not submit the wrong questions.
      <button type="button" onClick={loadConfig} className="ml-2 underline">Retry</button>
    </div>
  );

  return (
    <div>
      <div className="mb-4">
        <span className="kicker">Check</span>
        <h2 className="display mt-1 text-2xl">Check-in</h2>
        <p className="mt-1 text-xs opacity-60">
          Track your weekly progress against your daily standards.
        </p>
      </div>
      {done ? (
        <div className="glass p-4 text-sm">
          {copyFor(mode, "checkin_sent")} <button onClick={() => { setWarnings([]); setDone(false); }} className="ml-1 underline">Submit another</button>
          {warnings.length > 0 && (
            <ul className="mt-3 space-y-1 border-t border-ink/10 pt-3 text-xs text-danger">
              {warnings.map((w, i) => <li key={i}>{w} {copyFor(mode, "checkin_warning_note")}</li>)}
            </ul>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="glass p-4 space-y-4">
          {isSelfServeMode(mode) && (
            <p className="text-xs opacity-60">{copyFor(mode, "checkin_intro")}</p>
          )}
          <p className="text-xs opacity-60" aria-live="polite">
            {answeredCount} of {totalCount} answered · submit whenever you&apos;re ready
          </p>
          {wantWeight && (
            <Field label={`Weight (${weightUnit})`}>
              <input type="number" step="0.1" value={weight} onChange={(e) => setWeight(e.target.value)}
                placeholder={weightUnit}
                className="w-28 rounded-xl border border-ink/15 px-2 py-1.5 text-sm" />
            </Field>
          )}
          {questions.map((q) => (
            <QuestionInput key={q.id} q={q} value={answers[q.id]} mode={mode}
              onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />
          ))}
          {wantPhotos && (
            <Field label="Progress photos (optional)">
              <input type="file" accept="image/*" multiple onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 4))}
                className="text-xs" />
              {files.length > 0 && <span className="ml-2 text-xs opacity-60">{files.length} selected</span>}
            </Field>
          )}
          {err && <p className="text-sm text-danger">{err}</p>}
          <div>
            <button disabled={busy} className="btn-primary min-h-[44px] px-4 py-2">{busy ? "Sending…" : "Submit check-in"}</button>
            <p className="mt-2 text-[11px] opacity-60">Answers are kept on this device until you submit — safe to step away.</p>
          </div>
        </form>
      )}

      {historyState === "loading" && <Muted>Loading check-in history…</Muted>}
      {historyState === "failed" && (
        <p className="mt-4 rounded-xl border border-dashed border-danger/40 bg-danger/5 p-3 text-sm text-danger" role="alert">
          Check-in history could not load. This is not an empty history.
          <button type="button" onClick={load} className="ml-2 underline">Retry</button>
        </p>
      )}
      {historyState === "ready" && branding?.progress_weight_on !== false && <WeightTrend rows={rows} />}
      {historyState === "ready" && rows.length === 0 && <Muted>No check-ins yet.</Muted>}
      {historyState === "ready" && rows.length > 0 && (
        <ul className="mt-4 space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-lg border border-ink/10 p-3 text-sm">
              <div className="flex justify-between">
                <span>{new Date(r.submitted_at).toLocaleDateString()}</span>
                <span className="opacity-60">{r.weight != null ? `${r.weight}` : "—"} {r.coach_seen ? "· seen" : ""}</span>
              </div>
              <AnswerSummary answers={r.answers} questions={questions} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="mb-1 block text-sm">{label}</label>
      {children}
    </div>
  );
}

// A question can carry show_when: {field, op} to only appear once another
// answer makes it relevant (e.g. "which one did you miss" only once he's
// actually short). Unconditional by default. Unknown ops fail open (shown) —
// a config typo should surface as an extra question, never a silently
// dropped one the client needed to see.
function shouldShowQuestion(q, answers) {
  if (!q.show_when) return true;
  const { field, op } = q.show_when;
  const ref = answers[field];
  if (op === "x_lt_y") {
    if (ref?.done == null || ref?.planned == null) return false;
    return Number(ref.done) < Number(ref.planned);
  }
  return true;
}

// One typed question input. Types: number, scale (1-5), text, x_of_y, choice_detail.
function QuestionInput({ q, value, onChange, mode }) {
  if (q.type === "scale") {
    return (
      <Field label={q.text}>
        <div className="flex gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              aria-pressed={value === n}
              aria-label={`${n} of 5`}
              className={`min-h-[44px] min-w-[44px] rounded-xl text-sm font-semibold ${
                value === n ? "bg-ink text-paper" : "border border-ink/15 hover:bg-ink/[0.03]"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </Field>
    );
  }
  if (q.type === "number") {
    return (
      <Field label={q.text}>
        <input type="number" min={q.min} max={q.max} step={q.step ?? 1} value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          className="w-32 rounded-md border border-ink/15 px-2 py-1.5 text-sm" />
      </Field>
    );
  }
  if (q.type === "x_of_y") {
    const v = value ?? {};
    const set = (k, raw) => onChange({ ...v, [k]: raw === "" ? undefined : Number(raw) });
    return (
      <Field label={q.text}>
        <div className="flex items-center gap-2 text-sm">
          <input type="number" min="0" value={v.done ?? ""} onChange={(e) => set("done", e.target.value)}
            className="w-16 rounded-md border border-ink/15 px-2 py-1.5" />
          <span className="opacity-60">{q.x_label ?? "done"} of</span>
          <input type="number" min="0" value={v.planned ?? ""} onChange={(e) => set("planned", e.target.value)}
            className="w-16 rounded-md border border-ink/15 px-2 py-1.5" />
          <span className="opacity-60">{q.y_label ?? "planned"}</span>
        </div>
      </Field>
    );
  }
  if (q.type === "choice_detail") {
    const v = value ?? {};
    return (
      <Field label={q.text}>
        <div className="flex gap-1.5">
          {(q.options ?? []).map((opt) => (
            <button key={opt} type="button" onClick={() => onChange({ ...v, choice: opt })}
              aria-pressed={v.choice === opt}
              className={`min-h-[44px] rounded-md px-3 py-1.5 text-sm capitalize ${v.choice === opt ? "bg-ink text-paper" : "border border-ink/15 hover:bg-ink/[0.03]"}`}>
              {opt}
            </button>
          ))}
        </div>
        {v.choice === q.detail_on && (
          <textarea value={v.detail ?? ""} onChange={(e) => onChange({ ...v, detail: e.target.value })}
            rows={2} placeholder={q.detail_text ?? copyFor(mode, "checkin_detail_placeholder")}
            className="mt-2 w-full rounded-md border border-ink/10 px-2 py-1.5 text-sm" />
        )}
      </Field>
    );
  }
  // default: text
  return (
    <Field label={q.text}>
      <textarea value={value ?? ""} onChange={(e) => onChange(e.target.value)} rows={2}
        className="w-full rounded-md border border-ink/10 px-2 py-1.5 text-sm" />
    </Field>
  );
}

// Compact history rendering of an answers object against the current question set.
function AnswerSummary({ answers, questions }) {
  if (!answers || Object.keys(answers).length === 0) return null;
  const label = Object.fromEntries(questions.map((q) => [q.id, q.text]));
  const fmt = (v) => {
    if (v == null || v === "") return null;
    if (typeof v === "object") {
      if ("choice" in v) return v.detail ? `${v.choice} — ${v.detail}` : v.choice;
      if ("done" in v || "planned" in v) return `${v.done ?? "?"}/${v.planned ?? "?"}`;
      return JSON.stringify(v);
    }
    return String(v);
  };
  return (
    <ul className="mt-1 space-y-0.5 text-xs opacity-70">
      {Object.entries(answers).map(([k, v]) => {
        const text = fmt(v);
        return text ? <li key={k}><span className="opacity-60">{label[k] ?? k}:</span> {text}</li> : null;
      })}
    </ul>
  );
}

function WeightTrend({ rows }) {
  const pts = rows.filter((r) => r.weight != null).slice(0, 8).reverse();
  if (pts.length < 2) return null;
  const ws = pts.map((p) => Number(p.weight));
  const min = Math.min(...ws), max = Math.max(...ws), span = max - min || 1;
  return (
    <div className="mt-4 flex items-end gap-1 h-16">
      {pts.map((p, i) => (
        <div key={i} className="flex-1 rounded-t bg-ink/70" style={{ height: `${20 + ((Number(p.weight) - min) / span) * 80}%` }} title={`${p.weight}`} />
      ))}
    </div>
  );
}

function MessagesTab({ ctx, rows, loadState, readError, reload }) {
  const [body, setBody] = useState("");

  return (
    <div>
      <span className="kicker">Inbox</span>
      <h2 className="display mt-1 text-2xl">Messages</h2>
      <p className="mt-1 text-xs opacity-60">
        You and your coach. This thread is the record.
      </p>
      <ClientMessageThread rows={rows} loadState={loadState} readError={readError} reload={reload}
        renderBody={(text) => <MessageBody text={text} />} />
      <ClientMessageComposer key={`${ctx.tenantId}:${ctx.clientId}`} ctx={ctx} body={body} setBody={setBody}
        loadState={loadState} reload={reload} />
    </div>
  );
}

// My Nutrition Plan — assigned plan + today's adherence log (logged / skipped / fallback).
function NutritionTab({ ctx, client, mode }) {
  const [plan, setPlan] = useState(undefined); // PDF
  const [meal, setMeal] = useState(undefined); // legacy structured assigned plan
  const [structuredPlan, setStructuredPlan] = useState(undefined); // new-format assigned plan
  const [loadFailed, setLoadFailed] = useState(false);
  const clientClass = client ? classificationOf(client) : "unclassified";
  const isPrep = clientClass === "prep";

  const load = useCallback(() => {
    if (!ctx.clientId || !ctx.tenantId) return;
    setLoadFailed(false);
    setPlan(undefined);
    setMeal(undefined);
    setStructuredPlan(undefined);
    // A fulfilled empty legacy/PDF read cannot prove the structured source is empty.
    // Only show the true empty state when every source answered and none has a plan.
    Promise.allSettled([
      getMealPlan({ tenantId: ctx.tenantId, clientId: ctx.clientId }),
      getAssignedMealPlan(ctx.clientId),
      getAssignedStructuredPlan(ctx.clientId),
    ]).then(([p, m, s]) => {
      const values = [p, m, s].map((r) => (r.status === "fulfilled" ? r.value : null));
      const hasPlan = values.some(Boolean);
      const anyFailed = [p, m, s].some((r) => r.status === "rejected");
      if (!hasPlan && anyFailed) {
        setLoadFailed(true);
        setPlan(null);
        setMeal(null);
        setStructuredPlan(null);
        return;
      }
      setPlan(values[0]);
      setMeal(values[1]);
      setStructuredPlan(values[2]);
    });
  }, [ctx.clientId, ctx.tenantId]);
  useEffect(() => { load(); }, [load]);

  if (plan === undefined || meal === undefined || structuredPlan === undefined) return <Muted>Loading…</Muted>;

  if (loadFailed) {
    return (
      <div className="space-y-4">
        <NutritionDisclaimer mode={mode} />
        <EmptyState
          title="Could not load nutrition"
          body={copyFor(mode, "nutrition_load_failed")}
          actionLabel="Retry nutrition"
          onAction={load}
        />
      </div>
    );
  }

  // One tab, one plan, never both. The
  // structured plan takes precedence when it exists; the legacy view below is untouched
  // for every client who doesn't have one yet.
  if (structuredPlan) {
    return (
      <div className="space-y-4">
        <NutritionDisclaimer mode={mode} />
        <StructuredPlanView clientId={ctx.clientId} tenantId={ctx.tenantId} plan={structuredPlan} tenantMode={mode} />
      </div>
    );
  }

  if (!plan && !meal) {
    return (
      <div className="space-y-4">
        <NutritionDisclaimer mode={mode} />
        <EmptyState
          title="No nutrition plan yet"
          body={copyFor(mode, isPrep ? "nutrition_empty_prep" : "nutrition_empty_lifestyle")}
        />
      </div>
    );
  }

  // Legacy JSON plan and/or PDF — still get day logging (no structured client_meal_plans id).
  // Unreachable for a self-serve buyer in practice: a self-serve tenant's intake always
  // publishes through assemble_client_meal_plan_system (Task A6), so structuredPlan is
  // always set by the time a self-serve buyer's intake has published. Coach copy below is
  // left as-is for the coached path this still serves.
  return (
    <div className="space-y-5">
      <NutritionDisclaimer mode={mode} />
      <SimpleMealLog
        ctx={ctx}
        title={meal?.title ?? "Your nutrition plan"}
        meals={Array.isArray(meal?.meals) ? meal.meals : null}
        macros={meal ? { kcal: meal.calories, p: meal.protein_g, f: meal.fat_g, c: meal.carb_g } : null}
        notes={meal?.notes}
        pdf={plan}
        tenantMode={mode}
      />
    </div>
  );
}

/** Shared log buttons: Logged / Skipped / Backup (fallback plate). Weekly mode stays Good week / Bad week above. */
function MealLogControls({ current, busyKey, slotIndex, onStatus, dayLabel = "This day" }) {
  if (!onStatus) {
    return <p className="mt-2 text-xs opacity-60">Preview only — pick today or a past day to log.</p>;
  }
  return (
    <div className="mt-3 rounded-xl border border-brand/30 bg-brand/5 p-3">
      <p className="text-[11px] font-bold uppercase tracking-wide text-brand-fg">Log · {dayLabel}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {MEAL_ADHERENCE_STATUSES.map((status) => {
          const label = status === "logged" ? "Logged" : status === "skipped" ? "Skipped" : "Backup";
          const active = current === status;
          const busy = busyKey === `${slotIndex}:${status}`;
          return (
            <button
              key={status}
              type="button"
              disabled={!!busyKey}
              onClick={() => onStatus(status)}
              className={`min-h-[44px] rounded-xl px-3 py-2 text-sm font-semibold transition ${
                active ? "bg-ink text-paper" : "border border-ink/15 bg-paper hover:bg-ink/[0.04]"
              } disabled:opacity-40`}
            >
              {busy ? "…" : label}
            </button>
          );
        })}
      </div>
      {current && (
        <p className="mt-2 text-xs opacity-60">Saved as {adherenceLabel(current)}.</p>
      )}
    </div>
  );
}

/**
 * Legacy plan / PDF path: still log each meal slot for the day.
 * plan_id is null (allowed after migration) — unique key is client + date + slot_index.
 */
function SimpleMealLog({ ctx, title, meals, macros, notes, pdf, tenantMode }) {
  const [dayOffset, setDayOffset] = useState(0);
  const [logs, setLogs] = useState({});
  const [logErr, setLogErr] = useState(null);
  const [busyKey, setBusyKey] = useState(null);

  const logDate = useMemo(() => {
    const d = startOfDay();
    d.setDate(d.getDate() + dayOffset);
    return ymd(d);
  }, [dayOffset]);
  const canLog = dayOffset <= 0;
  const labelDate = new Date(logDate + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });

  // Prefer coach-defined meals; otherwise 4 default slots so PDF-only clients can still log.
  const slots = useMemo(() => {
    if (meals?.length) {
      return meals.map((m, i) => {
        const given = typeof m.name === "string" ? m.name.trim() : "";
        // "Meal 1" is not a name, it is the position — whether the coach left the field
        // empty or an import wrote the ordinal into it, the slot is unnamed either way.
        const named = given && given.toLowerCase() !== `meal ${i + 1}` ? given : null;
        return {
          slot_index: i,
          // Written to the adherence row, so it keeps the ordinal fallback: a log always
          // needs some label to read back in History.
          slot_label: given || `Meal ${i + 1}`,
          // Display only. null means the coach never named this slot.
          name: named,
          items: m.items ?? [],
          note: m.note,
          kcal: (m.items ?? []).reduce((s, it) => s + (Number(it.kcal) || 0), 0),
        };
      });
    }
    return ["Breakfast", "Lunch", "Dinner", "Snack"].map((label, i) => ({
      slot_index: i,
      slot_label: label,
      name: label,
      items: [],
      note: null,
      kcal: null,
    }));
  }, [meals]);

  useEffect(() => {
    listMealAdherenceForDate(logDate)
      .then((rows) => setLogs(Object.fromEntries(rows.map((r) => [r.slot_index, r]))))
      .catch((e) => {
        setLogErr(e.message || String(e));
        setLogs({});
      });
  }, [logDate]);

  async function setStatus(slot, status) {
    if (!ctx.clientId || !ctx.tenantId || !canLog) return;
    setLogErr(null);
    setBusyKey(`${slot.slot_index}:${status}`);
    try {
      const row = await upsertMealAdherence({
        tenantId: ctx.tenantId,
        clientId: ctx.clientId,
        planId: null,
        logDate,
        slotIndex: slot.slot_index,
        slotLabel: slot.slot_label,
        status,
        mealId: null,
      });
      setLogs((prev) => ({ ...prev, [slot.slot_index]: row }));
    } catch (e) {
      setLogErr(e.message || String(e));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="glass p-4">
        <span className="kicker">Nutrition</span>
        <h2 className="display mt-1 text-xl sm:text-2xl">{title}</h2>
        {macros && (
          <p className="mt-1 text-xs opacity-60">
            {macros.kcal} kcal · P {macros.p} / F {macros.f} / C {macros.c}
          </p>
        )}
        <p className="mt-2 text-sm opacity-70">
          Mark each meal for the day: <b>Logged</b>, <b>Skipped</b>, or <b>Backup</b>.
        </p>

        <div className="mt-3 flex items-center gap-2">
          <button type="button" onClick={() => setDayOffset((o) => o - 1)}
            className="btn-ghost shrink-0 px-2.5 py-2 text-sm" aria-label="Previous day">←</button>
          <button type="button" onClick={() => setDayOffset(0)}
            className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold ${dayOffset === 0 ? "border-brand" : "border-ink/10"}`}>
            {labelDate}{dayOffset === 0 ? " · Today" : ""}
          </button>
          <button type="button" onClick={() => setDayOffset((o) => Math.min(0, o + 1))}
            disabled={dayOffset >= 0}
            className="btn-ghost shrink-0 px-2.5 py-2 text-sm disabled:opacity-30" aria-label="Next day">→</button>
        </div>
        {logErr && <p className="mt-2 text-xs text-danger">Logging unavailable: {logErr}</p>}
      </div>

      {pdf?.url && (
        <a href={pdf.url} target="_blank" rel="noreferrer"
          className="glass flex items-center justify-between p-4 text-sm transition hover:bg-paper/80">
          <span>
            <span className="font-bold">Plan PDF</span>
            <span className="block text-xs opacity-60">
              Uploaded {pdf.uploadedAt ? new Date(pdf.uploadedAt).toLocaleDateString() : "—"}
            </span>
          </span>
          <span className="btn-primary px-3 py-1.5 text-xs">Open</span>
        </a>
      )}

      <div className="space-y-3">
        {slots.map((slot) => (
          <article key={slot.slot_index} className="glass p-4">
            <div className="flex items-start justify-between gap-3">
              {/* The ordinal is the kicker and the coach's name is the title. When the
                  coach never named the slot, say that instead of printing the ordinal a
                  second time — an unnamed slot is a gap on the coach's side to close, and
                  a card that reads "MEAL 1 / Meal 1" hides it behind a title that looks
                  filled in. */}
              <div className="min-w-0">
                <p className="section-title">Meal {slot.slot_index + 1}</p>
                {slot.name ? (
                  <p className="mt-1 font-bold">{slot.name}</p>
                ) : (
                  <p className="mt-1 text-sm font-medium opacity-60">
                    {copyFor(tenantMode, "meal_slot_unnamed")}
                  </p>
                )}
              </div>
              {slot.kcal != null && (
                <span className="shrink-0 whitespace-nowrap text-xs opacity-60">{slot.kcal} kcal</span>
              )}
            </div>
            {slot.items?.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-sm">
                {slot.items.map((it, ii) => (
                  <li key={ii} className="flex justify-between gap-3">
                    <span>{it.food}{it.qty ? <span className="opacity-60"> · {it.qty}</span> : null}</span>
                    <span className="shrink-0 text-xs opacity-60">{it.kcal} kcal</span>
                  </li>
                ))}
              </ul>
            )}
            {slot.note && <p className="mt-1 text-xs opacity-60">{slot.note}</p>}
            <MealLogControls
              current={logs[slot.slot_index]?.status}
              busyKey={busyKey}
              slotIndex={slot.slot_index}
              dayLabel={labelDate}
              onStatus={canLog ? (status) => setStatus(slot, status) : undefined}
            />
          </article>
        ))}
      </div>
      {notes && <p className="text-xs opacity-60">{notes}</p>}
    </div>
  );
}

// Structured meal plan + day pager for logging (same chrome as Program day strip).
// Plan meals are the same each day; the day strip chooses which calendar date you log against.
function StructuredPlanView({ clientId, tenantId, plan, tenantMode }) {
  const [slots, setSlots] = useState(undefined);
  const [mode, setMode] = useState("good");
  const [logs, setLogs] = useState({});
  const [logErr, setLogErr] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  // offset 0 = today, -1 = yesterday, etc. Browse back/ahead without leaving Nutrition.
  const [dayOffset, setDayOffset] = useState(0);

  const logDate = useMemo(() => {
    const d = startOfDay();
    d.setDate(d.getDate() + dayOffset);
    return ymd(d);
  }, [dayOffset]);

  const canLog = dayOffset <= 0; // today and past only — no future meal logs

  const loadSlots = useCallback(() => {
    setSlots(undefined);
    getPlanSlotsWithMeals(plan.id).then(setSlots).catch(() => setSlots(null));
  }, [plan.id]);
  useEffect(() => { loadSlots(); }, [loadSlots]);
  useEffect(() => {
    listMealAdherenceForDate(logDate)
      .then((rows) => setLogs(Object.fromEntries(rows.map((r) => [r.slot_index, r]))))
      .catch((e) => {
        setLogErr(e.message || String(e));
        setLogs({});
      });
  }, [logDate]);

  if (slots === undefined) return <Muted>Loading…</Muted>;
  if (slots === null) return (
    <EmptyState
      title="Could not read meal plan"
      body="This is a failed load, not a count of zero."
      actionLabel="Retry meals"
      onAction={loadSlots}
    />
  );

  const totals = summarizePlanMacros(slots);
  const dayTotal = mode === "good" ? totals.good : totals.bad;
  const target = plan.target_calories;
  const delta = target != null ? dayTotal.kcal - target : null;
  const labelDate = new Date(logDate + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });

  async function setStatus(slot, status) {
    if (!clientId || !tenantId || !canLog) return;
    setLogErr(null);
    setBusyKey(`${slot.slot_index}:${status}`);
    try {
      const mealId = status === "fallback"
        ? (slot.fallbackMeal?.id ?? slot.meal?.id ?? null)
        : (slot.meal?.id ?? null);
      const row = await upsertMealAdherence({
        tenantId,
        clientId,
        planId: plan.id,
        logDate,
        slotIndex: slot.slot_index,
        slotLabel: slot.slot_label ?? `Meal ${slot.slot_index + 1}`,
        status,
        mealId,
      });
      setLogs((prev) => ({ ...prev, [slot.slot_index]: row }));
    } catch (e) {
      setLogErr(e.message || String(e));
    } finally {
      setBusyKey(null);
    }
  }

  // 7-day strip around today for quick jumps (same visual language as ProgramDayStrip).
  const weekOffsets = [-3, -2, -1, 0, 1, 2, 3];

  return (
    <div className="space-y-4">
      <div className="glass p-4">
        <div className="flex items-center justify-between">
          <span className="font-bold">{plan.title ?? "Your meal plan"}</span>
        </div>
        <p className="mt-1 text-xs opacity-60">Same {slots.length} meals each day — change the day below to log or review.</p>

        <div className="mt-3 flex items-center gap-2">
          <button type="button" onClick={() => setDayOffset((o) => o - 1)}
            className="min-h-[44px] min-w-[44px] shrink-0 rounded-lg border border-ink/15 px-2.5 py-2 text-sm" aria-label="Previous day">←</button>
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-1">
            {weekOffsets.map((off) => {
              const d = startOfDay();
              d.setDate(d.getDate() + off);
              const key = ymd(d);
              const selected = key === logDate;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setDayOffset(off)}
                  className={`min-h-[44px] min-w-[3.5rem] shrink-0 rounded-xl border px-2 py-2 text-center text-[11px] ${
                    selected ? "border-brand bg-paper shadow-sm" : "border-ink/10 bg-paper/40"
                  }`}
                >
                  <div className="text-[10px] uppercase opacity-60">
                    {d.toLocaleDateString(undefined, { weekday: "short" })}
                  </div>
                  <div className="font-semibold">{d.getDate()}</div>
                  {off === 0 && <div className="text-[9px] font-bold uppercase text-brand-fg">Today</div>}
                </button>
              );
            })}
          </div>
          <button type="button" onClick={() => setDayOffset((o) => o + 1)}
            className="min-h-[44px] min-w-[44px] shrink-0 rounded-lg border border-ink/15 px-2.5 py-2 text-sm" aria-label="Next day">→</button>
        </div>
        <p className="mt-2 text-xs opacity-60">
          Viewing <b>{labelDate}</b>
          {!canLog && " · future day is preview only (no logging yet)"}
        </p>

        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => setMode("good")}
            className={mode === "good" ? "btn-primary" : "btn-ghost"}>Good week</button>
          <button type="button" onClick={() => setMode("bad")}
            className={mode === "bad" ? "btn-primary" : "btn-ghost"}>Bad week</button>
        </div>

        <div className="mt-3 flex items-baseline justify-between">
          <span><b className="text-lg">{dayTotal.kcal}</b> <span className="text-xs opacity-60">kcal a day</span></span>
          {target != null && (
            <span className="text-xs opacity-60">
              Target {target}
              {" "}
              <span className={delta > 0 ? "text-danger" : "text-success"}>{delta > 0 ? `${delta} over` : `${-delta} under`}</span>
            </span>
          )}
        </div>
        <p className="mt-1 text-xs opacity-60">P {dayTotal.protein_g}g · F {dayTotal.fat_g}g · C {dayTotal.carb_g}g</p>
      </div>

      <div className="rounded-xl border border-brand/25 bg-brand/5 p-4">
        <p className="text-sm font-bold">Meal log · {labelDate}</p>
        <p className="mt-0.5 text-xs opacity-70">
          {canLog
            ? "On each meal card below: tap Logged, Skipped, or Backup. History keeps the record."
            : "Future days are preview only — switch to today or a past day to log."}
        </p>
        {logErr && (
          <p className="mt-2 text-xs text-danger">Logging unavailable: {logErr}</p>
        )}
        {slots.length === 0 && (
          <p className="mt-2 text-xs text-danger">{copyFor(tenantMode, "no_meal_slots")}</p>
        )}
      </div>

      <div className="space-y-3">
        {slots.map((s) => (
          <MealSlotCard
            key={s.id}
            slot={s}
            mode={mode}
            tenantMode={tenantMode}
            log={logs[s.slot_index]}
            busyKey={busyKey}
            dayLabel={labelDate}
            onStatus={canLog ? (status) => setStatus(s, status) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function MealSlotCard({ slot, mode, tenantMode, log, busyKey, onStatus, dayLabel }) {
  const meal = slot.meal;
  if (!meal) return null;
  const holds = !slot.fallbackMeal;
  const activeMeal = mode === "bad" ? (holds ? meal : slot.fallbackMeal) : meal;
  const activeServings = mode === "bad" && !holds ? 1 : (Number(slot.servings) || 1);
  const photoUrl = getMealPhotoUrl(activeMeal.photo_path);
  const current = log?.status;

  return (
    <article className="glass overflow-hidden p-0">
      {photoUrl ? (
        <img src={photoUrl} alt={activeMeal.photo_alt ?? activeMeal.name} className="h-40 w-full object-cover" />
      ) : activeMeal.owner_client_id ? (
        // A buyer's own meal never carries a photo — no uploads, no generated images. The
        // tile uses the tenant's brand color to stay consistent with the library.
        <div className="flex h-10 items-center justify-center bg-brand/10 text-xs font-semibold tracking-wide">Your meal</div>
      ) : (
        <div className="flex h-10 items-center justify-center bg-ink/5 text-xs opacity-60">No photo yet</div>
      )}
      <div className="p-4">
        <div className="section-title">{slot.slot_label ?? `Meal ${slot.slot_index + 1}`}</div>
        <div className="mt-1 flex items-center justify-between">
          <span className="font-bold">{activeMeal.name}</span>
          <span className="text-xs opacity-60">
            {Math.round((Number(activeMeal.kcal) || 0) * activeServings)} kcal
            {activeServings !== 1 && <span> · {activeServings}× portion</span>}
          </span>
        </div>
        {activeMeal.summary && <p className="mt-1 text-xs opacity-70">{activeMeal.summary}</p>}
        <p className="mt-1 text-xs opacity-60">
          P {Math.round((Number(activeMeal.protein_g) || 0) * activeServings)} ·
          {" "}F {Math.round((Number(activeMeal.fat_g) || 0) * activeServings)} ·
          {" "}C {Math.round((Number(activeMeal.carb_g) || 0) * activeServings)}
          {(activeMeal.prep_time_min || activeMeal.cook_time_min) ? ` · ${(activeMeal.prep_time_min || 0) + (activeMeal.cook_time_min || 0)} min` : ""}
        </p>

        {/* Log first — this is the action clients need, not buried under swap copy. */}
        <MealLogControls
          current={current}
          busyKey={busyKey}
          slotIndex={slot.slot_index}
          dayLabel={dayLabel}
          onStatus={onStatus}
        />

        {/* Fallback line — always shown, per D5/D6. Never a blank cell. */}
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-ink/10 bg-ink/[0.02] p-2 text-xs">
          <span className="font-bold">{holds ? "■" : "→"}</span>
          <div>
            <div className="font-semibold">Backup plate</div>
            {holds ? (
              <div className="opacity-70">Holds — already the backup plate.</div>
            ) : (
              <div className="opacity-70">
                {slot.fallbackMeal.name} — {slot.fallbackMeal.kcal} kcal · P {slot.fallbackMeal.protein_g}
                {(slot.fallbackMeal.prep_time_min || slot.fallbackMeal.cook_time_min)
                  ? ` · ${(slot.fallbackMeal.prep_time_min || 0) + (slot.fallbackMeal.cook_time_min || 0)} min` : ""}
              </div>
            )}
          </div>
        </div>

        {slot.swapOptions.length > 0 && (
          <div className="mt-3 rounded-lg border border-dashed border-ink/15 bg-ink/[0.02] p-2.5 text-xs">
            <div className="section-title">Also works (reference)</div>
            <p className="mt-1 text-[11px] opacity-60">{copyFor(tenantMode, "meal_alternatives_note")}</p>
            <ul className="mt-1.5 space-y-0.5 opacity-70">
              {slot.swapOptions.map((m) => (
                <li key={m.id} className="flex justify-between gap-2">
                  <span>{m.name}</span>
                  <span className="shrink-0">{m.kcal} · P{m.protein_g}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {meal.macro_lesson && (
          <p className="mt-3 text-xs opacity-60"><b className="opacity-100">Why this plate</b> {meal.macro_lesson}</p>
        )}
      </div>
    </article>
  );
}

function resourceTypeLabel(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("pdf")) return "PDF";
  if (t.includes("link") || t.includes("url")) return "Link";
  if (t.includes("video")) return "Video";
  if (t.includes("form")) return "Form";
  if (t.includes("image") || t.includes("photo")) return "Image";
  return type ? String(type) : "File";
}

function ResourcesTab() {
  const [rows, setRows] = useState(undefined);
  const [failed, setFailed] = useState(false);
  const [urls, setUrls] = useState({}); // resource id -> resolved url
  const load = useCallback(() => {
    setRows(undefined);
    setFailed(false);
    listResources()
      .then((r) => { setFailed(false); setRows(r); })
      .catch(() => { setFailed(true); setRows(null); });
  }, []);
  useEffect(() => { load(); }, [load]);

  // pdf rows store a storage path, not a URL — resolve each to a fresh signed link.
  // video/link rows already carry a real URL and are skipped here.
  useEffect(() => {
    if (!rows) return;
    let cancelled = false;
    (async () => {
      const { resolveResourceUrl } = await import("../lib/resourceLibrary");
      const pdfRows = rows.filter((r) => r.type === "pdf");
      const entries = await Promise.all(
        pdfRows.map(async (r) => [r.id, await resolveResourceUrl(r).catch(() => null)]),
      );
      if (!cancelled) setUrls(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [rows]);

  if (rows === undefined) return <Muted>Loading resources…</Muted>;
  if (failed) {
    return (
      <EmptyState
        title="Could not load resources"
        body="This is a failed read, not “no resources.” Refresh or try again."
        actionLabel="Retry resources"
        onAction={load}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No resources yet"
        body="When your coach shares PDFs, forms, or links, they show up here. Nothing is missing on your side."
      />
    );
  }
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const href = r.type === "pdf" ? urls[r.id] : r.file_url;
        return (
          <li key={r.id} className="glass flex items-center justify-between gap-3 p-3 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium">{r.title || "Untitled"}</p>
              <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide opacity-60">
                {resourceTypeLabel(r.type)}
              </p>
              {r.description && <p className="mt-1 text-xs opacity-60">{r.description}</p>}
            </div>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="btn-primary shrink-0 px-3 py-1.5 text-xs"
              >
                Open
              </a>
            ) : (
              <span className="shrink-0 text-xs opacity-60">
                {r.type === "pdf" ? "Loading…" : "No link"}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Content hub — placeholders for the owner's own resources.
const CONTENT_SECTIONS = [
  {
    id: "owner-resources",
    title: "Coaching resources",
    kicker: "Add your own content",
    items: [
      {
        title: "Coaching resource placeholder",
        source: "App owner",
        why: "Add your own coaching explanation and optional video before sharing this resource with clients.",
        link: "/resources/system-framework",
      },
      {
        title: "Knowledge library placeholder",
        source: "App owner",
        why: "Add your own educational articles and guidance for clients.",
        link: "/knowledge",
      },
    ],
  },
];

function ContentTab() {
  return (
    <div className="space-y-6">
      <div>
        <span className="kicker">Curated Hub</span>
        <h2 className="display mt-1 text-2xl">Content</h2>
        <p className="mt-1 text-xs opacity-60">
          The app owner can add their own resources here. These pages are placeholders.
        </p>
      </div>

      {CONTENT_SECTIONS.map((section) => (
        <article key={section.id} className="glass p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <span className="kicker">{section.kicker}</span>
              <h3 className="display mt-1 text-xl">{section.title}</h3>
            </div>
          </div>

          <ul className="mt-4 space-y-3">
            {section.items.map((item, idx) => {
              const internal = item.link.startsWith("/");
              const className = "block min-h-[44px] select-none";
              const body = (
                <>
                  <p className="font-semibold text-sm leading-snug">{item.title}</p>
                  <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide opacity-60">
                    {item.source}
                  </p>
                  <p className="mt-1.5 text-xs opacity-70 leading-relaxed">{item.why}</p>
                  <p className="mt-2 text-xs font-semibold text-brand-fg">{internal ? "Open" : "Open →"}</p>
                </>
              );
              return (
                <li key={`${section.id}-${idx}`} className="rounded-xl border border-ink/10 bg-paper/40 p-3 transition hover:border-brand/30 hover:bg-brand/5">
                  {internal ? (
                    <Link to={item.link} className={className}>{body}</Link>
                  ) : (
                    <a href={item.link} target="_blank" rel="noreferrer" className={className}>{body}</a>
                  )}
                </li>
              );
            })}
          </ul>
        </article>
      ))}
    </div>
  );
}

function ActivityTab() {
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setRows(null);
    setFailed(false);
    listMyActivity({ limit: 50 }).then((r) => { setRows(r); setFailed(false); }).catch(() => { setFailed(true); setRows(null); });
  }, []);
  useEffect(() => { load(); }, [load]);
  if (rows == null && !failed) return <Muted>Reading activity…</Muted>;
  return (
    <div>
      <span className="kicker">Ledger</span>
      <h2 className="display mt-1 text-2xl">Activity</h2>
      <p className="mt-1 text-xs opacity-60">
        Finished work, check-ins, messages. The week as it happened.
      </p>
      {failed ? (
        <div className="mt-4">
          <EmptyState
            title="Could not read activity"
            body="The activity feed didn't respond. This is a failed load, not a count of zero — there may be activity you're not seeing."
            actionLabel="Retry activity"
            onAction={load}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title="No activity yet"
            body="Finished workouts, check-ins, and messages will land here."
          />
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-xl border border-ink/10 p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <span>{row.label}</span>
                <time className="shrink-0 text-xs opacity-60">{new Date(row.at).toLocaleDateString()}</time>
              </div>
              {row.detail?.summary && <p className="mt-1 text-xs opacity-60">{row.detail.summary}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProfileTab({ me, branding, userEmail, ctx, userId, mode }) {
  if (!me) return <Muted>Loading profile…</Muted>;
  const selfServe = isSelfServeMode(mode);

  const units = (me.unit_pref || "imperial").toLowerCase();
  const imperial = units === "imperial" || units === "us" || units === "lb";
  const height = formatHeight({ imperial, height_in: me.height_in, height_cm: me.height_cm });
  const weight = formatWeight({ imperial, lb: me.weight_lb, kg: me.weight_kg });
  const goal = formatWeight({ imperial, lb: me.goal_weight_lb, kg: me.goal_weight_kg });

  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const checkinDay =
    me.checkin_day_of_week != null && me.checkin_day_of_week >= 0 && me.checkin_day_of_week <= 6
      ? dow[me.checkin_day_of_week]
      : null;

  const rows = [
    ["Name", me.display_name],
    ["Email", me.email || userEmail],
    selfServe ? null : ["Coach", branding?.coach_display_name],
    ["Tier", me.coaching_tier],
    ["Status", me.status],
    ["Units", me.unit_pref || "—"],
    ["Sex", me.sex],
    ["Age", me.age != null ? String(me.age) : null],
    ["Height", height],
    ["Weight", weight],
    ["Goal weight", goal],
    ["Activity", me.activity_level],
    ["Client type", me.client_type],
    ["Check-in", [me.checkin_cadence, checkinDay].filter(Boolean).join(" · ") || null],
    ["Show", me.show_name || (me.show_date ? `Date: ${me.show_date}` : null)],
    ["Joined", me.joined_at ? new Date(me.joined_at).toLocaleDateString() : null],
  ].filter(Boolean);

  return (
    <div>
      {isSelfServeMode(mode) && (
        <div className="mb-4">
          <StandardCard />
        </div>
      )}
      <span className="kicker">Account</span>
      <h2 className="display mt-1 text-2xl">Profile</h2>
      <p className="mt-1 text-xs opacity-60">{copyFor(mode, "profile_readonly_note")}</p>
      <dl className="glass mt-4 divide-y divide-ink/10">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4 px-4 py-2.5 text-sm">
            <dt className="shrink-0 opacity-60">{label}</dt>
            <dd className={`text-right font-medium ${KEEP_CASE.has(label) ? "break-words" : "capitalize"}`}>
              {value ? String(value) : <span className="font-normal italic opacity-60">Not set</span>}
            </dd>
          </div>
        ))}
      </dl>
      {!selfServe && (
        <Link to="/client?tab=community" className="btn-ghost mt-4 inline-flex min-h-[44px] items-center text-xs">
          Open community →
        </Link>
      )}
      {ctx?.clientId && userId && (
        <AIOptIn ctx={ctx} userId={userId} mode={mode} appName={branding?.app_name || branding?.coach_display_name} />
      )}
    </div>
  );
}

function EmptyState({ title, body, actionLabel, onAction }) {
  return (
    <div className="rounded-2xl border border-dashed border-ink/15 bg-ink/[0.02] px-4 py-8 text-center">
      <p className="text-sm font-semibold">{title}</p>
      {body && <p className="mx-auto mt-2 max-w-sm text-xs opacity-60">{body}</p>}
      {onAction && actionLabel && (
        <button type="button" onClick={onAction} className="btn-ghost mt-4 min-h-[44px] px-4 text-sm">
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function NutritionDisclaimer({ mode }) {
  if (isSelfServeMode(mode)) {
    return (
      <div className="space-y-2">
        <p className="rounded-xl border border-ink/10 bg-ink/[0.02] px-3 py-2 text-xs opacity-65">
          Fitness coaching only — not medical advice, and not the work of a licensed dietitian. Clear health questions with a clinician.
        </p>
        <p className="rounded-xl border border-ink/10 bg-ink/[0.02] px-3 py-2 text-xs opacity-65">
          {NUTRITION_SCOPE_LINE}
        </p>
      </div>
    );
  }
  return (
    <p className="rounded-xl border border-ink/10 bg-ink/[0.02] px-3 py-2 text-xs opacity-65">
      Fitness coaching only — not medical advice, and not the work of a licensed dietitian unless your coach separately holds and discloses that license. Clear health questions with a clinician.
    </p>
  );
}

// "Pay your coach" — sends the client to the coach's own external payment link (Stripe/PayPal/
// Venmo/etc.). Renders nothing until the coach has set one in Settings. The app never touches
// this payment; it opens the coach's link in a new tab.
function PayCoach({ branding, mode }) {
  const url = branding?.client_payment_url ?? null;
  const [coupon, setCoupon] = useState("");
  if (isSelfServeMode(mode)) return null;
  if (!url) return null;
  const href = paymentUrlWithCoupon(url, coupon);
  return (
    <div className="glass mt-4 px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="font-bold">Pay your coach</span>
          <span className="block text-xs opacity-60">Opens your coach's secure payment page. Coupon is optional.</span>
        </span>
        <a href={href} target="_blank" rel="noopener noreferrer"
          className="rounded-lg bg-brand px-3 py-1.5 text-xs text-brand-text">Pay →</a>
      </div>
      <label className="mt-3 block text-xs opacity-60">
        Coupon
        <input
          type="text"
          value={coupon}
          onChange={(e) => setCoupon(e.target.value)}
          placeholder="If you have one"
          autoComplete="off"
          className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 text-sm opacity-100"
        />
      </label>
    </div>
  );
}

function Muted({ children }) { return <p className="text-sm opacity-60">{children}</p>; }

// Phase 1.5: client notification settings shell. Real controls ship in Phases 2/3;
// this gives the client an honest answer to "where do I turn things off" today.
function SettingsTab({ email, client, onClient, onOpenActivity, mode }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const support = pushSupport();
  const pushOn = client?.notif_channels?.push === true && !!client?.push_subscription;

  async function togglePush() {
    if (!client?.id) return;
    setErr(null);
    setBusy(true);
    try {
      if (pushOn) {
        const next = await disablePush(client.id, client.notif_channels);
        onClient?.({ ...client, notif_enabled: next.notif_enabled, notif_channels: next.channels, push_subscription: null });
      } else {
        const next = await enablePush(client.id, client.notif_channels);
        onClient?.({ ...client, notif_enabled: true, notif_channels: next.channels, push_subscription: next.subscription });
      }
    } catch (e) {
      setErr(e.message || "Could not update alerts.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <span className="kicker">Alerts</span>
        <h2 className="display mt-1 text-2xl">Settings</h2>
        <p className="mt-1 text-xs opacity-60">{copyFor(mode, "settings_alerts_intro")}</p>
      </div>

      {isSelfServeMode(mode) && <UpdateMyNumbers />}

      {/* In-app — always on, describes the existing Activity tab */}
      <div className="glass flex items-center justify-between p-4">
        <div>
          <span className="font-semibold">In the app</span>
          <span className="block text-xs opacity-60">{copyFor(mode, "settings_inapp_note")}</span>
        </div>
        <span className="shrink-0 rounded-full border border-ink/15 px-3 py-1 text-xs opacity-60">On</span>
      </div>

      {/* Email — disabled, coming soon */}
      <div className="glass flex items-center justify-between p-4 opacity-60">
        <div>
          <span className="font-semibold">Email</span>
          {email && <span className="block text-xs opacity-60">{email}</span>}
          <span className="block text-xs opacity-60">{copyFor(mode, "settings_email_note")}</span>
        </div>
        <span className="shrink-0 rounded-full border border-ink/10 bg-ink/[0.03] px-3 py-1 text-xs">Coming soon</span>
      </div>

      <div className="glass p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="font-semibold">Push notifications</span>
            <span className="block text-xs opacity-60">
              {support.ok
                ? "A buzz on this phone when there is a message or a check-in is due."
                : supportMessage(support.reason)}
            </span>
          </div>
          {support.ok ? (
            <button
              type="button"
              onClick={togglePush}
              disabled={busy}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                pushOn ? "bg-ink text-paper" : "border border-ink/15"
              }`}
            >
              {busy ? "…" : pushOn ? "On" : "Off"}
            </button>
          ) : (
            <span className="shrink-0 rounded-full border border-ink/10 bg-ink/[0.03] px-3 py-1 text-xs">Blocked</span>
          )}
        </div>
        {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      </div>

      {/* Footer — open Activity tab (real action; also works as /client?tab=activity) */}
      <button
        type="button"
        onClick={() => onOpenActivity?.()}
        className="mt-4 block w-full rounded-xl border border-ink/10 p-4 text-left text-sm transition hover:bg-paper/80 min-h-[44px]"
      >
        <span className="font-semibold">See everything I've sent you →</span>
        <span className="mt-0.5 block text-xs opacity-60">Your Activity tab shows every notification — open it to review past messages.</span>
      </button>
    </div>
  );
}

// Self-serve re-intake — new weight, goal, or training days rebuild the week and targets
// from what the buyer enters. Rate-limited to once per 28 days by mint_my_intake_token()
// itself; this component only surfaces that limit's message, never re-derives it.
function UpdateMyNumbers() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function start() {
    setErr(null); setBusy(true);
    try {
      const token = await mintMyIntakeToken();
      // &system=1 only switches the intake page's wording (no coach to name); the server
      // decides everything else from the token.
      window.location.assign(`/intake?token=${encodeURIComponent(token)}&system=1`);
    } catch (e) {
      const m = String(e.message || "");
      setErr(m.startsWith("too_soon:")
        ? `You can update your numbers again on ${m.slice(9)}.`
        : "Could not start a new intake. Try again, or reload the app.");
      setBusy(false);
    }
  }
  return (
    <div className="glass p-4 text-sm">
      <p className="font-semibold">Update my numbers</p>
      <p className="mt-1 text-xs opacity-70">New weight, goal, or training days. Your week and your targets are rebuilt from what you enter. Once every four weeks.</p>
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
      <button type="button" onClick={start} disabled={busy} className="btn-primary mt-3 min-h-[44px] px-4 text-sm disabled:opacity-50">
        {busy ? "Opening…" : "Start"}
      </button>
    </div>
  );
}

// Coach messages can carry a link (the health-screen link, a resource). Plain text stays
// plain; http(s) URLs become tappable. Links to this app open in place so the installed
// app keeps its window; anything else opens a new tab.
function MessageBody({ text }) {
  return linkParts(text).map((part, i) => {
    if (part.type === "text") return <span key={i}>{part.value}</span>;
    const internal = isSameOrigin(part.value, window.location.origin);
    return (
      <a key={i} href={part.value} className="break-all underline underline-offset-2"
        {...(internal ? {} : { target: "_blank", rel: "noopener noreferrer" })}>
        {part.value}
      </a>
    );
  });
}
