// Paper-reminder timing helpers, cut from service.ts so it stays under its file-size ratchet.
// Pure: duePaperNudges in service.ts decides who to nudge; these only measure the wait.

/** True when the authors answered after AdminBot's last DM, so the reminder is satisfied. */
export function replyAfterLastDm(reminder: {
  last_author_dm_at?: string;
  last_author_reply_at?: string;
}) {
  return Boolean(
    reminder.last_author_dm_at &&
    reminder.last_author_reply_at &&
    reminder.last_author_reply_at > reminder.last_author_dm_at,
  );
}

/** Weekdays (UTC) strictly after `startIso` up to and including `endIso`; 0 for a bad range. */
export function countBusinessDays(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    return 0;
  }
  let days = 0;
  const oneDayMs = 24 * 60 * 60 * 1000;
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let dayMs = startDay + oneDayMs; dayMs <= endDay; dayMs += oneDayMs) {
    const cursor = new Date(dayMs);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      days += 1;
    }
  }
  return days;
}
