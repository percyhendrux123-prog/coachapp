// Pure report builders for the MCP coach surface.
//
// Deliberately free of any database client so the rules that matter — which empty state a
// client is in, what a report admits it could not see — are unit-testable without a network.
// index.ts does the fetching; this file does the deciding.
//
// The reporting invariant:
//   ZERO is a fact about the PERSON. They had something to do and did not do it. It reads loud.
//   NOT TRACKED is a fact about the SYSTEM. It was never instrumented. It is never that
//   person's failure and must never be rendered as one.
// They are different facts and they never collapse into each other. When neither can be
// established — because a scan was truncated, or a source read failed — that is a THIRD state
// and it says so, rather than defaulting into either of the first two.

// ---------- section results ----------
// A report assembled from several sources must never silently drop one. A source that failed is
// reported as a named hole, because a timeline missing its message rows reads as "this client
// never wrote to you".
export type Section<T> = { ok: true; value: T } | { ok: false; unavailable: string };

export const sectionOk = <T>(value: T): Section<T> => ({ ok: true, value });
export const sectionFailed = <T>(unavailable: string): Section<T> => ({ ok: false, unavailable });

/** Serialize a section for a tool response: the value, or an explicit `{unavailable}` marker. */
export function renderSection<T>(section: Section<T>): T | { unavailable: string } {
  return section.ok ? section.value : { unavailable: section.unavailable };
}

/** Names of the sections that could not be read. Empty array means the report is complete. */
export function unavailableSections(sections: Record<string, Section<unknown>>): string[] {
  return Object.entries(sections).filter(([, s]) => !s.ok).map(([name]) => name);
}

export function daysBetween(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86400000);
}

// ---------- training state ----------
export type TrainingState =
  | "recent" // trained within the stale window
  | "stale" // trained, but not lately — a fact about the person
  | "never_trained" // has a program, has never logged a session — also a fact about the person
  | "not_tracked" // has no active program: nothing was ever asked of them to measure
  | "unknown_scan_incomplete"; // we could not see far enough back to say. Not an answer.

export type TrainingInput = {
  lastSessionDate: string | null;
  hasActiveAssignment: boolean;
  scanComplete: boolean;
  staleAfterDays: number;
  now?: number;
};

export function trainingState(input: TrainingInput): { state: TrainingState; days_since: number | null } {
  const days = daysBetween(input.lastSessionDate, input.now ?? Date.now());
  if (days != null) return { state: days > input.staleAfterDays ? "stale" : "recent", days_since: days };
  // No session found for this client in what we scanned.
  if (!input.scanComplete) return { state: "unknown_scan_incomplete", days_since: null };
  if (!input.hasActiveAssignment) return { state: "not_tracked", days_since: null };
  return { state: "never_trained", days_since: null };
}

// ---------- activity log ----------
export type ActivityEvent = {
  at: string;
  kind: string;
  summary: string;
  ref?: Record<string, unknown>;
};

/**
 * One client timeline out of many sources. Events with no usable timestamp are dropped from the
 * ordering and counted separately rather than silently sorted to the end — an event the system
 * cannot place in time is not the same as an event that happened at epoch zero.
 */
export function mergeActivityLog(
  events: ActivityEvent[],
  opts: { limit?: number; since?: string | null } = {},
): { events: ActivityEvent[]; total: number; undated: number; truncated: boolean } {
  const sinceMs = opts.since ? Date.parse(opts.since) : null;
  const dated: Array<ActivityEvent & { _t: number }> = [];
  let undated = 0;
  for (const e of events) {
    const t = Date.parse(String(e.at ?? ""));
    if (!Number.isFinite(t)) { undated += 1; continue; }
    if (sinceMs != null && Number.isFinite(sinceMs) && t < sinceMs) continue;
    dated.push({ ...e, _t: t });
  }
  dated.sort((a, b) => b._t - a._t);
  const limit = opts.limit ?? 100;
  const out = dated.slice(0, limit).map(({ _t: _drop, ...e }) => e);
  return { events: out, total: dated.length, undated, truncated: dated.length > limit };
}

// ---------- engagement segmentation ----------
export type EngagementSignals = {
  client_id: string;
  display_name: string | null;
  status: string | null;
  coaching_tier: string | null;
  has_active_program: boolean;
  has_nutrition_plan: boolean;
  last_session_date: string | null;
  sessions_in_window: number;
  last_checkin_at: string | null;
  checkins_in_window: number;
  last_client_message_at: string | null;
  unread_messages: number;
  last_coach_message_at: string | null;
};

export type EngagementSegment = "engaged" | "slipping" | "dormant" | "never_started" | "not_tracked";

export type EngagementRow = EngagementSignals & {
  days_since_last_session: number | null;
  days_since_last_checkin: number | null;
  days_since_last_contact: number | null;
  segment: EngagementSegment;
  segment_reason: string;
  excluded_signals: string[];
};

/**
 * Segments one client. The rules that matter:
 *
 * - A client with NO active program is `not_tracked`. Nothing was ever asked of them, so a low
 *   score would be the system's gap wearing their name.
 * - A client WITH a program who has done nothing at all is `never_started` — a real zero about
 *   the person, and it reads loud.
 * - `excluded_signals` lists every signal that was not measurable for this client. A score with
 *   silent omissions is an invented number wearing a decimal point.
 */
