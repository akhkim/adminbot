// The professor's escalation digest: what is waiting on her, grouped by how urgent it is, as one
// email a day until each thing is resolved.
//
// She reads email before she reads the portal, so a camera-ready with two days left that only
// shows up on My Desk is a camera-ready she learns about late. Every source here is already a
// queue somewhere in the portal -- the PI review queue, the letter, signature and meeting requests,
// the members who stopped answering, the approvals queue -- and this file reads them against the
// clock rather than keeping a list of its own. Resolving or dismissing a thing where it lives is
// what takes it out of tomorrow's mail; there is no second "done" flag here to forget to set.
//
// Pure: the queues, the instant and the configuration arrive as arguments. The service resolves
// the recipient, the day ledger and the sending (kernel/service.professor-digest.ts).
import {
  adminBotLogisticsSettledStatuses,
  type AdminBotLogisticsRequest,
  type AdminBotStoredProposal,
} from "../../contracts/actions.js";
import { isStaleDeadline } from "../../contracts/paper-feedback.js";
import { toAbsoluteRfc3339 } from "../calendar/time.js";
import { requestDeadlineDetails } from "../logistics/requests.js";
import { paperQueueCategoryLabels } from "../papers/paper-queue.js";
import type { PiReviewRow } from "../papers/pi-review.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The lab is in Toronto; used when neither the env nor the professor's roster row names a zone. */
export const PROFESSOR_DIGEST_DEFAULT_TIMEZONE = "America/Toronto";

/** How many lines one urgency group lists before it says "and N more" and points at the portal. */
const LINES_PER_GROUP = 15;

export type ProfessorDigestConfig = {
  /** Off unless the deployment opts in, so a deploy never starts mailing her on its own. */
  enabled: boolean;
  /** Local hour (0-23) from which the day's digest may go out. Later runs that day catch up. */
  sendHour: number;
  /** IANA zone the send hour and the "one per day" boundary are read in. */
  timezone?: string;
  /** A deadline this close is "due within 48 hours". */
  urgentHours: number;
  /** A deadline this close is "due this week". Further out is not mentioned yet. */
  soonDays: number;
  /** A thing with no deadline is mentioned once it has waited this long. */
  waitingDays: number;
  /**
   * A deadline that passed longer ago than this is treated as obsolete and left out: a camera-ready
   * for a conference that already happened is history, not an emergency. Capped by the shared
   * `isStaleDeadline` horizon either way.
   */
  staleDays: number;
};

export const professorDigestDefaults: ProfessorDigestConfig = {
  enabled: false,
  sendHour: 8,
  urgentHours: 48,
  soonDays: 7,
  waitingDays: 7,
  staleDays: 30,
};

/**
 * The digest's configuration from the host environment.
 *
 * A value that does not parse falls back to its default rather than disabling the digest: a typo
 * in the send hour should move nothing, not silently stop the mail she relies on.
 */
export function resolveProfessorDigestConfig(
  env: Readonly<Record<string, string | undefined>>,
): ProfessorDigestConfig {
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw || !/^\d+$/u.test(raw)) {
      return fallback;
    }
    const value = Number(raw);
    return value >= min && value <= max ? value : fallback;
  };
  const timezone = env.ADMINBOT_PROFESSOR_DIGEST_TIMEZONE?.trim();
  return {
    enabled: env.ADMINBOT_PROFESSOR_DIGEST_ENABLED?.trim() === "1",
    sendHour: int("ADMINBOT_PROFESSOR_DIGEST_HOUR", professorDigestDefaults.sendHour, 0, 23),
    ...(timezone && isValidTimezone(timezone) ? { timezone } : {}),
    urgentHours: int(
      "ADMINBOT_PROFESSOR_DIGEST_URGENT_HOURS",
      professorDigestDefaults.urgentHours,
      1,
      24 * 30,
    ),
    soonDays: int("ADMINBOT_PROFESSOR_DIGEST_SOON_DAYS", professorDigestDefaults.soonDays, 1, 90),
    waitingDays: int(
      "ADMINBOT_PROFESSOR_DIGEST_WAITING_DAYS",
      professorDigestDefaults.waitingDays,
      0,
      365,
    ),
    staleDays: int(
      "ADMINBOT_PROFESSOR_DIGEST_STALE_DAYS",
      professorDigestDefaults.staleDays,
      0,
      90,
    ),
  };
}

export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The local calendar date and hour at `now` in `zone`: the day the ledger stamps and the gate. */
export function professorDigestLocalClock(now: Date, zone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
  };
}

export const professorDigestSources = [
  "paper",
  "rec_letter",
  "signature",
  "meeting_request",
  "missing_info",
  "pending_actions",
] as const;

export type ProfessorDigestSource = (typeof professorDigestSources)[number];

