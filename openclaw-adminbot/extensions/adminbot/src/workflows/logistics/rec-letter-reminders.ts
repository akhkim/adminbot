// The letter queue read against the clock: which requests are close enough to be worth saying out
// loud, and what the mail about them says.
//
// The queue itself is the one on My Desk -- open recommendation-letter requests, soonest first --
// and this reads the same `deadline_at` the desk sorts on rather than re-deriving a date from the
// schools table. Two readings of one deadline is how a letter gets written against the wrong one.
//
// Pure: the requests and the instant arrive as arguments and the result is a decision. The service
// resolves the recipient and does the sending, which is what lets the window be tested without a
// clock, a roster or a mailbox.
import {
  adminBotLogisticsSettledStatuses,
  type AdminBotLogisticsRequest,
} from "../../contracts/actions.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far ahead of a letter's deadline the reminder goes out.
 *
 * Three days, as asked. Long enough that a letter can still be written after reading it, short
 * enough that it is about this week -- a fortnight's notice about a letter is a mail that gets
 * archived and then needed.
 */
export const adminBotRecLetterReminderLeadDays = 3;

/** How many schools a reminder line names before it stops listing them. */
const SCHOOLS_LISTED = 5;

const SETTLED = new Set<string>(adminBotLogisticsSettledStatuses);

export type RecLetterReminderDue = {
  request_id: string;
  member_id: string;
  member_name: string;
  /** RFC3339, straight off the request: the soonest thing it is working towards. */
  deadline_at: string;
  /** Whole days left before that instant. 0 is "some time today". */
  days_until: number;
  /** The schools on the request, in the order the member listed them. */
  schools: string[];
};

/**
 * Every open letter request whose deadline is inside the window.
 *
 * Counted from the instant and floored: the reminder fires on the first morning fewer than four
 * whole days are left, which for the end-of-day deadlines the form produces is the calendar day
 * three days before. My Desk rounds the same gap the other way for its label, and is right to --
 * a queue read at a glance should never say a letter is nearer than it is -- but a countdown that
 * has to fire on one particular morning cannot round away the morning it was aimed at.
 *
 * The late side is open -- anything from the deadline up to the window fires -- so a pass that did
 * not run yesterday still sends today rather than skipping the letter entirely. The say-once ledger
 * in the service is what stops the open end becoming a daily repeat.
 */
export function recLetterRemindersDue(
  requests: readonly AdminBotLogisticsRequest[],
  now: Date,
  leadDays: number = adminBotRecLetterReminderLeadDays,
): RecLetterReminderDue[] {
  const nowMs = now.getTime();
  return requests
    .filter((request) => request.kind === "recommendation_letters" && !SETTLED.has(request.status))
    .flatMap((request) => {
      const deadlineAt = request.deadline_at;
      const deadlineMs = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
      // A request with no deadline on file is a real state, not a zero: the member has asked for
      // the letter without filling in a date. There is nothing to count down to, so it waits on
      // the desk rather than producing a reminder about an instant nobody named.
      if (!deadlineAt || !Number.isFinite(deadlineMs)) {
        return [];
      }
      const daysUntil = Math.floor((deadlineMs - nowMs) / DAY_MS);
      if (daysUntil < 0 || daysUntil > leadDays) {
        return [];
      }
      return [
        {
          request_id: request.id,
          member_id: request.member_id,
          member_name: request.member_name,
          deadline_at: deadlineAt,
          days_until: daysUntil,
          schools: (request.schools ?? [])
            .map((school) => school.school.trim())
            .filter((school) => school.length > 0),
        },
      ];
    })
    .toSorted(
      (left, right) =>
        left.deadline_at.localeCompare(right.deadline_at) ||
        left.request_id.localeCompare(right.request_id),
    );
}

/**
 * The say-once ledger subject.
 *
 * Keyed by the request and the deadline it carried, so a school date that moves re-arms the
 * reminder against the new one -- and re-saving the same request does not.
 */
export function recLetterReminderLedgerSubject(due: RecLetterReminderDue): string {
  return `rec_letter|${due.request_id}|${due.deadline_at}`;
}

/** "today" / "tomorrow" / "in 3 days", for a line that has to read as a sentence. */
export function recLetterReminderWhen(daysUntil: number): string {
  if (daysUntil <= 0) {
    return "today";
  }
  return daysUntil === 1 ? "tomorrow" : `in ${daysUntil} days`;
}

/**
 * What the mail is called.
 *
 * One request names it; several count them, because a subject line listing four people is a
 * subject line nobody reads to the end.
 */
export function recLetterReminderSubject(
  due: readonly RecLetterReminderDue[],
  leadDays: number = adminBotRecLetterReminderLeadDays,
): string {
  const first = due[0];
  if (due.length === 1 && first) {
    return `Recommendation letter for ${first.member_name} is due ${recLetterReminderWhen(first.days_until)}`;
  }
  return `${due.length} recommendation letters due within ${leadDays} days`;
}

/**
 * The mail itself: one line per request, soonest first.
 *
 * One mail however many letters are due, rather than one each. Four separate reminders in one
 * morning is the desk being nagged, which is the thing a reminder must not become -- and the
 * letters are written in one sitting anyway.
 */
export function recLetterReminderBody(
  due: readonly RecLetterReminderDue[],
  portalUrl: string,
): string {
  return [
    due.length === 1
      ? "A recommendation letter request is coming due:"
      : "These recommendation letter requests are coming due:",
    "",
    ...due.map((entry) => {
      const schools = describeSchools(entry.schools);
      return `• ${entry.member_name} — due ${entry.deadline_at.slice(0, 10)} (${recLetterReminderWhen(entry.days_until)})${schools ? ` — ${schools}` : ""}`;
    }),
    "",
    `The requests, with the schools table and what each member sent in: ${portalUrl}`,
  ].join("\n");
}

/** The schools on one request, cut off before the line becomes a paragraph. */
function describeSchools(schools: readonly string[]): string {
  if (schools.length === 0) {
    return "";
  }
  if (schools.length <= SCHOOLS_LISTED) {
    return schools.join(", ");
  }
  const listed = schools.slice(0, SCHOOLS_LISTED).join(", ");
  return `${listed} and ${schools.length - SCHOOLS_LISTED} more`;
}
