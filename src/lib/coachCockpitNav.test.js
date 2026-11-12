import test from "node:test";
import assert from "node:assert/strict";
import {
  firstUnseenCheckinHref,
  openCheckinHref,
  unseenCheckinClients,
} from "./coachCockpitNav.js";

function row({ id, name, seen, submittedAt = "2026-08-19T12:00:00.000Z" }) {
  return {
    client: { id, display_name: name },
    latestCheckin: submittedAt === null
      ? null
      : { id: `ck-${id}`, submitted_at: submittedAt, coach_seen: seen },
  };
}

test("firstUnseenCheckinHref opens the first unseen client Check-ins tab", () => {
  const rows = [
    row({ id: "seen-1", name: "Reviewed", seen: true }),
    row({ id: "unseen-a", name: "Alex", seen: false }),
    row({ id: "unseen-b", name: "Blake", seen: false }),
  ];

  assert.equal(
    firstUnseenCheckinHref({ unseenCheckins: 2 }, rows),
    "/coach/clients?client=unseen-a&tab=checkins",
  );
});

test("firstUnseenCheckinHref stays inert for zero, failed, and unresolved counts", () => {
  const unseen = [row({ id: "unseen-a", name: "Alex", seen: false })];

  assert.equal(firstUnseenCheckinHref({ unseenCheckins: 0 }, unseen), null);
  assert.equal(firstUnseenCheckinHref(null, unseen), null);
  assert.equal(firstUnseenCheckinHref(undefined, unseen), null);
  assert.equal(firstUnseenCheckinHref({ unseenCheckins: 1 }, []), null);
  assert.equal(
    firstUnseenCheckinHref({ unseenCheckins: 1 }, [row({ id: "seen-1", name: "Reviewed", seen: true })]),
    null,
  );
});

test("unseenCheckinClients keeps every unseen row so the queue stays discoverable", () => {
  const rows = [
    row({ id: "seen-1", name: "Reviewed", seen: true }),
    row({ id: "unseen-a", name: "Alex", seen: false }),
    row({ id: "none", name: "No check-in", seen: false, submittedAt: null }),
    row({ id: "unseen-b", name: "Blake", seen: false }),
  ];

  assert.deepEqual(
    unseenCheckinClients(rows).map((r) => r.client.id),
    ["unseen-a", "unseen-b"],
  );
});

test("openCheckinHref is an explicit locate action and never implies mark-seen", () => {
  const unseen = row({ id: "unseen-a", name: "Alex", seen: false });
  const seen = row({ id: "seen-1", name: "Reviewed", seen: true });
  const empty = row({ id: "none", name: "No check-in", seen: false, submittedAt: null });

  assert.equal(openCheckinHref(unseen), "/coach/clients?client=unseen-a&tab=checkins");
  assert.equal(openCheckinHref(seen), null);
  assert.equal(openCheckinHref(empty), null);
  assert.equal(openCheckinHref(null), null);
});
