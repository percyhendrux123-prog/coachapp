// ============================================================================
// Coach overview PREVIEW FIXTURES — development only.
//
// Split into its own module and loaded via dynamic import() from CoachHome so
// none of this data is in the production main bundle. ?preview is additionally
// gated on dev mode or the explicit fixture-preview build mode, so an ordinary
// production build ignores it outright: a coach can never be shown a fixture on
// their real home page.
//
// Illustrative fixture data exercises healthy, unavailable, zero, and empty states.
// Keep all fixture identities fictional, including names inside evidence strings.
// ============================================================================
const TENANT_OWNER = {
  tenant_id: "a0000000-0000-4000-a000-000000000001",
  slug: "owner",
  app_name: "Coach App",
  coach_display_name: "Sam Rivera",
  logo_url: null,
  brand_color: "#e2761b",
  theme_key: "liquid_glass",
  surface_mode: "dark",
  type_key: "condensed",
  weight_unit: "lb",
  features: { messaging: true, progress_photos: true, progress_weight: true, approval_gate: true },
};

export const FIXTURE_TENANTS = {
  owner: TENANT_OWNER,
  // A second fixture tenant. #0a0a0a is why the accent
  // resolver exists: raw, it renders an invisible accent on a dark surface.
  ironclad: {
    ...TENANT_OWNER,
    tenant_id: "b0000000-0000-4000-a000-000000000001",
    slug: "riverside",
    app_name: "Riverside Coaching",
    coach_display_name: "Coach B",
    brand_color: "#0a0a0a",
    type_key: "serif",
    features: { messaging: true, progress_photos: false, progress_weight: true, approval_gate: true },
  },
};

