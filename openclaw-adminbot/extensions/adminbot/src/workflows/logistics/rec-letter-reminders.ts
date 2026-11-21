// The letter queue read against the clock: which requests are close enough to be worth saying out
// loud, and what the mail about them says.
//
// The queue itself is the one on My Desk -- open recommendation-letter requests, soonest first --
// and uses the same letter-only deadline resolver as the queue, including for legacy records.
//
// Pure: the requests and the instant arrive as arguments and the result is a decision. The service
// resolves the recipient and does the sending, which is what lets the window be tested without a
// clock, a roster or a mailbox.
import {
  adminBotLogisticsSettledStatuses,
  type AdminBotLogisticsRequest,
} from "../../contracts/actions.js";
import { toAbsoluteRfc3339 } from "../calendar/time.js";
import { isLetterStatusSubmitted, letterDeadline, type LogisticsDeadline } from "./requests.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Weekdays only; no jurisdiction-specific holiday calendar is configured. */
export const adminBotRecLetterReminderLeadDays = 2;

/** The earlier heads-up opens this many calendar days before a deadline. */
export const adminBotRecLetterReminderWeekDays = 7;

/** The furthest a manual run may look ahead. */
export const adminBotRecLetterReminderMaxWithinDays = 31;

/** How many schools a reminder line names before it stops listing them. */
const SCHOOLS_LISTED = 5;

const SETTLED = new Set<string>(adminBotLogisticsSettledStatuses);

/**
 * Which reminder this is. `final` is the one two business days out; `week` is the heads-up a week
 * out. They are stamped apart, so the heads-up never uses up the last call.
 */
export type RecLetterReminderTier = "final" | "week";

export type RecLetterReminderDue = {
  request_id: string;
  member_id: string;
  member_name: string;
  /** RFC3339 instant of this deadline. Schools sharing the instant share the entry. */
  deadline_at: string;
  /** Original wall-clock deadline, for the human reading the reminder. */
  deadline_label?: string;
  /** Whole days left before that instant. 0 is "some time today". */
  days_until: number;
  /** The schools due at this instant, in the order the member listed them. */
  schools: string[];
  tier: RecLetterReminderTier;
};

export type RecLetterReminderOptions = {
  /**
   * A manual run's look-ahead: any deadline within this many days that is not yet in its final
   * window counts as a heads-up now, even before its week window opens.
   */
  withinDays?: number;
};

/**
 * Every open school deadline on every open letters request, not just the soonest one: a member
 * applying to ELLIS on the 25th and Toronto on the 1st needs a reminder for each.
 *
 * Two windows per deadline, both opening at midnight in the deadline's own zone:
 * - final: two weekdays before, until the deadline itself (missed runs can still catch up);
 * - week: seven days before, until the final window opens.
 * Schools whose letter status says it went in are skipped. The service ledger stops repeats.
 */
export function recLetterRemindersDue(
  requests: readonly AdminBotLogisticsRequest[],
  now: Date,
  leadDays: number = adminBotRecLetterReminderLeadDays,
  options: RecLetterReminderOptions = {},
): RecLetterReminderDue[] {
  if (!Number.isInteger(leadDays) || leadDays < 0 || leadDays > 366) {
    return [];
  }
  const withinDays = options.withinDays;
  const lookAheadMs =
    withinDays !== undefined &&
    Number.isInteger(withinDays) &&
    withinDays > 0 &&
    withinDays <= adminBotRecLetterReminderMaxWithinDays
      ? withinDays * DAY_MS
      : 0;
  const nowMs = now.getTime();
  return requests
    .filter((request) => request.kind === "recommendation_letters" && !SETTLED.has(request.status))
    .flatMap((request) => {
      const groups = new Map<string, { deadline: LogisticsDeadline; schools: string[] }>();
      for (const school of request.schools ?? []) {
        if (isLetterStatusSubmitted(school.letter_status)) {
          continue;
        }
        // Mail goes out on a typed date only; a year inferred for display is not enough to nag on.
        // A school with no date on file has nothing to count down to, so it waits on the desk.
        const deadline = letterDeadline(school, { inferYear: false });
        if (!deadline || !Number.isFinite(Date.parse(deadline.at))) {
          continue;
        }
        const group = groups.get(deadline.at) ?? { deadline, schools: [] };
        const name = school.school.trim();
        if (name) {
          group.schools.push(name);
        }
        groups.set(deadline.at, group);
      }
      return [...groups.values()].flatMap(({ deadline, schools }) => {
        const deadlineMs = Date.parse(deadline.at);
        if (nowMs > deadlineMs) {
          return [];
        }
        const finalAt = windowStart(deadline, weekdaysBefore(deadline.date, leadDays));
        const weekAt = windowStart(
          deadline,
          calendarDaysBefore(deadline.date, adminBotRecLetterReminderWeekDays),
        );
        if (finalAt === undefined) {
          return [];
        }
        let tier: RecLetterReminderTier | undefined;
        if (nowMs >= finalAt) {
          tier = "final";
        } else if (
          (weekAt !== undefined && nowMs >= weekAt) ||
          (lookAheadMs > 0 && deadlineMs - nowMs <= lookAheadMs)
        ) {
          tier = "week";
        }
        if (!tier) {
          return [];
        }
        return [
          {
            request_id: request.id,
            member_id: request.member_id,
            member_name: request.member_name,
            deadline_at: deadline.at,
            deadline_label: `${deadline.date} ${deadline.time} ${deadline.timezone}`,
            days_until: Math.floor((deadlineMs - nowMs) / DAY_MS),
            schools,
            tier,
          },
        ];
      });
    })
    .toSorted(
      (left, right) =>
        left.deadline_at.localeCompare(right.deadline_at) ||
        left.request_id.localeCompare(right.request_id),
    );
}

