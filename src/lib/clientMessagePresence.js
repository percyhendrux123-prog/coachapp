const LAST_SEEN_PREFIX = "coachapp:client-messages:last-seen";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function normalizeMessageCursor(value) {
  let candidate = value;
  if (typeof value === "string") {
    try { candidate = JSON.parse(value); } catch { candidate = { sentAt: value, id: "" }; }
  }
  const sentAt = validTimestamp(candidate?.sentAt);
  if (!sentAt) return null;
  const id = candidate?.id === "" || candidate?.id == null
    ? ""
    : UUID_PATTERN.test(candidate.id) ? candidate.id.toLowerCase() : null;
  return id == null ? null : { sentAt, id };
}

export function messageCursorForRow(row) {
  return normalizeMessageCursor({ sentAt: row?.sent_at, id: row?.id });
}

export function compareMessageCursors(left, right) {
  const a = normalizeMessageCursor(left);
  const b = normalizeMessageCursor(right);
  if (!a || !b) return null;
  const timeDelta = Date.parse(a.sentAt) - Date.parse(b.sentAt);
  if (timeDelta !== 0) return timeDelta;
  return a.id.localeCompare(b.id);
}

export function messageLastSeenKey({ userId, clientId }) {
  if (!userId || !clientId) return null;
  return `${LAST_SEEN_PREFIX}:${userId}:${clientId}`;
}

export function readMessageLastSeen(storage, key) {
  if (!storage || !key) return null;
  try {
    return normalizeMessageCursor(storage.getItem(key));
  } catch {
    return null;
  }
}

export function writeMessageLastSeen(storage, key, value) {
  const cursor = normalizeMessageCursor(value);
  if (!storage || !key || !cursor) return false;
  try {
    storage.setItem(key, JSON.stringify(cursor));
    return true;
  } catch {
    return false;
  }
}

export function newestCoachMessageCursor(rows) {
  let newest = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.sender_role !== "coach") continue;
    const cursor = messageCursorForRow(row);
    if (!cursor) continue;
    if (!newest || compareMessageCursors(cursor, newest) > 0) newest = cursor;
  }
  return newest;
}

export function countUnreadCoachMessages(rows, lastSeenCursor) {
  const seen = normalizeMessageCursor(lastSeenCursor);
  if (!seen) return 0;
  return (Array.isArray(rows) ? rows : []).reduce((count, row) => {
    if (row?.sender_role !== "coach") return count;
    const cursor = messageCursorForRow(row);
    if (!cursor) return count;
    // A legacy timestamp has no deterministic tie-break ID. Treat that timestamp as
    // fully seen so the message that established the old pointer is not recounted.
    const isUnread = seen.id
      ? compareMessageCursors(cursor, seen) > 0
      : Date.parse(cursor.sentAt) > Date.parse(seen.sentAt);
    return isUnread ? count + 1 : count;
  }, 0);
}

export function messageCursorPostgrestFilter(value) {
  const cursor = normalizeMessageCursor(value);
  if (!cursor) return null;
  if (!cursor.id) return `sent_at.gt.${cursor.sentAt}`;
  return `sent_at.gt.${cursor.sentAt},and(sent_at.eq.${cursor.sentAt},id.gt.${cursor.id})`;
}

export function resolveMessagePresence(
  rows,
  lastSeenCursor,
  { markSeen = false, baselineAt = null, newestCoachCursor = null, unreadCount = null } = {},
) {
  const current = normalizeMessageCursor(lastSeenCursor);
  const newestInRows = newestCoachMessageCursor(rows);
  const newest = normalizeMessageCursor(newestCoachCursor) || newestInRows;

  if (!current) {
    // First-load quiet seeding is bounded by the returned thread snapshot. A separate
    // latest-cursor read can outrun those rows; that message remains unread.
    const baseline = normalizeMessageCursor({ sentAt: baselineAt, id: "" });
    const beforeExternal = newest
      ? normalizeMessageCursor({ sentAt: new Date(Date.parse(newest.sentAt) - 1).toISOString(), id: "" })
      : null;
    const seed = newestInRows || beforeExternal || baseline;
    const latestOutrunsRows = newest && seed && compareMessageCursors(newest, seed) > 0;
    return {
      lastSeenCursor: seed,
      unreadCount: latestOutrunsRows ? Math.max(Number.isInteger(unreadCount) ? unreadCount : 0, 1) : 0,
      initialized: true,
    };
  }

  if (markSeen) {
    // Seeing is bounded by rows actually returned. Exact count and the ancillary
    // latest cursor preserve any message that arrived outside that snapshot.
    const newestIsLater = newestInRows && compareMessageCursors(newestInRows, current) > 0;
    const seenThrough = newestIsLater ? newestInRows : current;
    const renderedUnread = countUnreadCoachMessages(rows, current);
    const exactIsUsable = Number.isInteger(unreadCount) && unreadCount >= 0;
    const latestOutrunsRows = newest && compareMessageCursors(newest, seenThrough) > 0;
    // listMessages() is capped at the newest 100 rows. A full window may omit older
    // unread messages, so advancing a forward-only pointer through that window could
    // cross messages the client never rendered. Independent count/latest snapshots
    // cannot prove otherwise. Preserve the pointer until pagination/contiguous reads
    // make the omitted interval observable.
    if (rows.length >= 100 && renderedUnread > 0) {
      const exactFloor = exactIsUsable ? unreadCount : 0;
      return {
        lastSeenCursor: current,
        unreadCount: Math.max(exactFloor, renderedUnread, latestOutrunsRows ? 1 : 0),
        initialized: false,
      };
    }
    const exactRemaining = exactIsUsable
      ? Math.max(unreadCount - renderedUnread, 0)
      : 0;
    return {
      lastSeenCursor: seenThrough,
      unreadCount: latestOutrunsRows ? Math.max(exactRemaining, 1) : exactRemaining,
      initialized: false,
    };
  }

  const renderedUnread = countUnreadCoachMessages(rows, current);
  return {
    lastSeenCursor: current,
    // The exact query and thread window are concurrent snapshots. Returned coach rows
    // are direct evidence, so a stale exact result can never lower their unread floor.
    unreadCount: Number.isInteger(unreadCount) && unreadCount >= 0
      ? Math.max(unreadCount, renderedUnread)
      : renderedUnread,
    initialized: false,
  };
}

export function messageRequestIsCurrent(request, current) {
  return Boolean(
    request?.key
    && request.key === current?.key
    && request.ownerVersion === current?.ownerVersion
    && request.requestId === current?.requestId
  );
}

export function unreadBadgeLabel(count) {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}
