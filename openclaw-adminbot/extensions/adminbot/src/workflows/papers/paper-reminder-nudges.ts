// The reminder nudges a paper is due: a DM to its authors when the next nudge comes round, or the
// head professor once the authors have gone quiet for long enough after one.
import type { AdminBotPaperNudge, AdminBotPaperRecord } from "../../contracts/actions.js";

export function duePaperNudges(paper: AdminBotPaperRecord, nowIso: string): AdminBotPaperNudge[] {
  const reminder = paper.reminder;
  if (reminder?.status !== "waiting_on_authors") {
    return [];
  }
  if (reminder.last_author_dm_at && replyAfterLastDm(reminder)) {
    return [];
  }
  const escalationBusinessDays = reminder.escalation_after_business_days ?? 3;
  const elapsedBusinessDays = reminder.last_author_dm_at
    ? countBusinessDays(reminder.last_author_dm_at, nowIso)
    : 0;
  if (
    reminder.last_author_dm_at &&
    elapsedBusinessDays >= escalationBusinessDays &&
    reminder.head_professor_member_id
  ) {
    return [
      {
        type: "head_professor_escalation",
        paper_id: paper.id,
        title: paper.title,
        step: paper.current_step,
        recipients: [reminder.head_professor_member_id],
        business_days_since_author_dm: elapsedBusinessDays,
        message:
          `Authors have not replied for ${elapsedBusinessDays} business days. ` +
          `Ask the head professor to remind them about ${paper.current_step}.`,
      },
    ];
  }
  if (reminder.next_nudge_at && reminder.next_nudge_at > nowIso) {
    return [];
  }
  return [
    {
      type: "author_nudge",
      paper_id: paper.id,
      title: paper.title,
      step: paper.current_step,
      recipients: paper.authors,
      message: `Remind authors to complete ${paper.current_step} for "${paper.title}".`,
    },
  ];
}

function replyAfterLastDm(reminder: { last_author_dm_at?: string; last_author_reply_at?: string }) {
  return Boolean(
    reminder.last_author_dm_at &&
    reminder.last_author_reply_at &&
    reminder.last_author_reply_at > reminder.last_author_dm_at,
  );
}

function countBusinessDays(startIso: string, endIso: string): number {
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
