// Deno-only. Run: deno test supabase/functions/mcp/reports.test.ts
// (`node --test` on this file throws "Deno is not defined" — a runner mismatch, not a failure.)
import {
  buildSupportQueue,
  type EngagementSignals,
  mergeActivityLog,
  renderSection,
  sectionFailed,
  sectionOk,
  segmentEngagement,
  summariseEngagement,
  trainingState,
  unavailableSections,
} from "./reports.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const eq = (actual: unknown, expected: unknown, message: string) =>
  assert(Object.is(actual, expected), `${message} — expected ${String(expected)}, got ${String(actual)}`);

const NOW = Date.parse("2026-08-26T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

Deno.test("training state: trained lately vs trained but gone quiet", () => {
  const base = { hasActiveAssignment: true, scanComplete: true, staleAfterDays: 7, now: NOW };
  eq(trainingState({ ...base, lastSessionDate: daysAgo(2) }).state, "recent", "2 days ago is recent");
  eq(trainingState({ ...base, lastSessionDate: daysAgo(7) }).state, "recent", "exactly the window is still recent");
  eq(trainingState({ ...base, lastSessionDate: daysAgo(30) }).state, "stale", "a month ago is stale");
  eq(trainingState({ ...base, lastSessionDate: daysAgo(30) }).days_since, 30, "days_since is the real number");
});

Deno.test("twin facts: a zero and a not-tracked are different subjects and never collapse", () => {
  // Has a program, has logged nothing. That is a fact about the PERSON. It reads loud.
  eq(
    trainingState({ lastSessionDate: null, hasActiveAssignment: true, scanComplete: true, staleAfterDays: 7, now: NOW }).state,
    "never_trained",
    "a client with a program and no sessions is a real zero, not an instrumentation gap",
  );
  // No program at all. Nothing was ever asked of them. That is a fact about the SYSTEM.
  eq(
    trainingState({ lastSessionDate: null, hasActiveAssignment: false, scanComplete: true, staleAfterDays: 7, now: NOW }).state,
    "not_tracked",
    "a client with no active program was never measured",
  );
});

Deno.test("an incomplete scan is its own state, never 'not tracked'", () => {
  const s = trainingState({ lastSessionDate: null, hasActiveAssignment: true, scanComplete: false, staleAfterDays: 7, now: NOW });
  eq(s.state, "unknown_scan_incomplete", "a truncated scan must not be reported as an answer");
  eq(s.days_since, null, "and it must not invent a day count");
});

// The exact bug this replaced: a tenant-wide 400-row window meant a client quiet for a month
// fell outside it and was reported as never instrumented.
Deno.test("regression: a client outside the old 400-row window is stale, not not_tracked", () => {
  const out = buildSupportQueue({
    clients: [{ id: "c1", display_name: "Quiet Client", coaching_tier: "standard" }],
    unreadByClient: new Map(),
    lastSessionByClient: new Map([["c1", daysAgo(31)]]), // the paged scan found it
    clientsWithActiveAssignment: new Set(["c1"]),
    sessionScanComplete: true,
    unseenCheckins: [],
    staleAfterDays: 7,
    now: NOW,
  });
  eq(out.roster[0].training_state, "stale", "a month-quiet client is stale");
  eq(out.roster[0].days_since_last_session, 31, "and the real gap is reported");
});

Deno.test("support queue orders by what most needs a human", () => {
  const out = buildSupportQueue({
    clients: [
      { id: "quiet", display_name: "Quiet", coaching_tier: null },
      { id: "unread", display_name: "Unread", coaching_tier: null },
      { id: "checkin", display_name: "Checkin", coaching_tier: null },
    ],
    unreadByClient: new Map([["unread", 3]]),
    lastSessionByClient: new Map([["quiet", daysAgo(20)], ["unread", daysAgo(1)], ["checkin", daysAgo(1)]]),
    clientsWithActiveAssignment: new Set(["quiet", "unread", "checkin"]),
    sessionScanComplete: true,
    unseenCheckins: [{ id: "k1", client_id: "checkin", submitted_at: "2026-08-25T00:00:00Z" }],
    staleAfterDays: 7,
    now: NOW,
  });
  eq(out.roster[0].id, "unread", "unread messages come first");
  eq(out.roster[1].id, "checkin", "then unseen check-ins");
  eq(out.roster[2].id, "quiet", "then how long they have been quiet");
  eq(out.unread_threads, 1, "unread thread count");
  eq(out.unseen_checkins, 1, "unseen check-in count");
  eq(out.roster[2].unread_messages, 0, "a zero unread count is a real zero and is shown");
});

Deno.test("the stale window that is used is echoed back, never silently substituted", () => {
  const out = buildSupportQueue({
    clients: [], unreadByClient: new Map(), lastSessionByClient: new Map(),
    clientsWithActiveAssignment: new Set(), sessionScanComplete: true, unseenCheckins: [],
    staleAfterDays: 90, now: NOW,
  });
  eq(out.stale_after_days_used, 90, "a 90-day window is honoured and stated");
});

Deno.test("support queue surfaces the last logged contact per client, and a real zero for nobody", () => {
  const out = buildSupportQueue({
    clients: [
      { id: "texted", display_name: "Texted Yesterday", coaching_tier: null },
      { id: "quiet", display_name: "Never Contacted", coaching_tier: null },
    ],
    unreadByClient: new Map(),
    lastSessionByClient: new Map(),
    clientsWithActiveAssignment: new Set(),
    sessionScanComplete: true,
    unseenCheckins: [],
    staleAfterDays: 7,
    lastContactByClient: new Map([["texted", "2026-08-27T18:00:00Z"]]),
    now: NOW,
  });
  const texted = out.roster.find((r) => r.id === "texted")!;
  const quiet = out.roster.find((r) => r.id === "quiet")!;
  eq(texted.last_contact_at, "2026-08-27T18:00:00Z", "the logged note's timestamp surfaces as-is");
  eq(quiet.last_contact_at, null, "no note logged is a real zero, not left undefined");
});

Deno.test("support queue without lastContactByClient still returns null, not a crash", () => {
  // Existing callers that predate this field must keep compiling and running unchanged.
  const out = buildSupportQueue({
    clients: [{ id: "c1", display_name: "Someone", coaching_tier: null }],
    unreadByClient: new Map(), lastSessionByClient: new Map(),
    clientsWithActiveAssignment: new Set(), sessionScanComplete: true, unseenCheckins: [],
    staleAfterDays: 7, now: NOW,
  });
  eq(out.roster[0].last_contact_at, null, "omitted entirely defaults to null, same as no contact");
});

Deno.test("a failed source becomes a named hole, not a missing key", () => {
  const sections = { messages: sectionOk([1, 2]), notes: sectionFailed<number[]>("notes: permission denied") };
  const gaps = unavailableSections(sections);
  eq(gaps.length, 1, "one section failed");
  eq(gaps[0], "notes", "and it is named");
  const rendered = renderSection(sections.notes) as { unavailable: string };
  eq(rendered.unavailable, "notes: permission denied", "the reason survives to the caller");
});

// ---------- activity log ----------
Deno.test("activity log merges every source into one newest-first timeline", () => {
  const out = mergeActivityLog([
    { at: "2026-08-20T10:00:00Z", kind: "checkin_submitted", summary: "check-in" },
    { at: "2026-08-24T09:00:00Z", kind: "session_complete", summary: "session" },
    { at: "2026-08-22T12:00:00Z", kind: "message_in", summary: "client wrote" },
  ]);
  eq(out.events[0].kind, "session_complete", "newest first");
  eq(out.events[2].kind, "checkin_submitted", "oldest last");
  eq(out.total, 3, "all three counted");
  eq(out.truncated, false, "nothing truncated");
});

Deno.test("an event with no usable timestamp is counted, not silently sorted to the bottom", () => {
  const out = mergeActivityLog([
    { at: "2026-08-24T09:00:00Z", kind: "session_complete", summary: "session" },
    { at: "", kind: "note_added", summary: "a note with no date" },
  ]);
  eq(out.events.length, 1, "only placeable events are ordered");
  eq(out.undated, 1, "and the unplaceable one is reported, not dropped in silence");
});

Deno.test("activity log honours since and limit and says when it truncated", () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    at: `2026-08-${String(10 + i).padStart(2, "0")}T00:00:00Z`, kind: "message_in", summary: `m${i}`,
  }));
  const windowed = mergeActivityLog(events, { since: "2026-08-15T00:00:00Z" });
  eq(windowed.total, 5, "events before `since` are excluded");
  const capped = mergeActivityLog(events, { limit: 3 });
  eq(capped.events.length, 3, "limit applied");
  eq(capped.truncated, true, "and truncation is stated");
  eq(capped.total, 10, "with the real total still reported");
});