export type ProfessorDigestItem = {
  /**
   * Stable across days, so the ledger can count how many digests a thing has been in. Carries the
   * deadline where there is one, so a moved deadline starts the count again.
   */
  key: string;
  source: ProfessorDigestSource;
  title: string;
  detail?: string;
  /** RFC3339 instant of the hard deadline, when the thing has one. */
  deadline_at?: string;
  /** When the thing started waiting on her, for one with no deadline. */
  waiting_since?: string;
  /** Portal path the line links to, e.g. "/rec-letters". */
  path: string;
};

export type ProfessorDigestQueues = {
  papers: readonly PiReviewRow[];
  requests: readonly AdminBotLogisticsRequest[];
  missingInfo: ReadonlyArray<{
    member_id: string;
    name: string;
    escalated_at: string;
    notifications: ReadonlyArray<{ title: string }>;
  }>;
  pending: readonly Pick<AdminBotStoredProposal, "created_at">[];
};

const SETTLED = new Set<string>(adminBotLogisticsSettledStatuses);

/**
 * Every open thing the portal says is waiting on her, before the clock is applied.
 *
 * "Under review" papers are left out: the venue owes the next move there, not her.
 */
export function professorDigestItems(
  queues: ProfessorDigestQueues,
  now: Date,
  config: Pick<ProfessorDigestConfig, "waitingDays">,
): ProfessorDigestItem[] {
  const items: ProfessorDigestItem[] = [];
  for (const row of queues.papers) {
    if (row.category === "under_review") {
      continue;
    }
    const deadline = row.hard_deadline ?? row.feedback?.hard_deadline;
    const detail = joinDetail([row.venue, row.proofreading?.note ?? row.openreview?.note]);
    items.push({
      key: `paper:${row.paper_id}:${row.category}${deadline ? `:${deadline}` : ""}`,
      source: "paper",
      title: `${paperQueueCategoryLabels[row.category]}: ${row.title}`,
      ...(detail ? { detail } : {}),
      ...(deadline ? { deadline_at: deadline } : {}),
      ...(row.waiting_since ? { waiting_since: row.waiting_since } : {}),
      path: "/professor",
    });
  }
  for (const request of queues.requests) {
    if (SETTLED.has(request.status)) {
      continue;
    }
    const item = requestItem(request);
    if (item) {
      items.push(item);
    }
  }
  for (const member of queues.missingInfo) {
    const count = member.notifications.length;
    items.push({
      key: `missing_info:${member.member_id}`,
      source: "missing_info",
      title: `${member.name} has not answered ${count === 1 ? "a reminder" : `${count} reminders`}`,
      ...(member.notifications[0]?.title ? { detail: member.notifications[0].title } : {}),
      waiting_since: member.escalated_at,
      path: "/professor",
    });
  }
  // One line for the approvals queue, not one per proposal: each is a click on the same page, and
  // a digest that lists forty of them buries the camera-ready above.
  const cutoff = now.getTime() - config.waitingDays * DAY_MS;
  const oldPending = queues.pending
    .map((proposal) => proposal.created_at)
    .filter((created) => Date.parse(created) <= cutoff)
    .toSorted();
  if (oldPending.length > 0) {
    items.push({
      key: "pending_actions",
      source: "pending_actions",
      title:
        oldPending.length === 1
          ? "1 action waiting for approval"
          : `${oldPending.length} actions waiting for approval`,
      waiting_since: oldPending[0],
      path: "/pending-actions",
    });
  }
  return items;
}

function requestItem(request: AdminBotLogisticsRequest): ProfessorDigestItem | undefined {
  const since = { waiting_since: request.submitted_at };
  if (request.kind === "recommendation_letters") {
    // A typed date only: a year inferred for display is not enough to call something overdue.
    const deadline = requestDeadlineDetails(request, { inferYear: false })?.at;
    const schools = (request.schools ?? []).map((school) => school.school.trim()).filter(Boolean);
    return {
      key: `rec_letter:${request.id}${deadline ? `:${deadline}` : ""}`,
      source: "rec_letter",
      title: `Recommendation letter for ${request.member_name}`,
      ...(schools.length ? { detail: describeList(schools) } : {}),
      ...(deadline ? { deadline_at: deadline } : {}),
      ...since,
      path: "/rec-letters",
    };
  }
  if (request.kind === "document_signature") {
    const names = (request.documents ?? []).map((doc) => doc.name).filter(Boolean);
    const detail = joinDetail([
      names.length ? describeList(names) : undefined,
      request.description,
    ]);
    return {
      key: `signature:${request.id}`,
      source: "signature",
      title: `Signature for ${request.member_name}`,
      ...(detail ? { detail } : {}),
      ...since,
      path: "/signatures",
    };
  }
  if (request.kind === "book_meeting") {
    // The meeting's own deadline is the last day the call is still worth placing; the preferred
    // time is a wish, not a cutoff.
    const latest = (request.meetings ?? [])
      .flatMap((meeting) =>
        meeting.latest_ok_date
          ? [toAbsoluteRfc3339(`${meeting.latest_ok_date}T23:59`, meeting.timezone ?? "UTC")]
          : [],
      )
      .filter((at): at is string => Boolean(at))
      .toSorted()[0];
    const purposes = (request.meetings ?? []).map((meeting) => meeting.purpose).filter(Boolean);
    return {
      key: `meeting_request:${request.id}${latest ? `:${latest}` : ""}`,
      source: "meeting_request",
      title: `Meeting with ${request.member_name}`,
      ...(purposes.length ? { detail: describeList(purposes) } : {}),
      ...(latest ? { deadline_at: latest } : {}),
      ...since,
      path: "/meeting-requests",
    };
  }
  return undefined;
}

