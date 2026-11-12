// ===========================================================================
// Coach cockpit PREVIEW FIXTURES — development / fixture-preview only.
//
// Split into its own module and loaded via dynamic import() from CoachCockpit
// so none of this data is in the production main bundle. ?preview is gated on
// PREVIEW_ROUTES_ENABLED, matching CoachHome + coachOverviewFixtures.
//
// NAMES ARE FICTIONAL. Do not copy live roster identities into this file.
// ===========================================================================

export const PREVIEW_COACH = {
  user: { id: "preview-coach", email: "preview.coach@example.test" },
  role: "coach",
  profile: {
    user_id: "preview-coach",
    role: "coach",
    tenant_id: "a0000000-0000-4000-a000-000000000001",
  },
};

const UNSEEN_CLIENT_ID = "c0000000-0000-4000-a000-0000000000a1";
const SEEN_CLIENT_ID = "c0000000-0000-4000-a000-0000000000a2";

const UNSEEN = {
  generatedAt: "2026-08-19T12:00:00.000Z",
  clients: [
    {
      client: {
        id: UNSEEN_CLIENT_ID,
        display_name: "Alex Rivera",
        email: "alex.rivera@example.test",
        status: "active",
      },
      latestCheckin: {
        id: "ck-preview-unseen",
        submitted_at: "2026-08-19T11:00:00.000Z",
        coach_seen: false,
      },
      latestMessage: null,
      latestWorkout: null,
      latestAssessment: null,
      lastSignalAt: "2026-08-19T11:00:00.000Z",
      score: 80,
      band: "act",
      reasons: ["New check-in needs review."],
      summary: "Latest check-in is unseen. Open it from the metric or the selected client.",
      draft: "Hey Alex, I reviewed your latest update.",
      drafts: { balanced: "Hey Alex, I reviewed your latest update." },
    },
    {
      client: {
        id: SEEN_CLIENT_ID,
        display_name: "Blake Nguyen",
        email: "blake.nguyen@example.test",
        status: "active",
      },
      latestCheckin: {
        id: "ck-preview-seen",
        submitted_at: "2026-08-12T09:00:00.000Z",
        coach_seen: true,
      },
      latestMessage: null,
      latestWorkout: null,
      latestAssessment: null,
      lastSignalAt: "2026-08-12T09:00:00.000Z",
      score: 10,
      band: "steady",
      reasons: ["No urgent signal. Keep on normal rhythm."],
      summary: "Reviewed check-in. No unseen work.",
      draft: "Hey Blake, stay on plan today.",
      drafts: { balanced: "Hey Blake, stay on plan today." },
    },
  ],
  stats: {
    total: 2,
    urgent: 1,
    drafts: 2,
    unseenCheckins: 1,
  },
};

export const COCKPIT_FIXTURES = { unseen: UNSEEN };

export function getCockpitFixture(name) {
  return COCKPIT_FIXTURES[name] ?? null;
}
