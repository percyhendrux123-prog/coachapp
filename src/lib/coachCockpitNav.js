function hasUnseenCheckin(row) {
  return Boolean(row?.latestCheckin && !row.latestCheckin.coach_seen && row.client?.id);
}

export function unseenCheckinClients(rows = []) {
  return rows.filter(hasUnseenCheckin);
}

export function firstUnseenCheckinHref(stats, rows = []) {
  if (!stats || !stats.unseenCheckins) return null;
  const first = unseenCheckinClients(rows)[0];
  if (!first) return null;
  return `/coach/clients?client=${first.client.id}&tab=checkins`;
}

export function openCheckinHref(row) {
  if (!hasUnseenCheckin(row)) return null;
  return `/coach/clients?client=${row.client.id}&tab=checkins`;
}