export const professorDigestBuckets = ["overdue", "due_48h", "due_7d", "waiting"] as const;
export type ProfessorDigestBucket = (typeof professorDigestBuckets)[number];

/**
 * Whether a thing is past mattering, so the digest leaves it out entirely.
 *
 * Local on purpose: a concurrent change is adding stale-hiding to the portal queues, and this
 * should read that shared predicate once it lands. Until then it is the shared 90-day
 * `isStaleDeadline` horizon, tightened to `staleDays` -- a deadline a month gone is not one she
 * can still meet, so mailing her about it daily is noise rather than escalation.
 */
export function isObsoleteForDigest(
  item: Pick<ProfessorDigestItem, "deadline_at">,
  now: Date,
  config: Pick<ProfessorDigestConfig, "staleDays">,
): boolean {
  if (!item.deadline_at) {
    return false;
  }
  const deadline = Date.parse(item.deadline_at);
  if (!Number.isFinite(deadline)) {
    return true;
  }
  return (
    isStaleDeadline(item.deadline_at, now) || now.getTime() - deadline > config.staleDays * DAY_MS
  );
}

/** Which urgency group a thing belongs in, or undefined when it is not worth mentioning yet. */
export function professorDigestBucket(
  item: Pick<ProfessorDigestItem, "deadline_at" | "waiting_since">,
  now: Date,
  config: Pick<ProfessorDigestConfig, "urgentHours" | "soonDays" | "waitingDays" | "staleDays">,
): ProfessorDigestBucket | undefined {
  if (isObsoleteForDigest(item, now, config)) {
    return undefined;
  }
  const nowMs = now.getTime();
  if (item.deadline_at) {
    const left = Date.parse(item.deadline_at) - nowMs;
    if (left < 0) {
      return "overdue";
    }
    if (left <= config.urgentHours * HOUR_MS) {
      return "due_48h";
    }
    if (left <= config.soonDays * DAY_MS) {
      return "due_7d";
    }
    // A deadline further out is a plan, not a backlog, however long the request has sat.
    return undefined;
  }
  const since = item.waiting_since ? Date.parse(item.waiting_since) : Number.NaN;
  if (Number.isFinite(since) && nowMs - since > config.waitingDays * DAY_MS) {
    return "waiting";
  }
  return undefined;
}

export type ProfessorDigestGroups = Record<ProfessorDigestBucket, ProfessorDigestItem[]>;

/** The items grouped by urgency, each group most urgent (or longest waiting) first. */
export function groupProfessorDigest(
  items: readonly ProfessorDigestItem[],
  now: Date,
  config: ProfessorDigestConfig,
): ProfessorDigestGroups {
  const groups: ProfessorDigestGroups = { overdue: [], due_48h: [], due_7d: [], waiting: [] };
  for (const item of items) {
    const bucket = professorDigestBucket(item, now, config);
    if (bucket) {
      groups[bucket].push(item);
    }
  }
  const byDeadline = (left: ProfessorDigestItem, right: ProfessorDigestItem) =>
    (left.deadline_at ?? "").localeCompare(right.deadline_at ?? "") ||
    left.key.localeCompare(right.key);
  const byWaiting = (left: ProfessorDigestItem, right: ProfessorDigestItem) =>
    (left.waiting_since ?? "").localeCompare(right.waiting_since ?? "") ||
    left.key.localeCompare(right.key);
  return {
    overdue: groups.overdue.toSorted(byDeadline),
    due_48h: groups.due_48h.toSorted(byDeadline),
    due_7d: groups.due_7d.toSorted(byDeadline),
    waiting: groups.waiting.toSorted(byWaiting),
  };
}

export function professorDigestCount(groups: ProfessorDigestGroups): number {
  return professorDigestBuckets.reduce((total, bucket) => total + groups[bucket].length, 0);
}

