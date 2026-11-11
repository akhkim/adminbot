// The letter queue read after the clock has run out: which requests passed their deadline while the
// portal still calls them open, and what the student is asked about them.
//
// A professor often submits a letter straight to the school's own portal and never comes back to
// mark it here, so "past due and still open" usually means "done, but nobody said so". The student
// is the one who can tell -- the school confirms receipt to them -- so they are the one asked.
//
// Pure, like the before-deadline reminder beside it: the requests and the instant arrive as
// arguments and the result is a decision. The service resolves the address and does the sending.
import {
  adminBotLogisticsSettledStatuses,
  type AdminBotLogisticsRequest,
} from "../../contracts/actions.js";
import { requestDeadlineDetails } from "./requests.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long after the deadline the question is still worth asking.
 *
 * Past this a stale request is history, not a loose end; asking about a letter from last season
 * reads as the portal having lost track rather than checking in.
 */
export const adminBotRecLetterOverdueMaxDays = 60;

const SCHOOLS_LISTED = 5;

const SETTLED = new Set<string>(adminBotLogisticsSettledStatuses);

export type RecLetterOverdueDue = {
  request_id: string;
  member_id: string;
  member_name: string;
  /** RFC3339 instant of the earliest typed letter deadline. */
  deadline_at: string;
  /** Original wall-clock deadline, for the human reading the mail. */
  deadline_label: string;
  /** Whole days since that instant. 0 is "earlier today". */
  days_overdue: number;
  schools: string[];
};

export function recLetterOverdueConfirmationsDue(
  requests: readonly AdminBotLogisticsRequest[],
  now: Date,
  maxDaysPast: number = adminBotRecLetterOverdueMaxDays,
): RecLetterOverdueDue[] {
  if (!Number.isInteger(maxDaysPast) || maxDaysPast < 0 || maxDaysPast > 366) {
    return [];
  }
  const nowMs = now.getTime();
  return requests
    .filter((request) => request.kind === "recommendation_letters" && !SETTLED.has(request.status))
    .flatMap((request) => {
      // A typed date only. Asking a student whether a letter went in by a deadline the portal
      // guessed the year of would be asking about a date nobody actually named.
      const deadline = requestDeadlineDetails(request, { inferYear: false });
      const deadlineMs = deadline?.at ? Date.parse(deadline.at) : Number.NaN;
      if (!deadline?.at || !Number.isFinite(deadlineMs) || nowMs <= deadlineMs) {
        return [];
      }
      const daysOverdue = Math.floor((nowMs - deadlineMs) / DAY_MS);
      if (daysOverdue > maxDaysPast) {
        return [];
      }
      return [
        {
          request_id: request.id,
          member_id: request.member_id,
          member_name: request.member_name,
          deadline_at: deadline.at,
          deadline_label: `${deadline.date} ${deadline.time} ${deadline.timezone}`,
          days_overdue: daysOverdue,
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
 * Keyed by request and deadline, like the reminder's, so a corrected date re-arms the question
 * against the new one. The prefix differs from the reminder's so the two never silence each other.
 */
export function recLetterOverdueLedgerSubject(
  due: Pick<RecLetterOverdueDue, "request_id" | "deadline_at">,
): string {
  return `rec_letter_overdue|${due.request_id}|${due.deadline_at}`;
}

/** The prefix every subject for one request starts with, whatever deadline it carried. */
export function recLetterOverdueLedgerPrefix(requestId: string): string {
  return `rec_letter_overdue|${requestId}|`;
}

/**
 * What the mail is called. One student, possibly several requests: one mail, because two
 * separate "did this go in?" notes on one morning is the portal nagging.
 */
export function recLetterOverdueSubject(due: readonly RecLetterOverdueDue[]): string {
  return due.length === 1
    ? "Did your recommendation letter go in?"
    : `Did your ${due.length} recommendation letters go in?`;
}

export function recLetterOverdueBody(
  due: readonly RecLetterOverdueDue[],
  requestsUrl: string,
): string {
  const first = due[0];
  const name = first?.member_name.split(/\s+/u)[0] || "there";
  const one = due.length === 1;
  return [
    `Hi ${name},`,
    "",
    one
      ? "The deadline on this recommendation letter request has passed, and the lab portal still shows it as not submitted:"
      : "The deadlines on these recommendation letter requests have passed, and the lab portal still shows them as not submitted:",
    "",
    ...due.map((entry) => {
      const schools = describeSchools(entry.schools);
      return `• ${schools || "Recommendation letters"} — due ${entry.deadline_label}`;
    }),
    "",
    one
      ? "Did the letter go in? Schools usually confirm receipt to you, not to the professor. If it did, open your requests and press “Letter was submitted” so the professor’s queue is up to date:"
      : "Did the letters go in? Schools usually confirm receipt to you, not to the professor. For each one that did, open your requests and press “Letter was submitted” so the professor’s queue is up to date:",
    requestsUrl,
    "",
    "If it has not gone in yet, no action is needed here; the request stays open on the professor’s desk.",
    "",
    "You will only get this note once per request.",
  ].join("\n");
}

function describeSchools(schools: readonly string[]): string {
  if (schools.length === 0) {
    return "";
  }
  if (schools.length <= SCHOOLS_LISTED) {
    return schools.join(", ");
  }
  return `${schools.slice(0, SCHOOLS_LISTED).join(", ")} and ${schools.length - SCHOOLS_LISTED} more`;
}