const CURRENT = {
  schema_version: 1,
  generated_at: "2026-07-29T23:24:51.524Z",
  tenant: TENANT_OWNER,
  sources: [
    {
      key: "training", state: "unavailable",
      last_event_at: "2026-07-29T23:19:30.635Z",
      expected_interval: "2 days", volume_7d: 7, baseline_28d: 7, confidence: 0,
      note: "4 sessions and 7 sets logged, from 2 of 31 active assignments. Too small a share of the roster to read adherence from, so training is treated as unavailable and no client is being flagged on it. Whether the feed is broken or the roster genuinely is not logging cannot be told apart from here — at this volume the two look identical. To settle it: open one client who should have trained and check whether their app shows the session.",
    },
    {
      key: "checkins", state: "unavailable",
      last_event_at: null,
      expected_interval: "7 days", volume_7d: 0, baseline_28d: 0, confidence: 0,
      note: "No submissions on record, 5 archived from the prior hubs. Expected every week. Nothing has ever arrived, so a sync path that never delivered cannot be separated from a roster that has never been asked to check in. To settle it: confirm one client has check-ins switched on and can see the form.",
    },
    {
      key: "messages", state: "not_configured",
      last_event_at: null,
      expected_interval: "3 days", volume_7d: 0, baseline_28d: 0, confidence: 0,
      note: "Thread store empty. Nothing sent or received in-app yet.",
    },
    {
      key: "roster", state: "live",
      last_event_at: "2026-07-29T22:11:04.000Z",
      expected_interval: "30 days", volume_7d: 31, baseline_28d: 31, confidence: 1,
      note: "31 active, 1 paused. 31 active assignments, 25 meal plans, 30 notes. Live.",
    },
  ],
  // trained_7d / silent_7d / checked_in_7d are NULL, not 0 — their backing
  // sources are unhealthy. The UI must hatch them, never print a zero.
  roster: {
    total: 32, active: 31, paused: 1, invited: 0,
    trained_7d: null, silent_7d: null, checked_in_7d: null,
  },
  attention: [
    {
      client_id: null, display_name: "26 clients", band: "act", score: 0.8,
      signal_type: "account_unreachable", source_key: "roster",
      mechanism: "Client records with no account attached and no invite issued. They cannot open the app.",
      evidence: [
        { label: "clients", value: "26" },
        { label: "longest waiting", value: "A. Demo +25" },
      ],
      actions: [{ key: "review_list", label: "Review list", primary: true }],
      since: "2026-07-21T00:00:00.000Z", deadline: null, member_count: 26,
    },
    {
      client_id: null, display_name: "6 clients", band: "watch", score: 0.49,
      signal_type: "no_meal_plan", source_key: "roster",
      mechanism: "Active assignment with no meal plan attached. The nutrition surface is blank on their side.",
      evidence: [
        { label: "clients", value: "6" },
        { label: "longest waiting", value: "Nolan Frey +5" },
      ],
      actions: [{ key: "review_list", label: "Review list", primary: true }],
      since: "2026-07-21T00:00:00.000Z", deadline: null, member_count: 6,
    },
    {
      client_id: "c0000000-0000-4000-a000-00000000002f",
      display_name: "Marcus Reed", band: "hold", score: 0.27,
      signal_type: "paused_no_resume", source_key: "roster",
      mechanism: "Paused 8 days ago. No resume date is recorded, so nothing will surface this client again on its own.",
      evidence: [
        { label: "status", value: "paused" },
        { label: "resume date", value: "none set" },
      ],
      actions: [{ key: "open_client", label: "Open client", primary: false }],
      since: "2026-07-21T00:00:00.000Z", deadline: null, member_count: 1,
    },
  ],
  suppressed: [
    {
      source_key: "training", withheld_count: 29,
      reason: "4 sessions and 7 sets logged, from 2 of 31 active assignments. Too small a share of the roster to read adherence from, so training is treated as unavailable and no client is being flagged on it. Whether the feed is broken or the roster genuinely is not logging cannot be told apart from here — at this volume the two look identical. To settle it: open one client who should have trained and check whether their app shows the session.",
      since: "2026-07-29T23:19:30.635Z",
    },
  ],
  decisions: [
    { kind: "no_meal_plan", title: "Active clients without a meal plan",
      detail: "Assignment live, nutrition surface blank on their side.", count: 6 },
    { kind: "meal_plan_unreleased", title: "Meal plans drafted, never released",
      detail: "The work is done. Until it is assigned, the client cannot see it.", count: 17 },
    { kind: "intakes_unanswered", title: "Intakes out, unanswered",
      detail: "Sent and not submitted, or expired before it was. Resend from the client profile.", count: 2 },
    { kind: "paused_no_resume", title: "Paused without a resume date",
      detail: "Will not resurface on its own until a resume date is set.", count: 1 },
  ],
  timelines: [],
  // clients.show_date landed on 2026-07-30, so the schema gap this rail used to report is
  // closed and the live read model now returns timelines_unavailable = false. The honest
  // state today is "the column exists and nobody has a date in it" — an empty rail, not a
  // broken one. Kept in step with production so the preview cannot claim a gap that is fixed.
  timelines_unavailable: false,
  timelines_note: null,
  unavailable_signals: [
    { signal_type: "program_ending",
      reason: "Programs carry no length or end date — structure.days is a weekly rotation, so \"ends in 7 days\" is not derivable. Needs a program length or an assignment end date." },
  ],
  activity: [
    { at: "2026-07-29T23:19:38.555Z", client_id: "x", display_name: "Andre Cole", kind: "session_complete", summary: "completed a session — 6 sets" },
    { at: "2026-07-29T23:19:30.635Z", client_id: "x", display_name: "Andre Cole", kind: "set_logged", summary: "logged a set — 205 x 8" },
    { at: "2026-07-29T23:19:23.073Z", client_id: "x", display_name: "Andre Cole", kind: "set_logged", summary: "logged a set — 205 x 8" },
    { at: "2026-07-29T23:19:16.944Z", client_id: "x", display_name: "Andre Cole", kind: "set_logged", summary: "logged a set — 185 x 10" },
    { at: "2026-07-29T23:19:06.529Z", client_id: "x", display_name: "Andre Cole", kind: "set_logged", summary: "logged a set — 185 x 10" },
    { at: "2026-07-29T23:18:59.675Z", client_id: "x", display_name: "Andre Cole", kind: "set_logged", summary: "logged a set — 135 x 12" },
    { at: "2026-07-29T23:18:39.874Z", client_id: "x", display_name: "Andre Cole", kind: "set_logged", summary: "logged a set — 135 x 12" },
  ],
};