const BUCKET_HEADINGS: Record<ProfessorDigestBucket, string> = {
  overdue: "PAST DEADLINE",
  due_48h: "DUE WITHIN 48 HOURS",
  due_7d: "DUE WITHIN 7 DAYS",
  waiting: "WAITING MORE THAN A WEEK (NO DEADLINE)",
};

/**
 * What the mail is called. Escalates with the most urgent group present, and again once an
 * overdue thing has already been in an earlier digest -- the subject is what she sees in the list,
 * so it carries the urgency the body would otherwise have to be opened to show.
 */
export function professorDigestSubject(
  groups: ProfessorDigestGroups,
  timesFlagged: ReadonlyMap<string, number> = new Map(),
): string {
  const total = professorDigestCount(groups);
  const things = (count: number) => (count === 1 ? "1 item" : `${count} items`);
  const ofTotal = (count: number) => (count === total ? "" : ` (${total} waiting on you)`);
  if (groups.overdue.length > 0) {
    const repeated = groups.overdue.some((item) => (timesFlagged.get(item.key) ?? 0) > 0);
    return `${repeated ? "STILL OVERDUE" : "OVERDUE"}: ${things(groups.overdue.length)} past deadline${ofTotal(groups.overdue.length)}`;
  }
  if (groups.due_48h.length > 0) {
    return `Due within 48 hours: ${things(groups.due_48h.length)}${ofTotal(groups.due_48h.length)}`;
  }
  if (groups.due_7d.length > 0) {
    return `Due this week: ${things(groups.due_7d.length)}${ofTotal(groups.due_7d.length)}`;
  }
  return `Waiting on you: ${things(total)}`;
}

/** The mail itself: one section per urgency group, each line linked to the page that resolves it. */
export function professorDigestBody(params: {
  groups: ProfessorDigestGroups;
  now: Date;
  timezone: string;
  portalUrl: string;
  timesFlagged?: ReadonlyMap<string, number>;
}): string {
  const { groups, now, timezone, portalUrl } = params;
  const flagged = params.timesFlagged ?? new Map<string, number>();
  const lines: string[] = [
    groups.overdue.length > 0
      ? "Some things that need you are past their deadline. They will stay in this email every day until they are resolved or dismissed in the portal."
      : "Here is what is waiting on you. Each item stays in this daily email until it is resolved or dismissed in the portal.",
  ];
  for (const bucket of professorDigestBuckets) {
    const group = groups[bucket];
    if (group.length === 0) {
      continue;
    }
    lines.push("", `${BUCKET_HEADINGS[bucket]} (${group.length})`);
    for (const item of group.slice(0, LINES_PER_GROUP)) {
      const when = describeWhen(item, now, timezone);
      const previous = flagged.get(item.key) ?? 0;
      const reminder = previous > 0 ? ` [reminder #${previous + 1}]` : "";
      lines.push(
        `- ${item.title}${item.detail ? ` — ${item.detail}` : ""} — ${when}${reminder}`,
        `  ${portalUrl}${item.path}`,
      );
    }
    if (group.length > LINES_PER_GROUP) {
      lines.push(`- and ${group.length - LINES_PER_GROUP} more: ${portalUrl}/professor`);
    }
  }
  lines.push(
    "",
    `Everything on one page: ${portalUrl}/professor`,
    "AdminBot sends this at most once a day, only when something is waiting.",
  );
  return lines.join("\n");
}

function describeWhen(item: ProfessorDigestItem, now: Date, timezone: string): string {
  const nowMs = now.getTime();
  if (item.deadline_at) {
    const at = Date.parse(item.deadline_at);
    const label = formatDay(at, timezone);
    if (at < nowMs) {
      const days = Math.floor((nowMs - at) / DAY_MS);
      return `was due ${label} (${days === 0 ? "earlier today" : days === 1 ? "1 day ago" : `${days} days ago`})`;
    }
    const hours = Math.floor((at - nowMs) / HOUR_MS);
    if (hours < 24) {
      return `due ${label} (in ${hours <= 1 ? "under 2 hours" : `${hours} hours`})`;
    }
    const days = Math.floor((at - nowMs) / DAY_MS);
    return `due ${label} (in ${days === 1 ? "1 day" : `${days} days`})`;
  }
  const since = item.waiting_since ? Date.parse(item.waiting_since) : Number.NaN;
  const days = Number.isFinite(since) ? Math.floor((nowMs - since) / DAY_MS) : 0;
  return `waiting ${days === 1 ? "1 day" : `${days} days`}`;
}

function formatDay(instant: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(instant));
}

function joinDetail(parts: ReadonlyArray<string | undefined>): string | undefined {
  const kept = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return kept.length ? kept.join(" — ") : undefined;
}

function describeList(values: readonly string[], listed = 4): string {
  return values.length <= listed
    ? values.join(", ")
    : `${values.slice(0, listed).join(", ")} and ${values.length - listed} more`;
}
