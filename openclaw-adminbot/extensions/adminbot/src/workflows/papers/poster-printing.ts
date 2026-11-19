// The poster print batch for each conference, derived from the papers rather than collected by
// hand. See contracts/poster-printing.ts for why the unit is the conference.
//
// Everything here is pure: the service hands in the records and the clock, and the reminder and
// handoff actions it sends carry payloads computed here. Determinism matters because a send that
// failed is retried on the next run under the same proposal, and only an identical payload can be:
// text that shifted overnight would mean withdrawing it and filing a new one every morning.
import type { AdminBotPaperRecord } from "../../contracts/actions.js";
import {
  ADMINBOT_POSTER_PRINT_DEFAULT_LEAD_DAYS,
  ADMINBOT_POSTER_PRINT_DEFAULTS_KEY,
  type AdminBotPosterPrintBatchRecord,
  type AdminBotPosterPrintBatchStatus,
  type AdminBotPosterPrintBatchView,
  type AdminBotPosterPrintPaper,
  type AdminBotPosterPrintPaperState,
  type AdminBotPosterPrintRequestRecord,
} from "../../contracts/poster-printing.js";
import { canonicalConferenceTripKey, conferenceKey, conferenceLabel } from "./conference-attendance.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Idempotency prefixes, so the service can find the proposals it filed. */
export const POSTER_PRINT_REMINDER_KEY_PREFIX = "poster-print-reminder:";
export const POSTER_PRINT_HANDOFF_KEY_PREFIX = "poster-print-handoff:";

/**
 * The conference a paper presents at, for printing purposes.
 *
 * Looser than `paperConferenceKey`, which also waits for `is_archival`: whether a paper counts as a
 * publication has nothing to do with whether it needs a poster, and the OpenReview sync fills in
 * the venue, year and presentation type but never archival status. Gating on it would leave every
 * OpenReview-accepted paper out of the batch until somebody opened its card.
 */
export function posterPrintConferenceKey(paper: AdminBotPaperRecord): string | undefined {
  const accepted =
    paper.venue_decision === "accept" || paper.openreview_sync?.status === "accepted";
  const venue = paper.accepted_venue?.trim();
  if (!accepted || !venue || typeof paper.accepted_year !== "number") {
    return undefined;
  }
  return canonicalConferenceTripKey(conferenceKey(venue, paper.accepted_year));
}

/** One conference site as the deadline dataset knows it (a subset of TravelConferenceSite). */
export type PosterPrintConferenceSite = {
  key: string;
  group_key: string;
  label: string;
  multi_site: boolean;
  starts?: string;
  location?: string;
};

export type PosterPrintInputs = {
  papers: readonly AdminBotPaperRecord[];
  batches: readonly AdminBotPosterPrintBatchRecord[];
  requests: readonly AdminBotPosterPrintRequestRecord[];
  /** Every site the dataset knows, past ones included; started ones are dropped here. */
  sites: readonly PosterPrintConferenceSite[];
  /** paper id -> its `poster` slot link and `poster_physical` value. */
  posterSlots: ReadonlyMap<string, { poster_url?: string; physical?: string }>;
  members: ReadonlyMap<string, { name: string }>;
  /** Member ids with a `going` trip, per canonical trip key (a site key or a conference key). */
  going: ReadonlyMap<string, ReadonlySet<string>>;
  /** site key -> when the latest handoff list was filed. */
  handoffs: ReadonlyMap<string, string>;
  today: string;
};

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function paperState(
  request: AdminBotPosterPrintRequestRecord | undefined,
  slot: { poster_url?: string; physical?: string } | undefined,
): AdminBotPosterPrintPaperState {
  // A `not_needed` slot is the same answer as `no_poster`, given before this existed; honour it so
  // nobody is asked twice.
  if (request?.choice === "no_poster" || (!request && slot?.physical === "not_needed")) {
    return "no_poster";
  }
  if (request?.choice === "self_print") {
    return "self_print";
  }
  if (request?.choice === "lab_print") {
    return slot?.poster_url ? "ready" : "missing_file";
  }
  return "unanswered";
}

const STATE_ORDER: Record<AdminBotPosterPrintPaperState, number> = {
  unanswered: 0,
  missing_file: 1,
  ready: 2,
  self_print: 3,
  no_poster: 4,
};

/**
 * Which of a conference's sites a paper presents at: the author's answer, then the site the first
 * author's trip is for. Undefined when neither says, at a conference with more than one site.
 */