// Healthy feeds. Same page, same components — only the payload differs. Note
// checked_in_7d stays null here on purpose: it demonstrates a hatched unknown
// sitting directly beside real numerals.
const STEADY = {
  ...CURRENT,
  sources: [
    { key: "training", state: "live", last_event_at: "2026-07-29T22:43:00.000Z",
      expected_interval: "2 days", volume_7d: 184, baseline_28d: 712, confidence: 1,
      note: "184 sets logged in the last 7 days across 31 active assignments. Last event 41 minutes ago." },
    { key: "checkins", state: "unavailable", last_event_at: "2026-07-15T09:12:00.000Z",
      expected_interval: "7 days", volume_7d: 0, baseline_28d: 22, confidence: 0,
      note: "Nothing has arrived since 15 Jul. Expected every week. No client is being flagged for a missed check-in while that remains true. Submissions stopped rather than never started, which leans towards the sync path — but a roster that went quiet on the same date looks the same from here. To settle it: check one client who submitted before that date." },
    { key: "messages", state: "live", last_event_at: "2026-07-29T21:20:00.000Z",
      expected_interval: "3 days", volume_7d: 37, baseline_28d: 140, confidence: 1,
      note: "4 unread from clients. Last event 2 hours ago." },
    { key: "roster", state: "live", last_event_at: "2026-07-29T22:11:04.000Z",
      expected_interval: "30 days", volume_7d: 31, baseline_28d: 31, confidence: 1,
      note: "31 active, 1 paused. 31 active assignments, 25 meal plans, 30 notes. Live." },
  ],
  roster: { total: 32, active: 31, paused: 1, invited: 0,
    trained_7d: 24, silent_7d: 5, checked_in_7d: null },
  attention: [
    { client_id: "d1", display_name: "Terry Vaughn", band: "act", score: 0.82,
      signal_type: "training_silent", source_key: "training",
      mechanism: "9 days without a logged session against an active assignment.",
      evidence: [{ label: "last session", value: "20 Jul" }, { label: "sessions 28d", value: "4" }],
      actions: [{ key: "open_client", label: "Open client", primary: true },
                { key: "draft_message", label: "Draft message", primary: false }],
      since: "2026-07-20T00:00:00.000Z", deadline: null, member_count: 1 },
    { client_id: "d2", display_name: "Dominic Hale", band: "act", score: 0.77,
      signal_type: "load_regression", source_key: "training",
      mechanism: "Top-set load down 3 sessions running on Incline Barbell Press. Volume held, intensity dropped. Sessions still logged, so adherence hides it.",
      evidence: [{ label: "top set", value: "225 → 215 → 205" }, { label: "sets held at", value: "12" }],
      actions: [{ key: "open_client", label: "Open client", primary: true },
                { key: "adjust_block", label: "Adjust block", primary: false }],
      since: "2026-07-28T00:00:00.000Z", deadline: null, member_count: 1 },
    { client_id: null, display_name: "6 clients", band: "watch", score: 0.49,
      signal_type: "no_meal_plan", source_key: "roster",
      mechanism: "Active assignment with no meal plan attached. The nutrition surface is blank on their side.",
      evidence: [{ label: "clients", value: "6" }, { label: "longest waiting", value: "Nolan Frey +5" }],
      actions: [{ key: "review_list", label: "Review list", primary: true }],
      since: "2026-07-21T00:00:00.000Z", deadline: null, member_count: 6 },
    { client_id: "d3", display_name: "Renee Park", band: "watch", score: 0.42,
      signal_type: "overreach", source_key: "training",
      mechanism: "6 sessions logged in seven days against a 4-day program. Adding work that was not prescribed.",
      evidence: [{ label: "sessions 7d", value: "6" }, { label: "program", value: "4-day" }],
      actions: [{ key: "open_client", label: "Open client", primary: false },
                { key: "draft_message", label: "Draft message", primary: false }],
      since: "2026-07-29T00:00:00.000Z", deadline: null, member_count: 1 },
    { client_id: "d4", display_name: "Isaiah Bright", band: "hold", score: 0.24,
      signal_type: "first_week_strong", source_key: "training",
      mechanism: "First full week complete. 4 of 4 sessions logged. Worth naming while it is still new behaviour.",
      evidence: [{ label: "sessions", value: "4 / 4" }, { label: "joined", value: "22 Jul" }],
      actions: [{ key: "draft_message", label: "Draft message", primary: false }],
      since: "2026-07-22T00:00:00.000Z", deadline: null, member_count: 1 },
  ],
  suppressed: [
    { source_key: "checkins", withheld_count: 9,
      reason: "Nothing has arrived since 15 Jul. Expected every week. No client is being flagged for a missed check-in while that remains true. This is a sync fault, not client behaviour.",
      since: "2026-07-15T09:12:00.000Z" },
  ],
  activity: [
    { at: "2026-07-29T08:14:00.000Z", display_name: "Julian Moss", kind: "session_complete", summary: "completed a session — 22 sets" },
    { at: "2026-07-29T07:52:00.000Z", display_name: "Isaiah Bright", kind: "set_logged", summary: "logged a set — 185 x 8" },
    { at: "2026-07-29T07:31:00.000Z", display_name: "Damon Ruiz", kind: "session_complete", summary: "completed a session — 18 sets" },
    { at: "2026-07-29T06:58:00.000Z", display_name: "Omar Castillo", kind: "message", summary: "messaged you" },
    { at: "2026-07-28T21:40:00.000Z", display_name: "Andre Cole", kind: "session_complete", summary: "completed a session — 26 sets" },
    { at: "2026-07-28T20:15:00.000Z", display_name: "Trey Lawson", kind: "set_logged", summary: "logged a set — 245 x 5" },
  ],
};