// ---------- engagement ----------
const signals = (over: Partial<EngagementSignals> = {}): EngagementSignals => ({
  client_id: "c1", display_name: "Client", status: "active", coaching_tier: "standard",
  has_active_program: true, has_nutrition_plan: true,
  last_session_date: null, sessions_in_window: 0,
  last_checkin_at: null, checkins_in_window: 0,
  last_client_message_at: null, unread_messages: 0, last_coach_message_at: null,
  ...over,
});
const opts = { windowDays: 30, now: NOW };

Deno.test("engagement: no program at all is the system's gap, never the client's score", () => {
  const row = segmentEngagement(signals({ has_active_program: false, has_nutrition_plan: false }), opts);
  eq(row.segment, "not_tracked", "nothing was ever asked of them");
  assert(row.segment_reason.includes("not a failure by them"), "and the reason says so plainly");
  assert(row.excluded_signals.some((s) => s.includes("training")), "training is named as excluded");
  assert(row.excluded_signals.some((s) => s.includes("nutrition")), "nutrition is named as excluded");
});

Deno.test("engagement: a program with zero activity is a real zero and reads loud", () => {
  const row = segmentEngagement(signals(), opts);
  eq(row.segment, "never_started", "has a program, has done nothing");
  assert(row.segment_reason.includes("A real zero"), "and it is named as a zero, not a gap");
});