/** The calendar day `count` weekdays before `date` (YYYY-MM-DD). */
function weekdaysBefore(date: string, count: number): string {
  const day = new Date(`${date}T12:00:00Z`);
  for (let remaining = count; remaining > 0; ) {
    day.setUTCDate(day.getUTCDate() - 1);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      remaining -= 1;
    }
  }
  return day.toISOString().slice(0, 10);
}

/** The calendar day `count` days before `date` (YYYY-MM-DD). */
function calendarDaysBefore(date: string, count: number): string {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() - count);
  return day.toISOString().slice(0, 10);
}

/** Midnight on `day` in the deadline's own zone, as epoch milliseconds. */
function windowStart(deadline: LogisticsDeadline, day: string): number | undefined {
  const at = toAbsoluteRfc3339(`${day}T00:00`, deadline.timezone);
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The say-once ledger subject.
 *
 * Keyed by the request and the deadline it carried, so a school date that moves re-arms the
 * reminder against the new one -- and re-saving the same request does not.
 */
export function recLetterReminderLedgerSubject(
  due: Pick<RecLetterReminderDue, "request_id" | "deadline_at" | "tier">,
): string {
  // The final key is the one used before the week tier existed, so a letter already reminded
  // under the old rule is not reminded again.
  const prefix = due.tier === "week" ? "rec_letter_week" : "rec_letter";
  return `${prefix}|${due.request_id}|${due.deadline_at}`;
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
  if (due.every((entry) => entry.tier === "final")) {
    return `${due.length} recommendation letters due within ${leadDays} business days`;
  }
  const furthest = Math.max(...due.map((entry) => entry.days_until));
  return furthest < adminBotRecLetterReminderWeekDays
    ? `${due.length} recommendation letters due within a week`
    : `${due.length} recommendation letters due in the next ${furthest + 1} days`;
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
  const final = due.filter((entry) => entry.tier === "final");
  const week = due.filter((entry) => entry.tier === "week");
  const intro =
    due.length === 1
      ? "A recommendation letter request is coming due:"
      : "These recommendation letter requests are coming due:";
  const sections =
    final.length && week.length
      ? [
          `Due within ${adminBotRecLetterReminderLeadDays} business days:`,
          ...final.map(reminderLine),
          "",
          "Coming up later:",
          ...week.map(reminderLine),
        ]
      : due.map(reminderLine);
  return [
    intro,
    "",
    ...sections,
    "",
    `The requests, with the schools table and what each member sent in: ${portalUrl}`,
  ].join("\n");
}

function reminderLine(entry: RecLetterReminderDue): string {
  const schools = describeSchools(entry.schools);
  return `• ${entry.member_name} — due ${entry.deadline_label ?? entry.deadline_at.slice(0, 10)} (${recLetterReminderWhen(entry.days_until)})${schools ? ` — ${schools}` : ""}`;
}

/** The schools on one entry, cut off before the line becomes a paragraph. */
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
