import test from "node:test";
import assert from "node:assert/strict";
import {
  compareMessageCursors,
  countUnreadCoachMessages,
  messageCursorPostgrestFilter,
  messageLastSeenKey,
  messageRequestIsCurrent,
  newestCoachMessageCursor,
  normalizeMessageCursor,
  readMessageLastSeen,
  resolveMessagePresence,
  unreadBadgeLabel,
  writeMessageLastSeen,
} from "./clientMessagePresence.js";

function storageFixture() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const COACH_1 = "11111111-1111-4111-8111-111111111111";
const CLIENT_1 = "22222222-2222-4222-8222-222222222222";
const COACH_2 = "33333333-3333-4333-8333-333333333333";
const COACH_3 = "44444444-4444-4444-8444-444444444444";
const rows = [
  { id: COACH_1, sender_role: "coach", sent_at: "2026-08-21T10:00:00.000Z" },
  { id: CLIENT_1, sender_role: "client", sent_at: "2026-08-21T10:05:00.000Z" },
  { id: COACH_2, sender_role: "coach", sent_at: "2026-08-21T10:10:00.000Z" },
];

const cursor = (sentAt, id = "") => ({ sentAt, id });

test("last-seen keys isolate users and clients", () => {
  assert.equal(messageLastSeenKey({ userId: "u1", clientId: "c1" }), "coachapp:client-messages:last-seen:u1:c1");
  assert.notEqual(
    messageLastSeenKey({ userId: "u1", clientId: "c1" }),
    messageLastSeenKey({ userId: "u2", clientId: "c1" }),
  );
  assert.equal(messageLastSeenKey({ userId: null, clientId: "c1" }), null);
});

test("storage accepts the cursor tuple, migrates legacy timestamps, and rejects hostile values", () => {
  const storage = storageFixture();
  const key = messageLastSeenKey({ userId: "u1", clientId: "c1" });
  storage.setItem(key, "2026-08-21T10:00:00.000Z");
  assert.deepEqual(readMessageLastSeen(storage, key), cursor("2026-08-21T10:00:00.000Z"));
  assert.equal(writeMessageLastSeen(storage, key, cursor(rows[0].sent_at, COACH_1)), true);
  assert.deepEqual(readMessageLastSeen(storage, key), cursor("2026-08-21T10:00:00.000Z", COACH_1));
  storage.setItem(key, JSON.stringify({ sentAt: rows[0].sent_at, id: "id.gt.injected" }));
  assert.equal(readMessageLastSeen(storage, key), null);
  assert.equal(readMessageLastSeen({ getItem: () => { throw new Error("blocked"); } }, key), null);
});

test("cursor ordering is deterministic when timestamps tie", () => {
  const early = cursor("2026-08-21T10:00:00.000Z", COACH_1);
  const laterTie = cursor("2026-08-21T10:00:00.000Z", COACH_2);
  assert.equal(compareMessageCursors(laterTie, early) > 0, true);
  assert.equal(countUnreadCoachMessages([
    rows[0],
    { id: COACH_2, sender_role: "coach", sent_at: rows[0].sent_at },
  ], early), 1);
  assert.equal(countUnreadCoachMessages([
    rows[0],
    { id: COACH_2, sender_role: "coach", sent_at: rows[0].sent_at },
  ], cursor(rows[0].sent_at)), 0, "legacy timestamps treat their entire timestamp as seen");
});

test("newest coach cursor ignores client messages and malformed rows", () => {
  assert.deepEqual(newestCoachMessageCursor(rows), cursor("2026-08-21T10:10:00.000Z", COACH_2));
  assert.equal(newestCoachMessageCursor([{ id: CLIENT_1, sender_role: "client", sent_at: rows[1].sent_at }]), null);
  assert.equal(newestCoachMessageCursor([{ id: COACH_1, sender_role: "coach", sent_at: "bad" }]), null);
});

test("PostgREST unread filter is canonical and cannot retain unvalidated cursor text", () => {
  assert.equal(
    messageCursorPostgrestFilter(cursor("2026-08-21T10:00:00.000Z", COACH_1)),
    `sent_at.gt.2026-08-21T10:00:00.000Z,and(sent_at.eq.2026-08-21T10:00:00.000Z,id.gt.${COACH_1})`,
  );
  assert.equal(messageCursorPostgrestFilter(cursor("2026-08-21T10:00:00.000Z")), "sent_at.gt.2026-08-21T10:00:00.000Z");
  const hostileLooking = messageCursorPostgrestFilter({ sentAt: "sent_at.gt.1900", id: COACH_1 });
  assert.match(hostileLooking, /^sent_at\.gt\.1900-01-01T\d{2}:00:00\.000Z,/);
  assert.equal(hostileLooking.includes("sent_at.gt.sent_at"), false);
});