// Day one for a brand-new tenant: nothing anywhere. This is the state that must
// still look intentional, because it is what every new tenant sees first.
const EMPTY = {
  schema_version: 1,
  generated_at: "2026-07-29T23:24:51.524Z",
  tenant: { ...TENANT_OWNER, app_name: "New Tenant", coach_display_name: "Coach", brand_color: "#3f6f52" },
  sources: [
    { key: "training", state: "not_configured", last_event_at: null, expected_interval: "2 days",
      volume_7d: 0, baseline_28d: 0, confidence: 0,
      note: "No training data has ever arrived. Nothing is broken — nothing has been logged yet." },
    { key: "checkins", state: "not_configured", last_event_at: null, expected_interval: "7 days",
      volume_7d: 0, baseline_28d: 0, confidence: 0,
      note: "Check-ins are switched off for this tenant." },
    { key: "messages", state: "not_configured", last_event_at: null, expected_interval: "3 days",
      volume_7d: 0, baseline_28d: 0, confidence: 0,
      note: "Thread store empty. Nothing sent or received in-app yet." },
    { key: "roster", state: "not_configured", last_event_at: null, expected_interval: "30 days",
      volume_7d: 0, baseline_28d: 0, confidence: 0,
      note: "No clients on the roster yet. Invite a client to bring this page to life." },
  ],
  roster: { total: 0, active: 0, paused: 0, invited: 0,
    trained_7d: null, silent_7d: null, checked_in_7d: null },
  attention: [],
  suppressed: [],
  decisions: [],
  timelines: [],
  // clients.show_date landed on 2026-07-30, so the schema gap this rail used to report is
  // closed and the live read model now returns timelines_unavailable = false. The honest
  // state today is "the column exists and nobody has a date in it" — an empty rail, not a
  // broken one. Kept in step with production so the preview cannot claim a gap that is fixed.
  timelines_unavailable: false,
  timelines_note: null,
  unavailable_signals: [],
  activity: [],
};

// ---------------------------------------------------------------------------
// ZEROS — the pair this page must never merge, shown together.
//
// Training is LIVE and trusted, and the number it reports is 0 of 31. That is a
// true zero: the work was owed, the system was watching, nobody did it. It is
// the loudest thing on the card because it is the coach's most actionable fact.
//
// Check-ins are NOT CONFIGURED, so checked_in_7d is null. Rendering that as 0
// would invent a failure and send the coach chasing clients who were never asked
// to check in. It reads "NOT TRACKED" — same card weight, no alarm colour.
//
// Silent 7 days+ is 0 as well, and stays QUIET on purpose: zero there is good
// news. Loudness follows what the metric means, not the digit.
// ---------------------------------------------------------------------------
const ZEROS = {
  ...CURRENT,
  sources: [
    { key: "training", state: "live", last_event_at: "2026-07-30T06:10:00.000Z",
      expected_interval: "2 days", volume_7d: 0, baseline_28d: 486, confidence: 1,
      note: "Reporting normally across 31 active assignments, and 0 sets have been logged in the last 7 days against a 28-day count of 486. The feed is healthy, so this zero is client behaviour and not a fault." },
    { key: "checkins", state: "not_configured", last_event_at: null,
      expected_interval: "7 days", volume_7d: 0, baseline_28d: 0, confidence: 0,
      note: "Check-ins are switched off for this tenant. Nothing is being measured here, so no client can be counted as having missed one." },
    { key: "messages", state: "live", last_event_at: "2026-07-30T05:02:00.000Z",
      expected_interval: "3 days", volume_7d: 12, baseline_28d: 63, confidence: 1,
      note: "2 unread from clients. Last event 3 hours ago." },
    { key: "roster", state: "live", last_event_at: "2026-07-30T04:40:00.000Z",
      expected_interval: "30 days", volume_7d: 31, baseline_28d: 31, confidence: 1,
      note: "31 active, 1 paused. 31 active assignments, 25 meal plans, 30 notes. Live." },
  ],
  // trained_7d is a REAL 0 — the source is live, so this is measured, not missing.
  // checked_in_7d is null — nothing is measuring it. The two must not look alike.
  roster: { total: 32, active: 31, paused: 1, invited: 0,
    trained_7d: 0, silent_7d: 0, checked_in_7d: null },
  suppressed: [],
};

export const FIXTURES = { current: CURRENT, steady: STEADY, zeros: ZEROS, empty: EMPTY };

// tenantKey overrides the fixture's own tenant only when explicitly supplied.
// The `empty` fixture carries its own brand on purpose (a third colour, to show
// the token derivation is not tuned to the two live tenants), so defaulting to
// owner here would silently overwrite it.
export function getFixture(name, tenantKey) {
  const base = FIXTURES[name];
  if (!base) return null;
  const tenant = tenantKey ? FIXTURE_TENANTS[tenantKey] : null;
  return tenant ? { ...base, tenant: { ...base.tenant, ...tenant } } : base;
}