function paperSite(
  sites: readonly PosterPrintConferenceSite[],
  request: AdminBotPosterPrintRequestRecord | undefined,
  authorId: string | undefined,
  going: PosterPrintInputs["going"],
): { key: string; source: AdminBotPosterPrintPaper["site_source"] } | undefined {
  if (sites.length === 1) {
    return { key: sites[0].key, source: "single" };
  }
  if (request?.site_key && sites.some((site) => site.key === request.site_key)) {
    return { key: request.site_key, source: "request" };
  }
  const booked = authorId ? sites.find((site) => going.get(site.key)?.has(authorId)) : undefined;
  return booked ? { key: booked.key, source: "trip" } : undefined;
}

/**
 * Every conference site with an accepted lab paper that has not started yet, with its batch.
 *
 * A site drops off on its start day: a list of posters for a conference already under way is
 * history, and the printer's page should show what is next. A conference the dataset does not
 * know at all stays listed (status `no_deadline`) through its year, so an admin can set a date.
 */
export function buildPosterPrintBatches(input: PosterPrintInputs): AdminBotPosterPrintBatchView[] {
  const sitesByGroup = new Map<string, PosterPrintConferenceSite[]>();
  for (const site of input.sites) {
    const group = canonicalConferenceTripKey(site.group_key);
    sitesByGroup.set(group, [...(sitesByGroup.get(group) ?? []), site]);
  }
  const stored = new Map(input.batches.map((row) => [row.conference_key, row]));
  const defaults = stored.get(ADMINBOT_POSTER_PRINT_DEFAULTS_KEY);
  const requests = new Map(
    input.requests.map((row) => [`${canonicalConferenceTripKey(row.conference_key)}|${row.paper_id}`, row]),
  );
  const thisYear = Number(input.today.slice(0, 4));

  type Bucket = { site: PosterPrintConferenceSite; papers: AdminBotPosterPrintPaper[] };
  const buckets = new Map<string, Bucket>();
  const bucket = (site: PosterPrintConferenceSite) => {
    const existing = buckets.get(site.key) ?? { site, papers: [] };
    buckets.set(site.key, existing);
    return existing;
  };

  for (const paper of input.papers) {
    const group = posterPrintConferenceKey(paper);
    if (!group) {
      continue;
    }
    const known = sitesByGroup.get(group);
    if (!known && paper.accepted_year! < thisYear) {
      continue;
    }
    const sites = known ?? [
      {
        key: group,
        group_key: group,
        label: conferenceLabel(paper.accepted_venue!, paper.accepted_year!),
        multi_site: false,
      },
    ];
    const request = requests.get(`${group}|${paper.id}`);
    const slot = input.posterSlots.get(paper.id);
    const authorId = paper.first_author_member_id;
    const authorName = authorId ? input.members.get(authorId)?.name : undefined;
    const placed = paperSite(sites, request, authorId, input.going);
    const base = {
      paper_id: paper.id,
      title: paper.title,
      ...(paper.presentation_type ? { presentation_type: paper.presentation_type } : {}),
      ...(authorId && authorName ? { first_author: { member_id: authorId, name: authorName } } : {}),
      ...(slot?.poster_url ? { poster_url: slot.poster_url } : {}),
      ...(request ? { request } : {}),
      state: paperState(request, slot),
    };
    for (const site of placed ? sites.filter((candidate) => candidate.key === placed.key) : sites) {
      const going = authorId
        ? Boolean(input.going.get(site.key)?.has(authorId) || input.going.get(group)?.has(authorId))
        : false;
      bucket(site).papers.push({
        ...base,
        site_source: placed?.source ?? "unknown",
        first_author_going: going,
      });
    }
  }

  const views: AdminBotPosterPrintBatchView[] = [];
  for (const { site, papers: unsorted } of buckets.values()) {
    if (site.starts && site.starts <= input.today) {
      continue;
    }
    const batch = stored.get(site.key);
    const leadDays = batch?.lead_days ?? defaults?.lead_days ?? ADMINBOT_POSTER_PRINT_DEFAULT_LEAD_DAYS;
    const deadline = batch?.deadline_on ?? (site.starts ? addDays(site.starts, -leadDays) : undefined);
    const printerId = batch?.printer_member_id ?? defaults?.printer_member_id;
    const printerName = printerId ? input.members.get(printerId)?.name : undefined;
    const papers = unsorted.toSorted(
      (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.title.localeCompare(b.title),
    );
    const counts: Record<AdminBotPosterPrintPaperState, number> = {
      unanswered: 0,
      missing_file: 0,
      ready: 0,
      self_print: 0,
      no_poster: 0,
    };
    for (const paper of papers) {
      counts[paper.state] += 1;
    }
    const sentAt = input.handoffs.get(site.key);
    const status: AdminBotPosterPrintBatchStatus = !deadline
      ? "no_deadline"
      : sentAt
        ? "sent"
        : deadline <= input.today
          ? "due"
          : "collecting";
    const printLocation = batch?.print_location ?? defaults?.print_location;
    const notes = batch?.notes ?? defaults?.notes;
    views.push({
      conference_key: site.key,
      group_key: canonicalConferenceTripKey(site.group_key),
      multi_site: site.multi_site,
      label: site.label,
      ...(site.starts ? { conference_starts: site.starts } : {}),
      ...(site.location ? { conference_location: site.location } : {}),
      ...(deadline ? { deadline_on: deadline, days_left: daysBetween(input.today, deadline) } : {}),
      deadline_source: batch?.deadline_on ? "set" : deadline ? "lead_days" : "none",
      ...(printerId && printerName ? { printer: { member_id: printerId, name: printerName } } : {}),
      ...(printLocation ? { print_location: printLocation } : {}),
      ...(notes ? { notes } : {}),
      status,
      ...(sentAt ? { sent_at: sentAt } : {}),
      papers,
      counts,
    });
  }
  return views.toSorted(
    (a, b) =>
      (a.deadline_on ?? "9999").localeCompare(b.deadline_on ?? "9999") ||
      a.label.localeCompare(b.label),
  );
}

/**
 * Which reminder, if any, a paper is due today. Each stage fires at most once per paper per
 * deadline (its idempotency key carries both), so a sweep that runs every hour sends one message
 * per stage, not one per run.
 *
 * Three touches: an opening notice three weeks out so people can plan the file, a week-out nudge,
 * and a last call two days before. Fewer and the week-of crunch is where everyone finds out; more
 * and it is the Slack noise the paper-slot comments warn about.
 */
export type PosterPrintReminderStage = "opening" | "week" | "final";

export function posterPrintReminderStage(daysLeft: number): PosterPrintReminderStage | undefined {
  if (daysLeft < 0) {
    return undefined;
  }
  if (daysLeft <= 2) {
    return "final";
  }
  if (daysLeft <= 7) {
    return "week";
  }
  if (daysLeft <= 21) {
    return "opening";
  }
  return undefined;
}

export type PosterPrintReminder = {
  conference_key: string;
  paper_id: string;
  member_id: string;
  stage: PosterPrintReminderStage;
  deadline_on: string;
  text: string;
  idempotency_key: string;
};

/**
 * The reminders due today across every batch: one per first author per paper that is still
 * `unanswered` or `missing_file`, at the stage its days-left puts it in.
 *
 * A paper with no linked first author is skipped rather than guessed at -- the card already nags
 * for the link, and messaging the wrong person about somebody else's poster is worse than silence.
 */
export function duePosterPrintReminders(
  views: readonly AdminBotPosterPrintBatchView[],
  paperPageUrl: (paperId: string) => string,
): PosterPrintReminder[] {
  // A paper not yet placed at one of a multi-site conference's cities is listed under each of
  // them; it still gets one message, from whichever site is due soonest.
  const due = new Map<string, PosterPrintReminder & { days_left: number }>();
  for (const view of views) {
    if (view.status !== "collecting" || !view.deadline_on || view.days_left === undefined) {
      continue;
    }
    const stage = posterPrintReminderStage(view.days_left);
    if (!stage) {
      continue;
    }
    for (const paper of view.papers) {
      if ((paper.state !== "unanswered" && paper.state !== "missing_file") || !paper.first_author) {
        continue;
      }
      const seen = due.get(paper.paper_id);
      if (seen && seen.days_left <= view.days_left) {
        continue;
      }
      due.set(paper.paper_id, {
        conference_key: view.conference_key,
        paper_id: paper.paper_id,
        member_id: paper.first_author.member_id,
        stage,
        deadline_on: view.deadline_on,
        days_left: view.days_left,
        text: posterPrintReminderText(view, paper, stage, paperPageUrl(paper.paper_id)),
        // Keyed by the paper's conference, not the site, so a paper that gets placed at another
        // city after the first reminder is not reminded again for the same stage.
        idempotency_key: `${POSTER_PRINT_REMINDER_KEY_PREFIX}${view.group_key}:${paper.paper_id}:${view.deadline_on}:${stage}`,
      });
    }
  }
  return [...due.values()].map(({ days_left: _days, ...reminder }) => reminder);
}

/**
 * "Wednesday 25 November". A calendar date rather than "in 6 days": the text is the action's
 * payload, and one that changed every morning would have to be withdrawn and re-filed daily.
 */
export function posterPrintDayText(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export function posterPrintReminderText(
  view: AdminBotPosterPrintBatchView,
  paper: AdminBotPosterPrintPaper,
  stage: PosterPrintReminderStage,
  pageUrl: string,
): string {
  const who = view.printer
    ? `${view.printer.name}${view.print_location ? ` (${view.print_location})` : ""}`
    : view.print_location ?? "the lab";
  const when = posterPrintDayText(view.deadline_on!);
  const ask =
    paper.state === "missing_file"
      ? `You asked for it to be printed but no poster file is linked yet. Add the link so it makes the batch.`
      : paper.site_source === "unknown"
        ? `${view.label.split(" — ")[0]} runs in more than one city. Say which one you present in, and whether the lab should print the poster, you are printing it yourself, or there is no poster.`
        : `Tell AdminBot whether ${who} should print it, you are printing it yourself, or there is no poster.`;
  const lead = stage === "final" ? "Last call: " : "";
  return [
    `${lead}${view.label} posters go to ${who} for printing by ${when}.`,
    `Your paper "${paper.title}": ${ask}`,
    `Answer on the paper page: ${pageUrl}`,
    view.notes ? `Note from the printer: ${view.notes}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A stable short digest of what the printer is asked for, so a changed list -- a late addition, a
 * file that finally arrived -- files a fresh handoff, and an unchanged one never files twice.
 */
function listDigest(entries: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const char of entries.toSorted().join(",")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function sizeText(request: AdminBotPosterPrintRequestRecord | undefined): string {
  const size = request?.size === "custom" ? request.custom_size || "custom size" : request?.size ?? "size not given";
  const orientation = request?.orientation ? `, ${request.orientation}` : "";
  const copies = request?.copies && request.copies > 1 ? `, ${request.copies} copies` : "";
  return `${size}${orientation}${copies}`;
}

/**
 * The aggregated list for the printer, as a DM body. Filed once the deadline arrives, and again
 * whenever the set of posters to print changes after that (a late addition), so the printer is
 * never working from a stale list. Undefined when there is nothing to print.
 */
export function posterPrintHandoff(
  view: AdminBotPosterPrintBatchView,
  batchPageUrl: string,
): { text: string; idempotency_key: string; paper_ids: string[] } | undefined {
  if (!view.printer || !view.deadline_on || (view.status !== "due" && view.status !== "sent")) {
    return undefined;
  }
  // A paper not placed at a city is not on any printer's list: it could be Atlanta's.
  const toPrint = view.papers.filter(
    (paper) =>
      (paper.state === "ready" || paper.state === "missing_file") && paper.site_source !== "unknown",
  );
  if (!toPrint.length) {
    return undefined;
  }
  const lines = toPrint.map((paper, index) => {
    const author = paper.first_author?.name ?? "first author not linked";
    const collect = paper.first_author_going ? "author attending" : "author not marked as attending";
    const file = paper.poster_url ?? "NO FILE YET";
    return `${index + 1}. ${paper.title} -- ${sizeText(paper.request)} -- ${author} (${collect})\n   ${file}`;
  });
  const waiting = view.counts.unanswered
    ? `\n${view.counts.unanswered} paper(s) have not answered yet; late answers show up on the page.`
    : "";
  const ids = toPrint.map((paper) => paper.paper_id);
  const digest = listDigest(toPrint.map((paper) => `${paper.paper_id}=${paper.state}`));
  return {
    text:
      `${view.label} poster print list: ${toPrint.length} poster(s), due ${posterPrintDayText(view.deadline_on)}.\n\n` +
      `${lines.join("\n")}${waiting}\n\nLive list: ${batchPageUrl}`,
    idempotency_key: `${POSTER_PRINT_HANDOFF_KEY_PREFIX}${view.conference_key}:${digest}`,
    paper_ids: ids,
  };
}