test("first successful read establishes a quiet baseline", () => {
  assert.deepEqual(resolveMessagePresence(rows, null, { baselineAt: "2026-08-21T11:00:00.000Z" }), {
    lastSeenCursor: cursor("2026-08-21T10:10:00.000Z", COACH_2),
    unreadCount: 0,
    initialized: true,
  });
  assert.deepEqual(resolveMessagePresence([], null, { baselineAt: "2026-08-21T11:00:00.000Z" }), {
    lastSeenCursor: cursor("2026-08-21T11:00:00.000Z"),
    unreadCount: 0,
    initialized: true,
  });
  assert.deepEqual(resolveMessagePresence(rows, null, {
    baselineAt: "2026-08-21T11:00:00.000Z",
    newestCoachCursor: cursor("2026-08-21T12:00:00.000Z", COACH_3),
  }), {
    lastSeenCursor: cursor("2026-08-21T10:10:00.000Z", COACH_2),
    unreadCount: 1,
    initialized: true,
  });
  assert.deepEqual(resolveMessagePresence([], null, {
    baselineAt: "2026-08-21T12:00:01.000Z",
    newestCoachCursor: cursor("2026-08-21T12:00:00.000Z", COACH_3),
  }), {
    lastSeenCursor: cursor("2026-08-21T11:59:59.999Z"),
    unreadCount: 1,
    initialized: true,
  });
});

test("opening a successful thread advances only to a coach message present in returned rows", () => {
  const seen = cursor("2026-08-21T10:00:00.000Z", COACH_1);
  const concurrentCursorOutsideRows = cursor("2026-08-21T12:00:00.000Z", COACH_3);
  assert.deepEqual(resolveMessagePresence(rows, seen, { markSeen: true, newestCoachCursor: concurrentCursorOutsideRows }), {
    lastSeenCursor: cursor("2026-08-21T10:10:00.000Z", COACH_2),
    unreadCount: 1,
    initialized: false,
  });
  assert.deepEqual(resolveMessagePresence(rows, seen, { unreadCount: 137 }), {
    lastSeenCursor: seen,
    unreadCount: 137,
    initialized: false,
  });
});

test("off-tab reconciliation does not let a stale exact zero erase returned unread rows", () => {
  const seen = cursor("2026-08-21T10:00:00.000Z", COACH_1);
  const returnedAfterCountSnapshot = [
    { id: COACH_2, sender_role: "coach", sent_at: "2026-08-21T10:10:00.000Z" },
  ];

  assert.deepEqual(resolveMessagePresence(returnedAfterCountSnapshot, seen, { unreadCount: 0 }), {
    lastSeenCursor: seen,
    unreadCount: 1,
    initialized: false,
  });
});

test("opening a newest-100 window cannot hide 37 older unread coach messages", () => {
  const seen = cursor("2026-08-21T09:00:00.000Z", COACH_1);
  const newestHundred = Array.from({ length: 100 }, (_, index) => ({
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, "0")}`,
    sender_role: "coach",
    sent_at: new Date(Date.parse("2026-08-21T10:00:00.000Z") + index * 1000).toISOString(),
  }));

  assert.deepEqual(resolveMessagePresence(newestHundred, seen, {
    markSeen: true,
    newestCoachCursor: newestCoachMessageCursor(newestHundred),
    unreadCount: 137,
  }), {
    // A single forward-only cursor cannot acknowledge the rendered newest rows while
    // 37 older unread rows sit before them. Advancing would make those rows unreachable.
    lastSeenCursor: seen,
    unreadCount: 137,
    initialized: false,
  });

  const concurrentNewer = cursor("2026-08-21T12:00:00.000Z", COACH_3);
  assert.deepEqual(resolveMessagePresence(newestHundred, seen, {
    markSeen: true,
    newestCoachCursor: concurrentNewer,
    unreadCount: 138,
  }), {
    // The extra concurrent row proves at least one unread is newer, but it cannot prove
    // the other 37 excess rows are newer rather than older. The pointer stays put.
    lastSeenCursor: seen,
    unreadCount: 138,
    initialized: false,
  });
});

test("request ownership rejects account switches, superseded requests, and stale tab work", () => {
  const request = { key: "u1:c1", ownerVersion: 1, requestId: 5 };
  assert.equal(messageRequestIsCurrent(request, { key: "u1:c1", ownerVersion: 1, requestId: 5 }), true);
  assert.equal(messageRequestIsCurrent(request, { key: "u2:c2", ownerVersion: 2, requestId: 6 }), false);
  assert.equal(messageRequestIsCurrent(request, { key: "u1:c1", ownerVersion: 1, requestId: 6 }), false);
});

test("cursor normalization canonicalizes timestamps and badge labels stay compact", () => {
  assert.deepEqual(normalizeMessageCursor(cursor("2026-08-21T05:00:00-05:00", COACH_1)), cursor("2026-08-21T10:00:00.000Z", COACH_1));
  assert.equal(unreadBadgeLabel(0), null);
  assert.equal(unreadBadgeLabel(1), "1");
  assert.equal(unreadBadgeLabel(99), "99");
  assert.equal(unreadBadgeLabel(100), "99+");
});
