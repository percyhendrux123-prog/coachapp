// Tests for the coach Activity ledger's training-event merge (activityFeed.js).
// Pure module, no supabase import — runs under plain `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import { trainingEventsFromSessions, mergeActivityFeeds } from "./activityFeed.js";

const session = (over = {}) => ({
  id: "s1",
  status: "complete",
  completed_at: "2026-08-31T20:49:00Z",
  clients: { display_name: "Micheal" },
  workout_logs: [{ done: true, logged_at: "2026-08-31T20:48:00Z" }],
  ...over,
});

test("a completed session with done sets becomes one line with the done count", () => {
  const rows = trainingEventsFromSessions([
    session({ workout_logs: [{ done: true }, { done: true }, { done: false }] }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "completed a session — 2 sets");
  assert.equal(rows[0].clientName, "Micheal");
  assert.equal(rows[0].at, "2026-08-31T20:49:00Z");
});

test("a completed session with zero done sets reads as its own distinct fact, not a real workout", () => {
  const rows = trainingEventsFromSessions([session({ workout_logs: [] })]);
  assert.equal(rows[0].label, "finished a session — no sets marked done");
});

test("an in-progress session with done sets shows as logging, timestamped at its latest set", () => {
  const rows = trainingEventsFromSessions([
    session({
      status: "in_progress",
      completed_at: null,
      workout_logs: [
        { done: true, logged_at: "2026-08-31T20:40:00Z" },
        { done: true, logged_at: "2026-08-31T20:45:00Z" },
      ],
    }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "logging a workout — 2 sets so far");
  assert.equal(rows[0].at, "2026-08-31T20:45:00Z");
});

test("an in-progress session with no done sets emits nothing (a bare Start is not activity)", () => {
  const rows = trainingEventsFromSessions([
    session({ status: "in_progress", completed_at: null, workout_logs: [{ done: false, logged_at: "2026-08-31T20:40:00Z" }] }),
  ]);
  assert.equal(rows.length, 0);
});

test("singular set count reads 'set', not 'sets'", () => {
  const rows = trainingEventsFromSessions([session({ workout_logs: [{ done: true }] })]);
  assert.equal(rows[0].label, "completed a session — 1 set");
});

test("merge interleaves ledger and training rows newest-first and caps at the limit", () => {
  const ledger = [
    { id: "l1", at: "2026-08-31T19:00:00Z", label: "submitted a check-in" },
    { id: "l2", at: "2026-08-31T21:00:00Z", label: "messaged the coach" },
  ];
  const training = [{ id: "t1", at: "2026-08-31T20:49:00Z", label: "completed a session — 17 sets" }];
  const merged = mergeActivityFeeds(ledger, training);
  assert.deepEqual(merged.map((r) => r.id), ["l2", "t1", "l1"]);
  assert.equal(mergeActivityFeeds(ledger, training, { limit: 2 }).length, 2);
});

test("rows with no timestamp are dropped rather than sorted arbitrarily", () => {
  const merged = mergeActivityFeeds([{ id: "l1", at: null }], [{ id: "t1", at: "2026-08-31T20:00:00Z" }]);
  assert.deepEqual(merged.map((r) => r.id), ["t1"]);
});