export function segmentEngagement(
  s: EngagementSignals,
  opts: { windowDays: number; slippingAfterDays?: number; dormantAfterDays?: number; now?: number },
): EngagementRow {
  const now = opts.now ?? Date.now();
  const slippingAfter = opts.slippingAfterDays ?? 7;
  const dormantAfter = opts.dormantAfterDays ?? 21;

  const dSession = daysBetween(s.last_session_date, now);
  const dCheckin = daysBetween(s.last_checkin_at, now);
  const dMessage = daysBetween(s.last_client_message_at, now);

  const contactDays = [dSession, dCheckin, dMessage].filter((d): d is number => d != null);
  const dContact = contactDays.length ? Math.min(...contactDays) : null;

  const excluded: string[] = [];
  if (!s.has_active_program) excluded.push("training (no active program assigned)");
  if (!s.has_nutrition_plan) excluded.push("nutrition (no meal plan assigned)");

  let segment: EngagementSegment;
  let reason: string;
  if (!s.has_active_program) {
    segment = "not_tracked";
    reason = "No active program. Nothing has been asked of this client, so there is nothing to score. " +
      "This is a gap in what was set up, not a failure by them.";
  } else if (dContact == null) {
    segment = "never_started";
    reason = "Has an active program and has never trained, checked in, or messaged. A real zero.";
  } else if (dContact <= slippingAfter) {
    segment = "engaged";
    reason = `Last activity ${dContact} day(s) ago.`;
  } else if (dContact <= dormantAfter) {
    segment = "slipping";
    reason = `No training, check-in or message for ${dContact} day(s).`;
  } else {
    segment = "dormant";
    reason = `No training, check-in or message for ${dContact} day(s).`;
  }

  return {
    ...s,
    days_since_last_session: dSession,
    days_since_last_checkin: dCheckin,
    days_since_last_contact: dContact,
    segment,
    segment_reason: reason,
    excluded_signals: excluded,
  };
}

export function summariseEngagement(rows: EngagementRow[]) {
  const by: Record<string, number> = { engaged: 0, slipping: 0, dormant: 0, never_started: 0, not_tracked: 0 };
  for (const r of rows) by[r.segment] = (by[r.segment] ?? 0) + 1;
  return by;
}

// ---------- support queue ----------
export type SupportQueueClient = {
  id: string;
  display_name: string | null;
  coaching_tier: string | null;
};

export type SupportQueueInput = {
  clients: SupportQueueClient[];
  unreadByClient: Map<string, number>;
  lastSessionByClient: Map<string, string>;
  clientsWithActiveAssignment: Set<string>;
  sessionScanComplete: boolean;
  unseenCheckins: Array<{ id: string; client_id: string; submitted_at: string }>;
  staleAfterDays: number;
  // Most recent client_notes.created_at per client_id — optional so existing callers (tests
  // included) that don't pass it keep compiling; a client with no notes gets null, a real fact
  // (nobody has logged contact), never confused with this source being unavailable.
  lastContactByClient?: Map<string, string>;
  now?: number;
};

export function buildSupportQueue(input: SupportQueueInput) {
  const now = input.now ?? Date.now();
  const unseenByClient = new Map<string, number>();
  for (const c of input.unseenCheckins) {
    unseenByClient.set(c.client_id, (unseenByClient.get(c.client_id) ?? 0) + 1);
  }
  const lastContactByClient = input.lastContactByClient ?? new Map<string, string>();

  const roster = input.clients.map((c) => {
    const last = input.lastSessionByClient.get(c.id) ?? null;
    const { state, days_since } = trainingState({
      lastSessionDate: last,
      hasActiveAssignment: input.clientsWithActiveAssignment.has(c.id),
      scanComplete: input.sessionScanComplete,
      staleAfterDays: input.staleAfterDays,
      now,
    });
    return {
      id: c.id,
      display_name: c.display_name,
      coaching_tier: c.coaching_tier,
      unread_messages: input.unreadByClient.get(c.id) ?? 0,
      unseen_checkins: unseenByClient.get(c.id) ?? 0,
      last_session_date: last,
      days_since_last_session: days_since,
      training_state: state,
      // A coach note's created_at, most recent first — not a message or a check-in, so it
      // catches outreach (a text, a call) those two sources never see. null is a real zero:
      // nobody has logged contacting this client, not that contact-logging is unavailable.
      last_contact_at: lastContactByClient.get(c.id) ?? null,
    };
  });

  // Ordered by what most needs a human: unread first, then unseen check-ins, then how long
  // they have been quiet. Never guesses WHY someone is quiet.
  roster.sort((a, b) =>
    b.unread_messages - a.unread_messages ||
    b.unseen_checkins - a.unseen_checkins ||
    (b.days_since_last_session ?? -1) - (a.days_since_last_session ?? -1) ||
    String(a.display_name ?? "").localeCompare(String(b.display_name ?? "")));

  return {
    stale_after_days_used: input.staleAfterDays,
    unread_threads: input.unreadByClient.size,
    unseen_checkins: input.unseenCheckins.length,
    unseen_checkin_ids: input.unseenCheckins.slice(0, 20)
      .map((r) => ({ id: r.id, client_id: r.client_id, submitted_at: r.submitted_at })),
    session_scan_complete: input.sessionScanComplete,
    roster,
  };
}