Deno.test("engagement: any of training, check-in or message counts as contact", () => {
  eq(segmentEngagement(signals({ last_session_date: daysAgo(2) }), opts).segment, "engaged", "recent training");
  eq(segmentEngagement(signals({ last_checkin_at: daysAgo(3) }), opts).segment, "engaged", "recent check-in");
  eq(segmentEngagement(signals({ last_client_message_at: daysAgo(1) }), opts).segment, "engaged", "recent message");
  // The most recent of the three wins — a client who trained a month ago but messaged yesterday
  // is engaged, not dormant.
  const mixed = segmentEngagement(signals({ last_session_date: daysAgo(40), last_client_message_at: daysAgo(1) }), opts);
  eq(mixed.segment, "engaged", "most recent contact wins");
  eq(mixed.days_since_last_session, 40, "but the training gap is still reported honestly");
});

Deno.test("engagement: slipping and dormant are separated by a stated threshold", () => {
  eq(segmentEngagement(signals({ last_session_date: daysAgo(10) }), opts).segment, "slipping", "10 days is slipping");
  eq(segmentEngagement(signals({ last_session_date: daysAgo(40) }), opts).segment, "dormant", "40 days is dormant");
  eq(
    segmentEngagement(signals({ last_session_date: daysAgo(10) }), { ...opts, slippingAfterDays: 14 }).segment,
    "engaged",
    "a wider threshold is honoured",
  );
});

Deno.test("engagement: a client missing only nutrition is still scored, with the omission stated", () => {
  const row = segmentEngagement(signals({ has_nutrition_plan: false, last_session_date: daysAgo(1) }), opts);
  eq(row.segment, "engaged", "training alone is enough to be engaged");
  eq(row.excluded_signals.length, 1, "one signal excluded");
  assert(row.excluded_signals[0].includes("nutrition"), "and it is named, not averaged in as a zero");
});

Deno.test("engagement totals count every segment, including the empty ones", () => {
  const rows = [
    segmentEngagement(signals({ last_session_date: daysAgo(1) }), opts),
    segmentEngagement(signals({ has_active_program: false }), opts),
  ];
  const totals = summariseEngagement(rows);
  eq(totals.engaged, 1, "one engaged");
  eq(totals.not_tracked, 1, "one not tracked");
  eq(totals.dormant, 0, "and a zero segment is shown as zero, not omitted");
});
