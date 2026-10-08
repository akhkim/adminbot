import { html, nothing, LitElement, type TemplateResult } from "lit";
// Shared rendering for public and signed-in deadline surfaces.
// Stays in the app document flow so the page owns one vertical scroll.
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { UiSettings } from "../../storage.ts";
import "./deadlines.recommendation.ts";
import type { AccessRole } from "../access.ts";
import { fetchConferenceRosters, type ConferenceRoster } from "../api/paper-admin.ts";
import { resolveAdminBotBaseUrl, loadStoredMemberSession } from "../auth/session.ts";
import {
  deadlineMilestoneRow,
  hasDeadlineMilestone,
  type MilestoneRow,
} from "../data/availability.ts";
import {
  loadDeadlineTimezone,
  saveDeadlineTimezone,
  displayTimezone,
  zonedDeadlineLabel,
  deadlineDisplayLabel,
} from "../data/deadline-display-time.ts";
import {
  AdminBotDeadlineProposalStore,
  deadlineProposalStoreFor,
  type DeadlineProposal,
  type DeadlineProposalInput,
  type DeadlineProposalStore,
  validateDeadlineProposal,
} from "../data/deadline-proposals.ts";
import {
  AdminBotDeadlineRecommendationStore,
  type DeadlineRecommendationDirectory,
  type DeadlineRecommendationStore,
} from "../data/deadline-recommendations.ts";
import {
  aoeDateLabel,
  aoeDateTimeLabel,
  aoeInstantMs,
  deadlineInstantMs,
  deadlineDateTimeLabel,
  planningCountdownLabel,
  countdownLabel,
  dateRangeLabel,
  daysLeftLabel,
  plainDateLabel,
  urgencyOf,
  type Urgency,
} from "../data/deadline-time.ts";
import { DEADLINE_VENUES, type DeadlineMilestone, type DeadlineVenue } from "../data/deadlines.ts";
import { milestoneEndInstant } from "../data/milestone-time.ts";
import { AOE_TIMEZONE, timezoneOptions } from "../data/timezones.ts";
import { renderDateControl } from "../date-control.ts";
import { renderDeadlineDate, renderDeadlineDateLabel } from "./deadline-date.ts";
import { renderDeadlineParentConferenceSelect } from "./deadline-parent-conference-select.ts";
import { wrapSeparator } from "./deadline-separator.ts";
import {
  renderAbstractRequirement,
  abstractRequirementStatus,
  abstractMilestone,
  renderAbstractMilestoneDate,
  type AbstractMilestone,
} from "./deadlines.abstract.ts";
import { conferenceRosterFor, renderConferenceAttendance } from "./deadlines.conference.ts";
import {
  proposalVenueLabel,
  proposalDateFields,
  stageCorrection,
  renderStageDetails,
  deadlineStageKinds,
} from "./deadlines.proposal-stage.ts";
import { renderPublicationPolicy } from "./deadlines.publication-policy.ts";
import {
  stageKey,
  matchesStage,
  chooseStage,
  stageFilterOptions,
  renderStageFilter,
} from "./deadlines.stage-filter.ts";
import { renderDeadlineTimezone } from "./deadlines.timezone.ts";
import {
  workshopNotificationMilestones,
  renderWorkshopNotificationNotes,
  sharedWorkshopNotificationPolicy,
} from "./deadlines.workshop-notifications.ts";

const DEFAULT_DEADLINE_PROPOSAL_STORE = new AdminBotDeadlineProposalStore();

export type DeadlineBoardEntry = {
  venue: DeadlineVenue;
  instant: number;
  stage?: DeadlineStage;
  stageFiltered?: boolean;
};
type DeadlineGroupKind = "archival" | "nonArchival" | "mixed" | "unknown" | "other";
/**
 * One dated row of a conference's timeline: either a submission the board counts down to, or a
 * later stage the venue published behind it (decisions, camera-ready, the conference itself).
 */
export type DeadlineTimelineItem =
  | { kind: "entry"; day: string; rank: number; entry: DeadlineBoardEntry }
  | {
      kind: "milestone";
      day: string;
      rank: number;
      label: string;
      milestone: AbstractMilestone;
      venue: DeadlineVenue;
    };
export type DeadlineBoardGroup = {
  id: string;
  label: string;
  entries: DeadlineBoardEntry[];
  instant: number;
  sections: Record<DeadlineGroupKind, DeadlineBoardEntry[]>;
  /** A workshop bundle lists its members; a conference lists its whole calendar in order. */
  kind: "workshops" | "conference";
  /** Populated for `kind: "conference"` only; empty for a workshop bundle. */
  timeline: DeadlineTimelineItem[];
  /**
   * Render as a single card rather than a collapsible group. True for a group whose entire
   * contents are one row: a workshop bundle that attracted one entry, or a conference that
   * published a lone deadline with no calendar behind it.
   */
  standalone: boolean;
};
export type DeadlineBoardView = "cards" | "groups" | "table";
export type DeadlineBoardPeriod = "upcoming" | "past";
export type DeadlineBoardEntryType = "all" | "paper_deadlines" | DeadlineVenue["entry_type"];
export type DeadlineBoardArchivalStatus =
  | "all"
  | "publication_actions"
  | DeadlineVenue["archival_status"];
export type DeadlineBoardFilters = Readonly<{
  entryType: DeadlineBoardEntryType;
  archivalStatus: DeadlineBoardArchivalStatus;
  location?: string;
}>;
type DeadlineUrgency = Urgency | "passed" | "unknown";

export const DEFAULT_DEADLINE_BOARD_FILTERS: DeadlineBoardFilters = {
  entryType: "all",
  archivalStatus: "all",
};

export function parentConferenceOptions(venues: readonly DeadlineVenue[]): string[] {
  return [
    ...new Set(
      venues
        .map((venue) => venue.venue_family?.trim())
        .filter((family): family is string => Boolean(family)),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

export function buildDeadlineBoardEntries(
  venues: readonly DeadlineVenue[] = DEADLINE_VENUES,
): DeadlineBoardEntry[] {
  const sorted = venues
    .map((venue) => ({ venue, instant: deadlineInstantMs(venue) }))
    .filter(
      (entry) =>
        Number.isFinite(entry.instant) ||
        (entry.venue.venue_type === "workshop" && entry.venue.deadline_aoe === ""),
    )
    .map((entry) =>
      Number.isFinite(entry.instant) ? entry : { ...entry, instant: Number.POSITIVE_INFINITY },
    )
    .toSorted(
      (left, right) =>
        left.instant - right.instant || left.venue.name.localeCompare(right.venue.name),
    );
  return mergeArrSubmissionDuplicates(sorted);
}

/**
 * Collapse a conference and the ARR cycle it submits through into one deadline.
 *
 * NAACL 2027 takes papers via the ARR October 2026 cycle, so the board carried two cards for a
 * single act: "ARR — October 2026 cycle (direct submission)" and "NAACL 2027 (main, ARR
 * submission)", both `arr_direct_submission`, both at 2026-10-12 23:59:59. Two countdowns to the
 * same instant reads as two things to do.
 *
 * Matched on entry type plus instant rather than on a venue list, so a cycle with no conference
 * hanging off it (May and August 2026 today) is left alone and a future pairing needs no code
 * change. The conference wins the card: it names the venue somebody is actually targeting and
 * carries the real archival status, where the generic cycle is `unknown`. The cycle's name is kept
 * on the survivor so searching "ARR October" still finds it.
 */
export function mergeArrSubmissionDuplicates(
  entries: readonly DeadlineBoardEntry[],
): DeadlineBoardEntry[] {
  const byInstant = new Map<number, DeadlineBoardEntry[]>();
  for (const entry of entries) {
    if (entry.venue.entry_type !== "arr_direct_submission") {
      continue;
    }
    const bucket = byInstant.get(entry.instant);
    if (bucket) {
      bucket.push(entry);
    } else {
      byInstant.set(entry.instant, [entry]);
    }
  }

  const dropped = new Set<DeadlineBoardEntry>();
  const renamed = new Map<DeadlineBoardEntry, DeadlineBoardEntry>();
  for (const bucket of byInstant.values()) {
    if (bucket.length < 2) {
      continue;
    }
    // A named venue beats a bare cycle. `archival_status` is the tell: the cycle cannot know
    // whether the eventual venue archives, so it is recorded as unknown.
    const survivor = bucket.find((entry) => entry.venue.archival_status !== "unknown") ?? bucket[0];
    if (!survivor) {
      continue;
    }
    const absorbed = bucket.filter((entry) => entry !== survivor);
    for (const entry of absorbed) {
      dropped.add(entry);
    }
    const viaGroups = absorbed.map((entry) => entry.venue.venue_group.trim()).filter(Boolean);
    if (viaGroups.length > 0) {
      renamed.set(survivor, {
        ...survivor,
        venue: { ...survivor.venue, name: `${survivor.venue.name} · via ${viaGroups.join(", ")}` },
      });
    }
  }

  return entries.filter((entry) => !dropped.has(entry)).map((entry) => renamed.get(entry) ?? entry);
}

/**
 * Stage order for a rendered schedule: the story, not the calendar.
 *
 * Sorted by stage first because a venue can date two stages the same day -- ICLR releases reviews
 * and opens author discussion both on 5 November -- and a date-only sort puts them in whichever
 * order the source happened to list, which reads as noise. Anything unrecognised sorts last rather
 * than being dropped: a venue inventing a stage is a thing to show, not to hide.
 */
const MILESTONE_ORDER = [
  "abstract",
  "submission",
  "reviews",
  "rebuttal",
  "notification",
  "notification_by",
  "cycle_end",
  "camera_ready",
  "conference",
];

function milestoneRank(milestone: string): number {
  const index = MILESTONE_ORDER.indexOf(milestone);
  return index === -1 ? MILESTONE_ORDER.length : index;
}

/** The first date a milestone occupies, for ordering within one stage. */
function milestoneStart(entry: DeadlineMilestone): string {
  return entry.starts ?? entry.date ?? entry.ends ?? "";
}

/** Explicit schedule entries take precedence over compatible legacy decision dates. */
export function venueSchedule(
  venue: DeadlineVenue,
  options: { includeSubmission?: boolean; venues?: readonly DeadlineVenue[] } = {},
): AbstractMilestone[] {
  const curated = venue.schedule ?? [];
  const abstract = abstractMilestone(venue, options.venues ?? []);
  const entries: AbstractMilestone[] = abstract
    ? [abstract, ...curated.filter((entry) => entry.milestone !== "abstract")]
    : [...curated];
  entries.push(...workshopNotificationMilestones(venue));
  // Derive submission from the current projection so it agrees with the card countdown.
  if (options.includeSubmission && venue.deadline_aoe) {
    entries.push({
      milestone: "submission",
      // Capitalised: the dataset spells these as the venue does ("full paper", "ARR submission"),
      // and the card's own stage line already shows the same string capitalised. Two spellings of
      // one label on one card reads as two different things.
      label: capitaliseFirst(venue.deadline_label?.trim() || "Submission"),
      kind: venue.deadline_time_precision === "date_only" ? "date" : "deadline",
      date:
        venue.deadline_time_precision === "date_only" ? venue.deadline_date : venue.deadline_aoe,
    });
  }
  if (
    venue.notification_aoe &&
    (venue.venue_type !== "workshop" || venue.notification_status === "source_backed") &&
    !curated.some((entry) => entry.milestone === "notification")
  ) {
    entries.push({
      milestone: "notification",
      label: "Accept/reject",
      kind: "deadline",
      date: venue.notification_aoe,
    });
  }
  return entries.toSorted(
    (left, right) =>
      milestoneRank(left.milestone) - milestoneRank(right.milestone) ||
      milestoneStart(left).localeCompare(milestoneStart(right)) ||
      left.label.localeCompare(right.label),
  );
}

/** First letter up, rest untouched -- "ARR submission" must not become "Arr submission". */
function capitaliseFirst(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** One schedule entry's date, read the way its `kind` says to read it. */
export function milestoneDateLabel(entry: DeadlineMilestone, displayZone?: string): string {
  if (entry.kind === "period") {
    return dateRangeLabel(entry.starts ?? "", entry.ends ?? "");
  }
  if (entry.kind === "deadline" && /(?:Z|[+-]\d{2}:\d{2})$/u.test(entry.date || "")) {
    return zonedDeadlineLabel(
      Date.parse(entry.date!),
      displayTimezone(displayZone ?? "original", entry.timezone || "UTC"),
    );
  }
  if (displayZone && entry.kind === "deadline" && /[ T]\d{2}:\d{2}/u.test(entry.date || "")) {
    return zonedDeadlineLabel(aoeInstantMs(entry.date || ""), displayTimezone(displayZone, "AoE"));
  }
  // Only an AoE cutoff gets the AoE suffix. A day the venue acts on is a plain calendar date, and
  // "conference opens Apr 26 AoE" would claim a precision nobody published.
  return entry.kind === "deadline"
    ? `${aoeDateLabel(entry.date ?? "")} AoE`
    : plainDateLabel(entry.date ?? "");
}

/** One dated stage of a venue, as the board counts down to it. */
export type DeadlineStage = {
  key: string;
  milestone?: DeadlineMilestone & { abstractVenue?: DeadlineVenue };
  instant: number;
  /** What the venue calls it: its own submission label, or the milestone's. */
  label: string;
  /** The date as a card prints it, in the frame the stage is published in. */
  dateLabel: string;
  /** The day, for a `<time datetime>` attribute. */
  day: string;
  /** True for the submission itself, false for anything published behind it. */
  submission: boolean;
};

/**
 * Every dated stage of a venue in the order it happens: the submission, then the rest of its
 * calendar.
 *
 * The board's period split reads this rather than the submission alone. A conference is not done
 * with the lab the day its deadline passes -- decisions still land, camera-ready copy is still
 * due, and the conference itself still has to be travelled to -- so a venue belongs under
 * "Upcoming" until every stage it published is behind us.
 */
export function venueStages(
  venue: DeadlineVenue,
  displayZone?: string,
  venues: readonly DeadlineVenue[] = [],
): readonly DeadlineStage[] {
  // The clock is not an input, and the board asks for every row on its one-second tick.
  const byZone =
    stagesCache.get(venues) ?? new Map<string, WeakMap<DeadlineVenue, DeadlineStage[]>>();
  const byVenue = byZone.get(displayZone ?? "") ?? new WeakMap<DeadlineVenue, DeadlineStage[]>();
  stagesCache.set(venues, byZone.set(displayZone ?? "", byVenue));
  const stages = byVenue.get(venue) ?? computeVenueStages(venue, displayZone, venues);
  byVenue.set(venue, stages);
  return stages;
}
// Keyed by the dataset array, which a reload replaces rather than edits.
const stagesCache = new WeakMap<object, Map<string, WeakMap<DeadlineVenue, DeadlineStage[]>>>();

function computeVenueStages(
  venue: DeadlineVenue,
  displayZone: string | undefined,
  venues: readonly DeadlineVenue[],
): DeadlineStage[] {
  const stages: DeadlineStage[] = [];
  const submission = deadlineInstantMs(venue);
  if (Number.isFinite(submission)) {
    stages.push({
      key: stageKey(venue.milestone ?? "submission"),
      instant: submission,
      label: capitaliseFirst(venue.deadline_label?.trim() || "Submission"),
      dateLabel: deadlineDateTimeLabel(venue),
      day: venue.deadline_aoe,
      submission: true,
    });
  }
  for (const milestone of venueSchedule(venue, { venues })) {
    if (milestone.milestone === "notification_by") {
      continue;
    }
    const instant = milestoneEndInstant(milestone);
    if (!Number.isFinite(instant)) {
      continue;
    }
    stages.push({
      key: stageKey(milestone.milestone),
      milestone,
      instant,
      label: milestone.label,
      dateLabel: milestoneDateLabel(milestone, displayZone),
      day: milestoneStart(milestone),
      submission: false,
    });
  }
  return stages.toSorted((left, right) => left.instant - right.instant);
}

const DEADLINE_ACTION_KEYS = new Set([
  "submission",
  "abstract",
  "author_response",
  "camera_ready",
  "commitment",
  "registration",
]);

/** Recently passed actions stay visible even while a venue has later dates. */
export function recentDeadlineActions(
  entries: readonly DeadlineBoardEntry[],
  now: number,
  displayZone?: string,
  venues: readonly DeadlineVenue[] = [],
  selectedStage = "",
): DeadlineBoardEntry[] {
  const seen = new Set<string>();
  return entries
    .flatMap((entry) =>
      venueStages(entry.venue, displayZone, venues)
        .filter(
          (stage) =>
            DEADLINE_ACTION_KEYS.has(stage.key) &&
            (!selectedStage || matchesStage(stage.key, selectedStage)) &&
            stage.instant <= now &&
            stage.instant >= now - 14 * 86400000,
        )
        .map((stage) => ({ ...entry, stage, instant: stage.instant })),
    )
    .filter((entry) => {
      const key = JSON.stringify([
        entry.venue.venue_id || entry.venue.id,
        entry.venue.track || "",
        entry.venue.submission_type || "",
        entry.stage.key,
        entry.stage.label,
        entry.instant,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .toSorted((a, b) => b.instant - a.instant);
}

/** Prefer the next author action; informational dates remain in the venue timeline. */
export function nextVenueStage(
  venue: DeadlineVenue,
  now: number,
  displayZone?: string,
  venues: readonly DeadlineVenue[] = [],
): DeadlineStage | undefined {
  const pending = venueStages(venue, displayZone, venues).filter((stage) => stage.instant > now);
  return pending.find((stage) => DEADLINE_ACTION_KEYS.has(stage.key)) ?? pending[0];
}

/** What a timeline row is called, for a stable tie-break between two same-day rows. */
function timelineLabel(item: DeadlineTimelineItem): string {
  return item.kind === "entry" ? item.entry.venue.name : item.label;
}

/**
 * Disambiguate two stages that share a label but not a date.
 *
 * AACL-IJCNLP 2026 wants camera-ready copy on 30 September through the ARR commitment and on
 * 1 October for the demo track. Each source labels its own row "Camera-ready due", so a merged
 * timeline would print the same words against two dates with nothing to tell them apart. The
 * submission the stage hangs off is what actually differs, so it names the row.
 */
function qualifyRepeatedMilestones(items: readonly DeadlineTimelineItem[]): DeadlineTimelineItem[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.kind === "milestone") {
      counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    }
  }
  return items.map((item) =>
    item.kind === "milestone" && (counts.get(item.label) ?? 0) > 1
      ? { ...item, label: `${item.label} (${item.venue.deadline_label.trim() || "submission"})` }
      : item,
  );
}

/**
 * One conference's whole calendar in the order it happens: every submission it takes, plus every
 * stage its venues published behind them.
 *
 * Sorted by date rather than by stage, unlike `venueSchedule`. A single venue's schedule is one
 * story told in stage order; a conference's is several submissions interleaved with shared
 * downstream dates, and only the calendar can say whether the demo track closes before or after
 * the main track's camera-ready. Stage rank survives as the tie-break for a day that carries two
 * of them, and a submission outranks everything else on its own day because that is the thing
 * somebody has to act on.
 *
 * Deduplicated across the group's venues: ICLR 2027's abstract and full-paper rows carry the same
 * four downstream dates, and printing them twice would double the length of the panel to say
 * nothing new. Two rows survive deduplication only when they genuinely differ.
 */
export function conferenceTimeline(
  entries: readonly DeadlineBoardEntry[],
  venues: readonly DeadlineVenue[] = [],
): DeadlineTimelineItem[] {
  const items: DeadlineTimelineItem[] = entries.map((entry) => ({
    kind: "entry",
    day: (entry.stageFiltered
      ? (entry.stage?.day ?? entry.venue.deadline_aoe)
      : entry.venue.deadline_aoe
    ).slice(0, 10),
    rank: -1,
    entry: entry.stageFiltered ? entry : { ...entry, stage: undefined },
  }));
  if (entries.some((entry) => entry.stageFiltered)) {
    return items;
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const milestone of venueSchedule(entry.venue, { venues })) {
      if (
        milestone.abstractVenue &&
        entries.some((row) => row.venue.id === milestone.abstractVenue?.id)
      ) {
        continue;
      }
      const key = [
        milestone.milestone,
        milestone.label,
        milestone.date ?? "",
        milestone.starts ?? "",
        milestone.ends ?? "",
      ].join("|");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push({
        kind: "milestone",
        day: milestoneStart(milestone),
        rank: milestoneRank(milestone.milestone),
        label: milestone.label,
        milestone,
        venue: entry.venue,
      });
    }
  }
  return qualifyRepeatedMilestones(items).toSorted(
    (left, right) =>
      left.day.localeCompare(right.day) ||
      left.rank - right.rank ||
      timelineLabel(left).localeCompare(timelineLabel(right)),
  );
}

/**
 * The entry the countdown leads with.
 *
 * Never a workshop. Workshops outnumber everything else on this board roughly ten to one, so the
 * nearest deadline is nearly always one of them — and a hero counting down to a non-archival
 * workshop while an archival conference closes the same week actively misleads the lab about what
 * it is about to miss. Prefer an archival non-workshop, then any non-workshop, and only then fall
 * back to the plain next entry: an imperfect headline still beats an empty one when a filter has
 * narrowed the board to workshops alone.
 */
export function headlineDeadlineEntry(
  entries: readonly DeadlineBoardEntry[],
): DeadlineBoardEntry | undefined {
  const dated = entries.filter((entry) => Number.isFinite(entry.instant));
  const actions = dated.filter((entry) =>
    DEADLINE_ACTION_KEYS.has(entry.stage?.key ?? stageKey(entry.venue.milestone ?? "submission")),
  );
  if (actions.length && actions.length !== dated.length) return headlineDeadlineEntry(actions);
  return (
    dated.find(
      (entry) =>
        entry.venue.archival_status === "archival" && entry.venue.entry_type !== "workshop",
    ) ??
    dated.find((entry) => entry.venue.entry_type !== "workshop") ??
    dated[0]
  );
}

/**
 * Split the board into what is still ahead and what is wholly behind us.
 *
 * "Upcoming" is not "the deadline has not passed": a venue stays here while any stage of it is
 * still to come, so EMNLP keeps a card through its notification, its camera-ready date and the
 * week the conference actually meets, and only drops into "Past" once the last of those is over.
 * The alternative filed a conference under "Past" the minute the lab submitted to it, which is
 * exactly when it starts mattering most.
 *
 * Upcoming is ordered by the stage each row is waiting on rather than by its submission, so the
 * list still reads top-to-bottom as "what happens next". Past keeps its own ordering: most
 * recently finished first.
 */
export function entriesForDeadlinePeriod(
  entries: readonly DeadlineBoardEntry[],
  now: number,
  period: DeadlineBoardPeriod,
  selectedStage = "",
  displayZone?: string,
  venues: readonly DeadlineVenue[] = [],
): DeadlineBoardEntry[] {
  if (selectedStage) {
    const selected = entries.flatMap((entry) => {
      const stage = chooseStage(
        venueStages(entry.venue, displayZone, venues),
        selectedStage,
        now,
        period,
      );
      return stage ? [{ ...entry, stage, stageFiltered: true, instant: stage.instant }] : [];
    });
    const seen = new Set<string>();
    return selected
      .filter((entry) => {
        const key = JSON.stringify([
          entry.venue.venue_id || entry.venue.id,
          entry.venue.track || "",
          entry.venue.submission_type || "",
          entry.stage.key,
          entry.stage.label,
          entry.instant,
        ]);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .filter(
        (entry) =>
          !entry.stage?.milestone?.abstractVenue ||
          !selected.some((other) => other.venue.id === entry.stage?.milestone?.abstractVenue?.id),
      )
      .toSorted(
        (a, b) =>
          (period === "past" ? b.instant - a.instant : a.instant - b.instant) ||
          a.venue.name.localeCompare(b.venue.name),
      );
  }
  if (period === "past") {
    return entries
      .filter((entry) => Number.isFinite(entry.instant) && !nextVenueStage(entry.venue, now))
      .toSorted(
        (left, right) =>
          right.instant - left.instant || left.venue.name.localeCompare(right.venue.name),
      );
  }
  const pending = new Map<DeadlineBoardEntry, number>();
  for (const entry of entries) {
    const stage = nextVenueStage(entry.venue, now, displayZone, venues);
    if (!Number.isFinite(entry.instant)) {
      pending.set(entry, Number.POSITIVE_INFINITY);
    } else if (stage) {
      pending.set(entry, stage.instant);
    }
  }
  return [...pending.keys()]
    .toSorted(
      (left, right) =>
        (pending.get(left) ?? left.instant) - (pending.get(right) ?? right.instant) ||
        left.instant - right.instant ||
        left.venue.name.localeCompare(right.venue.name),
    )
    .map((entry) => ({
      ...entry,
      stage: nextVenueStage(entry.venue, now, displayZone, venues),
    }));
}

export function filterDeadlineBoardEntries(
  entries: readonly DeadlineBoardEntry[],
  group: string,
  query: string,
  filters: DeadlineBoardFilters = DEFAULT_DEADLINE_BOARD_FILTERS,
): DeadlineBoardEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter(({ venue }) => {
    if (group && venue.venue_group !== group) {
      return false;
    }
    if (
      filters.entryType === "paper_deadlines"
        ? !["main_conference", "arr_direct_submission", "arr_commitment"].includes(venue.entry_type)
        : filters.entryType !== "all" && venue.entry_type !== filters.entryType
    ) {
      return false;
    }
    if (
      filters.archivalStatus === "publication_actions"
        ? venue.archival_status !== "archival" &&
          venue.archival_status !== "mixed" &&
          venue.entry_type !== "arr_direct_submission"
        : filters.archivalStatus !== "all" && venue.archival_status !== filters.archivalStatus
    ) {
      return false;
    }
    if (filters.location) {
      const sites = venueLocationSites(venue);
      if (filters.location === "unknown" ? sites.length > 0 : !sites.includes(filters.location)) {
        return false;
      }
    }
    if (!needle) {
      return true;
    }
    return [
      venue.name,
      venue.venue_group,
      venue.entry_type,
      venue.deadline_label,
      venue.archival_status,
      venue.venue_priority,
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle);
  });
}

/**
 * Rewrites a workshop group heading into "Workshops of <parent>".
 *
 * The generated data spells these "EMNLP 2026 Workshops". Leading with the parent conference put
 * the least distinguishing word last, so a column of headings read as a list of venues rather than
 * a list of workshop sets. Only the trailing "Workshops" is moved; a group that does not end that
 * way is left exactly as the data spells it.
 */
export function workshopGroupLabel(venueGroup: string): string {
  const trimmed = venueGroup.trim();
  const parent = trimmed.replace(/\s+workshops$/iu, "").trim();
  return parent && parent !== trimmed ? `Workshops of ${parent}` : trimmed;
}

/**
 * Bundle every venue_group into one heading: workshops by parent conference, conferences by
 * themselves.
 *
 * Grouping earned its place for the 140 workshops first, where one EMNLP heading replaces ten
 * near identical rows. Conferences were left flat for a while because folding ICLR 2027's
 * abstract and full-paper deadlines behind a collapsed heading hid the abstract deadline
 * entirely — but that was a fault in the summary, not in the grouping. A conference group now
 * names its next stage on the collapsed row and lists its whole calendar when opened, which is
 * the only place the board has ever been able to show camera-ready and conference dates beside
 * the submissions they belong to.
 *
 * `standalone` carries the "this is really just a card" decision to the renderer rather than the
 * renderer re-deriving it, so the flat list and the grouped list cannot disagree about what counts
 * as a group.
 */
export function groupDeadlineBoardEntries(
  entries: readonly DeadlineBoardEntry[],
  venues: readonly DeadlineVenue[] = [],
): DeadlineBoardGroup[] {
  const groups = new Map<string, DeadlineBoardGroup>();
  // One ordered list, appended to as each group is first seen. Sorting the result by instant
  // instead would silently reverse the "Past" view, which arrives newest-first.
  const ordered: DeadlineBoardGroup[] = [];
  for (const entry of entries) {
    const id = entry.venue.venue_group.trim();
    const kind: DeadlineGroupKind =
      entry.venue.entry_type === "rebuttal"
        ? "other"
        : entry.venue.archival_status === "archival"
          ? "archival"
          : entry.venue.archival_status === "non_archival"
            ? "nonArchival"
            : entry.venue.archival_status === "mixed"
              ? "mixed"
              : "unknown";
    // Workshops and conferences never share a heading. "EMNLP 2026" and "EMNLP 2026 Workshops"
    // are already distinct venue_groups, but keying on the axis too keeps one mislabelled row
    // from dropping a workshop into a conference timeline.
    const axis = entry.venue.entry_type === "workshop" ? "workshops" : "conference";
    const key = `${axis}::${id}`;
    const current = groups.get(key);
    if (current) {
      current.entries.push(entry);
      current.sections[kind].push(entry);
      continue;
    }
    const sections: Record<DeadlineGroupKind, DeadlineBoardEntry[]> = {
      archival: [],
      nonArchival: [],
      mixed: [],
      unknown: [],
      other: [],
    };
    sections[kind].push(entry);
    const created: DeadlineBoardGroup = {
      id: key,
      label: workshopGroupLabel(id),
      entries: [entry],
      instant: entry.instant,
      sections,
      kind: axis,
      timeline: [],
      standalone: false,
    };
    groups.set(key, created);
    ordered.push(created);
  }
  for (const group of ordered) {
    if (group.kind === "conference") {
      group.timeline = conferenceTimeline(group.entries, venues);
    }
    // A group whose whole contents are one row is a card, not a group: nothing to disclose.
    group.standalone =
      group.kind === "conference" ? group.timeline.length === 1 : group.entries.length === 1;
  }
  return ordered;
}

/**
 * The venue chips, in the order the board itself is in.
 *
 * Ranked by where each group's first row falls in `entries` rather than by re-deriving a date.
 * The list arrives sorted for the period already -- soonest pending stage first for Upcoming,
 * most recently finished first for Past -- so first appearance is that same order, and the chips
 * cannot disagree with the rows underneath them.
 */
function groupOptions(entries: readonly DeadlineBoardEntry[]) {
  const groups = new Map<string, { id: string; label: string; count: number; rank: number }>();
  for (const [rank, entry] of entries.entries()) {
    const current = groups.get(entry.venue.venue_group);
    if (current) {
      current.count += 1;
    } else {
      groups.set(entry.venue.venue_group, {
        id: entry.venue.venue_group,
        // Same wording as the group heading. The id stays the raw venue_group, which is what
        // filtering matches on, so renaming the chip cannot break selection.
        label: workshopGroupLabel(entry.venue.venue_group),
        count: 1,
        rank,
      });
    }
  }
  return [...groups.values()].toSorted(
    (left, right) => left.rank - right.rank || left.label.localeCompare(right.label),
  );
}

export function workshopSourceLinks(venue: DeadlineVenue): {
  titleUrl: string;
  sourceUrl: string;
  sourceLabel: "CFP" | "Website" | "";
  openReviewUrl: string;
} | null {
  if (venue.entry_type !== "workshop") {
    return null;
  }
  const cfpUrl = venue.cfp_url?.trim() || "";
  const homepageUrl = venue.homepage_url?.trim() || "";
  return {
    titleUrl: homepageUrl,
    sourceUrl: cfpUrl || homepageUrl,
    sourceLabel: cfpUrl ? "CFP" : homepageUrl ? "Website" : "",
    openReviewUrl: venue.openreview_url?.trim() || "",
  };
}

export function priorDeadlineRevisions(venue: DeadlineVenue) {
  const revisions = venue.revisions.reduce<DeadlineVenue["revisions"]>((deduplicated, revision) => {
    const previous = deduplicated.at(-1);
    if (previous?.deadline_aoe.slice(0, 16) === revision.deadline_aoe.slice(0, 16)) {
      deduplicated[deduplicated.length - 1] = revision;
    } else {
      deduplicated.push(revision);
    }
    return deduplicated;
  }, []);
  if (revisions.at(-1)?.deadline_aoe.slice(0, 16) === venue.deadline_aoe.slice(0, 16)) {
    revisions.pop();
  }
  return revisions;
}

export type DeadlineChangeSummary = {
  kind: "extended" | "corrected" | "updated";
  label: "Extended" | "Corrected" | "Updated";
  changeCount: number;
  dates: string[];
};

export function deadlineChangeSummary(venue: DeadlineVenue): DeadlineChangeSummary | null {
  const dates = venue.revisions
    .map((revision) => revision.deadline_aoe)
    .filter(Boolean)
    .filter(
      (deadline, index, revisions) => deadline.slice(0, 16) !== revisions[index - 1]?.slice(0, 16),
    );
  if (venue.deadline_aoe && dates.at(-1)?.slice(0, 16) !== venue.deadline_aoe.slice(0, 16)) {
    dates.push(venue.deadline_aoe);
  }
  if (dates.length < 2) {
    return null;
  }
  if (
    venue.deadline_time_precision === "date_only" ||
    venue.revisions.some((revision) => revision.deadline_time_precision === "date_only")
  ) {
    return { kind: "updated", label: "Updated", changeCount: dates.length - 1, dates };
  }
  const changes = dates.slice(1).map((deadline, index) => {
    return aoeInstantMs(deadline) - aoeInstantMs(dates[index]!);
  });
  if (changes.every((change) => change > 0)) {
    return { kind: "extended", label: "Extended", changeCount: changes.length, dates };
  }
  if (changes.every((change) => change < 0)) {
    return { kind: "corrected", label: "Corrected", changeCount: changes.length, dates };
  }
  return { kind: "updated", label: "Updated", changeCount: changes.length, dates };
}

export function deadlineChangeLabel(venue: DeadlineVenue): string {
  const change = deadlineChangeSummary(venue);
  if (!change) {
    return "";
  }
  const labels = change.dates.map((date) => {
    const record =
      date === venue.deadline_aoe
        ? venue
        : venue.revisions.find((revision) => revision.deadline_aoe === date);
    return record ? deadlineDateTimeLabel(record) : aoeDateTimeLabel(date);
  });
  return `${change.label}: ${labels.join(" → ")}`;
}

function renderDeadlineTitle(venue: DeadlineVenue, label = venue.name) {
  const titleUrl = workshopSourceLinks(venue)?.titleUrl || venue.link?.trim();
  return titleUrl
    ? html`<a href=${titleUrl} target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
}

export function archivalLabelOf(venue: DeadlineVenue): string {
  if (venue.archival_status === "unknown") {
    return "Archival status not established";
  }
  if (venue.archival_status === "mixed") {
    return "Archival + non-archival";
  }
  return venue.archival_status === "non_archival" ? "Non-archival" : "Archival";
}

/**
 * Every site the parent conference meets at, in the order it published them.
 *
 * A multi-site conference publishes all of its sites and the board keeps all of them — NeurIPS
 * 2026 runs in Sydney, Atlanta and Paris at once, and naming only the first would tell most
 * attendees the wrong continent. Sites arrive semicolon-separated because each one carries its
 * own "City, Country" comma.
 *
 * This is the conference's answer, not a workshop's. A group heading wants it, because the
 * heading stands for every row beneath it; a single row wants `venueLocationSites`.
 */
export function venueConferenceSites(venue: DeadlineVenue): string[] {
  return (venue.conference_location ?? "")
    .split(";")
    .map((site) => site.trim())
    .filter(Boolean);
}

/**
 * Where this particular venue meets.
 *
 * A workshop at a multi-site conference meets at one of its sites, not all of them, and the
 * collector resolves which by asking the workshop's own page — so a row prefers that answer over
 * the inherited list. It falls back to every site when the workshop did not say, which is both
 * the honest answer and what the board showed before it could tell them apart.
 */
export function venueLocationSites(venue: DeadlineVenue): string[] {
  const site = (venue.workshop_location ?? "").trim();
  return site ? [site] : venueConferenceSites(venue);
}

/**
 * Sites as one line of text, for a title attribute or a surface with no room for markup.
 * Empty when the venue has published no location.
 */
export function venueLocationLabel(venue: DeadlineVenue): string {
  return venueLocationSites(venue).join(" · ");
}

/**
 * The location chip.
 *
 * `data-site-count` lets a narrow surface tighten a multi-site chip without the renderer having
 * to know which surface it is on, and the full list stays in `title` for the case where CSS
 * truncates it.
 */
function renderVenueLocation(venue: DeadlineVenue, override?: readonly string[]) {
  const sites = override ?? venueLocationSites(venue);
  if (!sites.length) {
    return nothing;
  }
  const label = sites.join(" · ");
  return html`<span
    class="deadline-location"
    data-site-count=${sites.length}
    title=${sites.length > 1 ? `Multi-site: ${label}` : label}
  >
    <span class="deadline-location__icon" aria-hidden="true">${icons.mapPin}</span>
    <span class="sr-only">${sites.length > 1 ? "Locations" : "Location"}:</span>
    <span class="deadline-location__sites">${label}</span>
  </span>`;
}

/**
 * Only the publication policy is shown now.
 *
 * The Primary/Secondary venue priority was dropped from the board: it applied to 10 of 154 venues,
 * carried no date information, and sat beside the archival label where the two were routinely read
 * as one classification. `venue_priority` is still on the record for anything that wants to rank
 * venues — it is simply not a badge.
 */
function renderClassification(venue: DeadlineVenue, placement = "card") {
  return html`${venueLocationSites(venue).length
    ? wrapSeparator()
    : nothing}${renderPublicationPolicy(venue, archivalLabelOf(venue), placement)}`;
}

const ENTRY_TYPE_LABELS: Record<DeadlineVenue["entry_type"], string> = {
  main_conference: "Main conference",
  demo_track: "Demo track",
  workshop: "Workshop",
  arr_direct_submission: "ARR direct submission",
  arr_commitment: "ARR commitment",
  rebuttal: "Rebuttal",
  other: "Other",
};

const ENTRY_TYPE_OPTIONS: ReadonlyArray<{ value: DeadlineBoardEntryType; label: string }> = [
  { value: "all", label: "All types" },
  { value: "main_conference", label: "Main conferences" },
  { value: "demo_track", label: "Demo tracks" },
  { value: "workshop", label: "Workshops" },
  { value: "arr_direct_submission", label: "ARR direct submissions" },
  { value: "arr_commitment", label: "ARR commitments" },
  { value: "rebuttal", label: "Rebuttals" },
  { value: "other", label: "Other" },
];

const ARCHIVAL_STATUS_OPTIONS: ReadonlyArray<{
  value: DeadlineBoardArchivalStatus;
  label: string;
}> = [
  { value: "all", label: "All statuses" },
  { value: "archival", label: "Archival" },
  { value: "non_archival", label: "Non-archival" },
  { value: "mixed", label: "Archival + non-archival" },
  { value: "unknown", label: "Archival status unknown" },
];

/**
 * The instant a row is counting down to: the soonest stage it is still waiting on.
 *
 * Identical to the submission for every row whose deadline is still open, because that is the
 * first stage of its own calendar. It moves on only for a row whose deadline has passed and whose
 * notification or conference has not.
 */
function countdownTarget(entry: DeadlineBoardEntry, now: number): number {
  if (!Number.isFinite(entry.instant)) {
    return Number.POSITIVE_INFINITY;
  }
  return entry.stage?.instant ?? nextVenueStage(entry.venue, now)?.instant ?? entry.instant;
}

function urgency(entry: DeadlineBoardEntry, now: number): DeadlineUrgency {
  if (!Number.isFinite(entry.instant)) {
    return "unknown";
  }
  const target = countdownTarget(entry, now);
  return target <= now ? "passed" : urgencyOf(target, now);
}

function capitalize(value: string): string {
  return value ? `${value[0].toLocaleUpperCase()}${value.slice(1)}` : "Deadline";
}

/**
 * What one row calls itself under a group heading.
 *
 * Under a conference the row is a stage of that conference, so the stage is the whole name:
 * "EMNLP 2026 (main, ARR commitment)" repeats the heading back at the reader where "Commitment"
 * says the one thing that distinguishes it from the rows above and below. Under a workshop
 * bundle the row is a separate venue, so its own name survives with the parent trimmed off.
 */
function groupRowTitle(
  venue: DeadlineVenue,
  conference: string,
  groupKind: DeadlineBoardGroup["kind"] = "workshops",
) {
  const stage = capitalize(venue.deadline_label);
  if (groupKind === "conference") {
    return { name: stage, stage: "" };
  }
  const titleContext = venue.venue_group.trim().replace(/\s+workshops$/iu, "") || conference;
  let name = venue.name.trim();
  for (const affix of [` (${titleContext})`, ` [${titleContext}]`]) {
    if (name.endsWith(affix)) {
      name = name.slice(0, -affix.length).trim();
    }
  }
  for (const separator of [" — ", " – ", " - ", ": "]) {
    if (name.startsWith(`${titleContext}${separator}`)) {
      name = name.slice(titleContext.length + separator.length).trim();
    }
  }
  if (name.toLocaleLowerCase() === titleContext.toLocaleLowerCase()) {
    return { name: stage, stage: "" };
  }
  if (stage.toLocaleLowerCase() === "arr commitment") {
    name = name.replace(/\s*(?:\(ARR commitment\)|[-—–:]?\s*ARR commitment)$/iu, "").trim();
  }
  return { name: name || venue.name, stage };
}

class AdminbotDeadlinesView extends LitElement {
  static override properties = {
    accessRole: { type: String, attribute: "access-role" },
    memberId: { type: String, attribute: "member-id" },
    proposalStore: { attribute: false },
    recommendationStore: { attribute: false },
    timelineMilestones: { attribute: false },
    onSaveTimeline: { attribute: false },
    conferenceBaseUrl: { attribute: false },
  };

  conferenceBaseUrl = "";
  private conferenceRosters: ConferenceRoster[] = [];
  private conferenceLoad = 0;
  private conferenceError = "";
  private async loadConferenceRosters() {
    const generation = ++this.conferenceLoad;
    this.conferenceRosters = [];
    this.conferenceError = "";
    const token = loadStoredMemberSession()?.sessionToken;
    if (this.accessRole !== "admin" || !token) {
      this.requestUpdate();
      return;
    }
    const result = await fetchConferenceRosters(token, this.conferenceBaseUrl).catch(() => ({
      ok: false as const,
      kind: "unreachable" as const,
    }));
    if (generation !== this.conferenceLoad || this.accessRole !== "admin") return;
    if (result.ok) this.conferenceRosters = result.value;
    else
      this.conferenceError =
        "Conference attendance is unavailable. Check the backend release and connection.";
    this.requestUpdate();
  }
  accessRole: AccessRole = "anonymous";
  memberId = "";
  recommendationStore: DeadlineRecommendationStore = new AdminBotDeadlineRecommendationStore();
  private recommendationDirectory?: DeadlineRecommendationDirectory;
  private recommendationLoad = 0;
  private recommendationIds: string[] = [];
  private recommendationScope = "";
  private loadedRecommendationScope = "";
  private async loadRecommendations() {
    const generation = ++this.recommendationLoad;
    this.recommendationDirectory = undefined;
    if (!this.memberId || this.accessRole === "anonymous") {
      this.requestUpdate();
      return;
    }
    try {
      const ids = this.recommendationIds;
      const batches = Array.from({ length: Math.max(1, Math.ceil(ids.length / 250)) }, (_, index) =>
        ids.slice(index * 250, (index + 1) * 250),
      );
      const results = await Promise.all(
        batches.map((deadlineIds) =>
          this.recommendationStore.list({ mode: "summary", deadlineIds }),
        ),
      );
      const directory = {
        members: [
          ...new Map(
            results.flatMap((result) => result.members).map((member) => [member.id, member]),
          ).values(),
        ],
        papers: [],
        recommendations: results.flatMap((result) => result.recommendations),
      };
      if (generation === this.recommendationLoad) {
        this.recommendationDirectory = directory;
      }
    } catch {
      // Recipient indicators are optional; the form owns member-loading errors and retries.
    }
    this.requestUpdate();
  }
  proposalStore: DeadlineProposalStore = DEFAULT_DEADLINE_PROPOSAL_STORE;
  /** The signed-in member's own milestones; null until their record has loaded. */
  timelineMilestones: MilestoneRow[] | null = null;
  /** Saves the member's whole milestone list; resolves true when the save landed. */
  onSaveTimeline?: (milestones: MilestoneRow[]) => Promise<boolean>;
  private timelineBusyId = "";
  private timelineFailedId = "";

  private timer: number | undefined;
  private readonly expandedGroups = new Set<string>();
  private readonly expandedSchedules = new Set<string>();
  private now = Date.now();
  private activeGroup = "";
  private query = "";
  private entryType: DeadlineBoardEntryType = "paper_deadlines";
  private archivalStatus: DeadlineBoardArchivalStatus = "publication_actions";
  private location = "";
  private stageFilter = "submission_actions";

  private selectedStage(venue: DeadlineVenue): DeadlineStage | undefined {
    return this.stageFilter
      ? chooseStage(
          venueStages(venue, this.displayZone, this.venues),
          this.stageFilter,
          this.now,
          this.period,
        )
      : this.period === "upcoming"
        ? nextVenueStage(venue, this.now, this.displayZone, this.venues)
        : undefined;
  }
  private period: DeadlineBoardPeriod = "upcoming";
  private view: DeadlineBoardView = "groups";
  private displayZone = loadDeadlineTimezone();
  private venues: DeadlineVenue[] = [];
  private proposals: DeadlineProposal[] = [];
  private proposalFormOpen = false;
  private proposalReviewOpen = false;
  private proposalListScope: "mine" | "review" = "mine";
  private editingProposalId = "";
  private proposalSubmissionKey = "";
  private proposalBusy = false;
  private proposalErrors: Partial<Record<keyof DeadlineProposalInput, string>> = {};
  private proposalNotice = "";
  private proposalFailure = "";

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  private datasetRefreshTimer?: number;

  override connectedCallback(): void {
    super.connectedCallback();
    this.timer = window.setInterval(() => {
      this.now = Date.now();
      this.requestUpdate();
    }, 1000);
    this.datasetRefreshTimer = window.setInterval(
      () => {
        if (document.visibilityState !== "hidden") {
          void this.loadPublishedDeadlines();
        }
      },
      5 * 60 * 1000,
    );
    // The first `updated` call loads the bound store. Loading here as well requests the same
    // deadline dataset twice on every visit (and can request the default URL before settings bind).
  }

  override disconnectedCallback(): void {
    ++this.recommendationLoad;
    if (this.datasetRefreshTimer !== undefined) {
      window.clearInterval(this.datasetRefreshTimer);
      this.datasetRefreshTimer = undefined;
    }
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    super.disconnectedCallback();
  }

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("accessRole") || changed.has("memberId") || changed.has("conferenceBaseUrl"))
      void this.loadConferenceRosters();
    if (
      changed.has("recommendationStore") ||
      changed.has("memberId") ||
      changed.has("accessRole") ||
      this.recommendationScope !== this.loadedRecommendationScope
    ) {
      this.loadedRecommendationScope = this.recommendationScope;
      void this.loadRecommendations();
    }
    if (changed.has("proposalStore")) {
      void this.loadPublishedDeadlines();
    }
    // One read however many of these changed: the first render sets all three at once.
    if (
      (changed.has("proposalStore") || changed.has("accessRole") || changed.has("memberId")) &&
      this.accessRole !== "anonymous" &&
      this.memberId
    ) {
      void this.loadProposals();
    }
    const drawer = this.proposalDrawer();
    const shouldOpenDrawer = this.proposalFormOpen || this.proposalReviewOpen;
    if (shouldOpenDrawer && drawer && !drawer.open) {
      if (typeof drawer.showModal === "function") {
        drawer.showModal();
      } else {
        drawer.open = true;
      }
    } else if (!shouldOpenDrawer && drawer?.open) {
      if (typeof drawer.close === "function") {
        drawer.close();
      } else {
        drawer.open = false;
      }
    }
  }

  private proposalDrawer(): HTMLDialogElement | null {
    return this.querySelector<HTMLDialogElement>("[data-testid='deadline-proposal-drawer']");
  }

  private closeProposalDrawer(): void {
    const drawer = this.proposalDrawer();
    if (drawer?.open) {
      if (typeof drawer.close === "function") {
        drawer.close();
      } else {
        drawer.open = false;
      }
    }
    this.proposalFormOpen = false;
    this.proposalReviewOpen = false;
    this.editingProposalId = "";
    this.requestUpdate();
  }

  private selectGroup(group: string): void {
    this.activeGroup = group;
    this.requestUpdate();
  }

  private setQuery(event: Event): void {
    this.query = (event.currentTarget as HTMLInputElement).value;
    this.requestUpdate();
  }

  private setEntryType(event: Event): void {
    this.entryType = (event.currentTarget as HTMLSelectElement).value as DeadlineBoardEntryType;
    this.requestUpdate();
  }

  private setArchivalStatus(event: Event): void {
    this.archivalStatus = (event.currentTarget as HTMLSelectElement)
      .value as DeadlineBoardArchivalStatus;
    this.requestUpdate();
  }

  private setPeriod(period: DeadlineBoardPeriod): void {
    this.period = period;
    this.requestUpdate();
  }

  private setView(view: DeadlineBoardView): void {
    this.view = view;
    this.requestUpdate();
  }

  private toggleGroup(group: string): void {
    if (this.expandedGroups.has(group)) {
      this.expandedGroups.delete(group);
    } else {
      this.expandedGroups.add(group);
    }
    this.requestUpdate();
  }

  private async loadProposals(): Promise<void> {
    try {
      this.proposals = await this.proposalStore.list();
      this.proposalFailure = "";
    } catch (error) {
      this.proposalFailure = error instanceof Error ? error.message : String(error);
    }
    this.requestUpdate();
  }

  private datasetFailure = "";
  private datasetLoading = true;

  private async loadPublishedDeadlines(): Promise<void> {
    this.datasetLoading = true;
    this.requestUpdate();
    try {
      const venues = await this.proposalStore.listPublished();
      if (!venues.length) {
        throw new Error("Empty deadline response");
      }
      this.venues = venues;
      this.datasetFailure = "";
    } catch (error) {
      // The reason is carried, not swallowed. The board has no bundled copy to fall back on, so
      // this message is the whole surface when the read fails -- and "check the service connection"
      // describes a service that is down, a service whose ADMINBOT_ALLOWED_ORIGINS does not name
      // this site, and a route an older release does not serve yet, without telling them apart.
      // The thrown error already distinguishes them: a refused origin answers "origin is not
      // allowed", a missing route 404s, and an unreachable host fails with no response at all.
      const reason = error instanceof Error ? error.message : String(error);
      this.datasetFailure = this.venues.length
        ? `Could not refresh live deadlines (${reason}). Showing the last successful server response; dates and approved corrections may be out of date.`
        : `Could not load live deadlines (${reason}). Check that the AdminBot service is running and that this site's address is in ADMINBOT_ALLOWED_ORIGINS, then try again.`;
    } finally {
      this.datasetLoading = false;
    }
    this.requestUpdate();
  }

  private correctionTarget?: DeadlineVenue;
  private correctionStage?: DeadlineMilestone;
  private correctionContext?: DeadlineVenue;
  private correctionChoice = "primary";
  private proposalVenue?: DeadlineVenue;
  private proposalStageKind = "submission";

  private openProposalForm(): void {
    this.correctionTarget = undefined;
    this.correctionStage = undefined;
    this.correctionContext = undefined;
    this.correctionChoice = "primary";
    this.proposalVenue = undefined;
    this.proposalStageKind = "submission";
    this.proposalErrors = {};
    this.proposalSubmissionKey = "";
    this.proposalFormOpen = true;
    this.proposalReviewOpen = false;
    this.editingProposalId = "";
    this.proposalNotice = "";
    this.proposalFailure = "";
    this.requestUpdate();
  }

  private async submitProposal(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (this.proposalBusy) {
      return;
    }
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const venueSearch = form.querySelector<HTMLInputElement>('input[name="stageVenue"]');
    if (
      venueSearch &&
      venueSearch.value !==
        (this.proposalVenue
          ? proposalVenueLabel(this.proposalVenue)
          : t("deadlineStageProposal.newVenue"))
    ) {
      this.proposalFailure = t("deadlineStageProposal.chooseVenue");
      this.requestUpdate();
      return;
    }
    const input: DeadlineProposalInput = {
      name: String(data.get("name") ?? ""),
      parentConference: String(data.get("parentConference") ?? ""),
      parentYear: String(data.get("parentYear") ?? ""),
      entryType: String(data.get("entryType") ?? "other") as DeadlineProposalInput["entryType"],
      deadlineDate: String(data.get("deadlineDate") ?? ""),
      deadlineTime: String(data.get("deadlineTime") ?? ""),
      timezone: String(data.get("timezone") ?? ""),
      homepageUrl: String(data.get("homepageUrl") ?? ""),
      cfpUrl: String(data.get("cfpUrl") ?? ""),
      openReviewUrl: String(data.get("openReviewUrl") ?? ""),
      note: String(data.get("note") ?? ""),
    };
    const editing = this.proposals.find((p) => p.id === this.editingProposalId);
    if (editing?.deadline.stage) {
      input.stage = editing.deadline.stage;
    } else if (this.correctionTarget && this.correctionStage) {
      input.stage = stageCorrection(this.correctionTarget, this.correctionStage);
    } else if (!this.correctionTarget) {
      const kindValue = data.get("stageKind");
      const kind = typeof kindValue === "string" ? kindValue : "submission";
      const label =
        kind === "other"
          ? (typeof data.get("stageLabel") === "string"
              ? (data.get("stageLabel") as string)
              : ""
            ).trim()
          : deadlineStageKinds.find(([key]) => key === kind)?.[1] || kind;
      input.stage = {
        milestone: kind === "other" ? `custom:${label}` : kind,
        label,
        operation: "add",
        ...(this.proposalVenue ? { venueId: this.proposalVenue.id } : {}),
      };
    }
    const validation = validateDeadlineProposal(input);
    if (!validation.ok) {
      this.proposalErrors = validation.errors;
      this.proposalFailure = "Check the highlighted fields.";
      this.requestUpdate();
      return;
    }
    this.proposalBusy = true;
    this.proposalErrors = {};
    this.proposalFailure = "";
    this.requestUpdate();
    try {
      if (this.editingProposalId) {
        await this.proposalStore.revise(this.editingProposalId, validation.value);
      } else {
        this.proposalSubmissionKey ||= crypto.randomUUID();
        if (this.memberId && this.accessRole !== "anonymous") {
          await this.proposalStore.submit(
            validation.value,
            this.proposalSubmissionKey,
            this.correctionTarget?.id,
          );
        } else {
          await this.proposalStore.submitPublic(validation.value, this.proposalSubmissionKey, {
            name: String(data.get("submitterName") ?? ""),
            email: String(data.get("submitterEmail") ?? ""),
          });
        }
      }
      form.reset();
      this.proposalFormOpen = false;
      this.proposalNotice = this.editingProposalId
        ? "A revised deadline is ready for administrator approval."
        : "Proposal submitted for administrator review. It is not public until approved.";
      this.editingProposalId = "";
      this.proposalSubmissionKey = "";
      if (this.memberId && this.accessRole !== "anonymous") {
        await this.loadProposals();
      }
    } catch (error) {
      this.proposalFailure = error instanceof Error ? error.message : String(error);
    } finally {
      this.proposalBusy = false;
      this.requestUpdate();
    }
  }

  private async decideProposal(
    proposal: DeadlineProposal,
    decision: "published" | "rejected",
  ): Promise<void> {
    if (this.accessRole !== "admin" || this.proposalBusy) {
      return;
    }
    this.proposalBusy = true;
    this.proposalFailure = "";
    try {
      await this.proposalStore.decide(proposal, decision);
      this.proposalNotice =
        decision === "published"
          ? "Deadline approved and published."
          : "Deadline proposal rejected.";
      await this.loadProposals();
      if (decision === "published") {
        await this.loadPublishedDeadlines();
      }
    } catch (error) {
      this.proposalFailure = error instanceof Error ? error.message : String(error);
    } finally {
      this.proposalBusy = false;
      this.requestUpdate();
    }
  }

  private editProposal(proposal: DeadlineProposal): void {
    this.correctionTarget = undefined;
    this.correctionStage = undefined;
    this.correctionContext = undefined;
    this.correctionChoice = "primary";
    this.proposalVenue = undefined;
    this.editingProposalId = proposal.id;
    this.proposalFormOpen = true;
    this.proposalReviewOpen = false;
    this.proposalNotice = "";
    this.proposalFailure = "";
    this.requestUpdate();
  }

  private openProposalList(scope: "mine" | "review"): void {
    this.proposalListScope = scope;
    this.proposalReviewOpen = true;
    this.proposalFormOpen = false;
    this.requestUpdate();
  }

  private renderProposalFieldError(field: keyof DeadlineProposalInput) {
    const error = this.proposalErrors[field];
    return error ? html`<small class="deadline-proposal__error">${error}</small>` : nothing;
  }

  private renderProposalForm() {
    if (!this.proposalFormOpen) {
      return nothing;
    }
    const editing = this.proposals.find((proposal) => proposal.id === this.editingProposalId);
    const target =
      this.correctionTarget ??
      this.proposalVenue ??
      this.venues.find((v) => v.id === editing?.deadline.stage?.venueId);
    const value =
      editing?.deadline ??
      (target
        ? {
            name: target.name,
            entryType: target.entry_type,
            parentConference: target.venue_family ?? "",
            parentYear: "",
            ...(this.correctionTarget
              ? proposalDateFields(target, this.correctionStage)
              : { deadlineDate: "", deadlineTime: "", timezone: "" }),
            homepageUrl: target.homepage_url || target.link || "",
            cfpUrl: target.cfp_url || "",
            openReviewUrl: target.openreview_url || "",
            note: "",
          }
        : undefined);
    const correctionContext = this.correctionContext ?? this.correctionTarget;
    const correctionChoices = correctionContext
      ? venueSchedule(correctionContext, { venues: this.venues }).filter(
          (stage) => stage.kind !== "period" && stage.milestone !== "notification_by",
        )
      : [];
    const parentConferences = parentConferenceOptions(this.venues);
    const parentConference = value?.parentConference ?? "";
    return html`
      <section
        class="deadline-proposal deadline-proposal--drawer"
        data-testid="deadline-proposal-form-panel"
      >
        <div class="deadline-proposal__heading">
          <div>
            <h2 id="deadline-proposal-drawer-title">
              ${editing
                ? "Revise deadline proposal"
                : this.correctionTarget
                  ? `Correct ${target!.name}: ${this.correctionStage?.label ?? capitalize(target!.deadline_label)}`
                  : "Propose a new deadline"}
            </h2>
          </div>
          <button class="btn btn--sm" type="button" @click=${this.closeProposalDrawer}>
            Cancel
          </button>
        </div>
        <p class="deadline-proposal__helper">
          Proposals remain private until an administrator approves and publishes them.
        </p>
        <form class="deadline-proposal__form" @submit=${this.submitProposal}>
          ${!this.memberId || this.accessRole === "anonymous"
            ? html`
                <label style="align-content: start">
                  <span>Name <small>optional</small></span>
                  <input name="submitterName" autocomplete="name" maxlength="200" />
                </label>
                <label style="align-content: start">
                  <span>Email <small>optional</small></span>
                  <input name="submitterEmail" type="email" autocomplete="email" maxlength="254" />
                  <small>Only used if we need to ask about your submission.</small>
                </label>
              `
            : nothing}
          ${!editing && !this.correctionTarget
            ? html`<label class="deadline-proposal__wide">
                <span>${t("deadlineStageProposal.venue")}</span>
                <adminbot-deadline-parent-conference-select
                  .options=${[
                    t("deadlineStageProposal.newVenue"),
                    ...this.venues.map(proposalVenueLabel),
                  ]}
                  .value=${target
                    ? proposalVenueLabel(target)
                    : t("deadlineStageProposal.newVenue")}
                  .fieldName=${"stageVenue"}
                  .fieldLabel=${t("deadlineStageProposal.venue")}
                  @selection-change=${(event: CustomEvent<string>) => {
                    this.proposalVenue = this.venues.find(
                      (v) => proposalVenueLabel(v) === event.detail,
                    );
                    this.proposalSubmissionKey = "";
                    this.requestUpdate();
                  }}
                ></adminbot-deadline-parent-conference-select>
              </label>`
            : nothing}
          ${this.correctionTarget && !editing && correctionContext
            ? html`<label class="deadline-proposal__wide">
                <span>${t("deadlineStageProposal.stage")}</span>
                <select
                  name="correctionStage"
                  .value=${this.correctionChoice}
                  @change=${(event: Event) => {
                    this.correctionChoice = (event.target as HTMLSelectElement).value;
                    const stage = correctionChoices[Number(this.correctionChoice)];
                    this.correctionContext = correctionContext;
                    this.correctionTarget = stage?.abstractVenue ?? correctionContext;
                    this.correctionStage = stage?.abstractVenue ? undefined : stage;
                    this.proposalSubmissionKey = "";
                    this.proposalErrors = {};
                    this.proposalFailure = "";
                    this.requestUpdate();
                  }}
                >
                  <option value="primary" ?selected=${this.correctionChoice === "primary"}>
                    ${capitalize(correctionContext.deadline_label)}
                  </option>
                  ${correctionChoices.map(
                    (stage, index) =>
                      html`<option
                        value=${String(index)}
                        ?selected=${this.correctionChoice === String(index)}
                      >
                        ${stage.label}
                      </option>`,
                  )}
                </select>
              </label>`
            : nothing}
          ${!this.correctionTarget && !editing
            ? html`<label class="deadline-proposal__wide">
                  <span>${t("deadlineStageProposal.stage")}</span>
                  <select
                    name="stageKind"
                    .value=${this.proposalStageKind}
                    @change=${(event: Event) => {
                      this.proposalStageKind = (event.target as HTMLSelectElement).value;
                      this.requestUpdate();
                    }}
                  >
                    ${deadlineStageKinds.map(
                      ([key]) =>
                        html`<option value=${key}>
                          ${t(`deadlineStageProposal.kinds.${key}`)}
                        </option>`,
                    )}</select
                  >${this.renderProposalFieldError("stage")}
                </label>
                ${this.proposalStageKind === "other"
                  ? html`<label class="deadline-proposal__wide"
                      ><span>${t("deadlineStageProposal.stageName")}</span
                      ><input name="stageLabel" required maxlength="120"
                    /></label>`
                  : nothing}`
            : editing?.deadline.stage
              ? html`<p class="deadline-proposal__wide">${editing.deadline.stage.label}</p>`
              : nothing}
          <label ?hidden=${Boolean(target)}>
            <span>Conference or workshop name</span>
            <input
              name="name"
              required
              ?autofocus=${!target}
              .value=${value?.name ?? ""}
              aria-invalid=${String(Boolean(this.proposalErrors.name))}
            />
            ${this.renderProposalFieldError("name")}
          </label>
          <label ?hidden=${Boolean(target)}>
            <span>Entry type</span>
            <select name="entryType" required>
              ${ENTRY_TYPE_OPTIONS.filter((option) => option.value !== "all").map(
                (option) => html`<option
                  value=${option.value}
                  ?selected=${option.value === (value?.entryType ?? "main_conference")}
                >
                  ${option.label}
                </option>`,
              )}
            </select>
          </label>
          <label ?hidden=${Boolean(target)}>
            <span>Parent conference <small>optional</small></span>
            ${renderDeadlineParentConferenceSelect({
              options: parentConferences,
              value: parentConference,
            })}
          </label>
          <label ?hidden=${Boolean(target)}>
            <span>Parent year <small>optional</small></span>
            <input
              name="parentYear"
              inputmode="numeric"
              maxlength="4"
              placeholder="2026"
              .value=${value?.parentYear ?? ""}
              aria-invalid=${String(Boolean(this.proposalErrors.parentYear))}
            />
            ${this.renderProposalFieldError("parentYear")}
          </label>
          <div class="deadline-proposal__datetime deadline-proposal__wide">
            <label>
              <span>Deadline date</span>
              ${renderDateControl(
                html`<input
                  name="deadlineDate"
                  ?autofocus=${Boolean(target)}
                  type="date"
                  required
                  .value=${value?.deadlineDate ?? ""}
                  aria-invalid=${String(Boolean(this.proposalErrors.deadlineDate))}
                />`,
                value?.deadlineDate ?? "",
              )}
              ${this.renderProposalFieldError("deadlineDate")}
            </label>
            <label>
              <span>Deadline time <small>optional</small></span>
              <input
                name="deadlineTime"
                type="time"
                .value=${value?.deadlineTime ?? ""}
                aria-invalid=${String(Boolean(this.proposalErrors.deadlineTime))}
              />
              ${this.renderProposalFieldError("deadlineTime")}
            </label>
            <label>
              <span>Time zone</span>
              <select name="timezone" aria-invalid=${String(Boolean(this.proposalErrors.timezone))}>
                <option value="" ?selected=${!value?.timezone}>Time zone unknown</option>
                ${timezoneOptions(AOE_TIMEZONE).map(
                  (group) => html`<optgroup label=${group.label}>
                    ${group.options.map(
                      (option) => html`<option
                        value=${option.zone}
                        ?selected=${option.zone === value?.timezone}
                      >
                        ${option.label}
                      </option>`,
                    )}
                  </optgroup>`,
                )}
              </select>
              ${this.renderProposalFieldError("timezone")}
            </label>
          </div>
          <label class="deadline-proposal__wide">
            <span>Homepage URL</span>
            <input
              name="homepageUrl"
              type="url"
              required
              placeholder="https://…"
              .value=${value?.homepageUrl ?? ""}
              aria-invalid=${String(Boolean(this.proposalErrors.homepageUrl))}
            />
            ${this.renderProposalFieldError("homepageUrl")}
          </label>
          <label class="deadline-proposal__wide">
            <span>CFP URL <small>optional</small></span>
            <input
              name="cfpUrl"
              type="url"
              placeholder="https://…"
              .value=${value?.cfpUrl ?? ""}
              aria-invalid=${String(Boolean(this.proposalErrors.cfpUrl))}
            />
            ${this.renderProposalFieldError("cfpUrl")}
          </label>
          <label class="deadline-proposal__wide">
            <span>OpenReview URL <small>optional</small></span>
            <input
              name="openReviewUrl"
              type="url"
              placeholder="https://openreview.net/…"
              .value=${value?.openReviewUrl ?? ""}
              aria-invalid=${String(Boolean(this.proposalErrors.openReviewUrl))}
            />
            ${this.renderProposalFieldError("openReviewUrl")}
          </label>
          <label class="deadline-proposal__wide">
            <span>Note for the administrator <small>optional</small></span>
            <textarea name="note" rows="3" .value=${value?.note ?? ""}></textarea>
          </label>
          <div class="deadline-proposal__actions deadline-proposal__wide">
            <button class="btn primary" type="submit" ?disabled=${this.proposalBusy}>
              ${this.proposalBusy
                ? editing
                  ? "Saving revision…"
                  : "Submitting…"
                : editing
                  ? "Save revision for review"
                  : "Submit for review"}
            </button>
          </div>
        </form>
      </section>
    `;
  }

  private renderProposalReview() {
    if (!this.proposalReviewOpen || !this.memberId || this.accessRole === "anonymous") {
      return nothing;
    }
    const canReview = this.proposalListScope === "review" && this.accessRole === "admin";
    const visibleProposals = canReview
      ? this.proposals
      : this.proposals.filter((proposal) => proposal.submitter_member_id === this.memberId);
    const actionable = visibleProposals.filter(
      (proposal) => proposal.status === "pending" || proposal.status === "approved",
    );
    const reviewed = visibleProposals.filter(
      (proposal) => proposal.status !== "pending" && proposal.status !== "approved",
    );
    const renderRow = (proposal: DeadlineProposal) => {
      const deadline = proposal.deadline;
      const isVisitor = proposal.submitter_member_id.startsWith("visitor:deadline:");
      const submitterLabel =
        proposal.submitter_member_id === this.memberId
          ? "Submitted by you"
          : `Submitted by ${proposal.submitter_name || "a lab member"}`;
      return html`
        <article class="deadline-proposal-row" data-status=${proposal.status}>
          <div class="deadline-proposal-row__meta">
            <span class="deadline-proposal-row__status">${capitalize(proposal.status)}</span>
            <span
              class="deadline-proposal-row__source"
              data-source=${isVisitor ? "visitor" : "member"}
              data-testid="deadline-proposal-source"
            >
              <span aria-hidden="true">${isVisitor ? icons.user : icons.users}</span>
              ${isVisitor ? "Visitor" : "Lab member"}
            </span>
          </div>
          <div class="deadline-proposal-row__heading">
            <h3>${deadline.name}</h3>
            <span
              >${[
                deadline.stage?.label,
                deadline.deadlineDate,
                deadline.deadlineTime || t("deadlineStageProposal.timeUnknown"),
                deadline.timezone,
              ]
                .filter(Boolean)
                .join(" · ")}</span
            >
          </div>
          <p>
            ${ENTRY_TYPE_LABELS[deadline.entryType]}
            ${deadline.parentConference
              ? ` · ${deadline.parentConference}${deadline.parentYear ? ` ${deadline.parentYear}` : ""}`
              : ""}
            · ${submitterLabel} · Revision ${proposal.current_revision}
          </p>
          ${canReview && proposal.submitter_email
            ? html`<p>${proposal.submitter_email}</p>`
            : nothing}
          ${deadline.note ? html`<p>${deadline.note}</p>` : nothing}
          ${proposal.previous_deadline_aoe
            ? html`<p>
                Deadline correction: ${proposal.previous_deadline_aoe} AoE →
                ${deadline.deadlineDate} ${deadline.deadlineTime} ${deadline.timezone}.
                Administrator approval required.
              </p>`
            : nothing}
          ${proposal.duplicate_deadline_ids.length
            ? html`<p class="deadline-proposal-row__duplicate">
                Possible duplicate of ${proposal.duplicate_deadline_ids.join(", ")}
              </p>`
            : nothing}
          <div class="deadline-proposal-row__links">
            <a href=${deadline.homepageUrl} target="_blank" rel="noopener noreferrer">Homepage</a>
            ${deadline.cfpUrl
              ? html`<a href=${deadline.cfpUrl} target="_blank" rel="noopener noreferrer">CFP</a>`
              : nothing}
            ${deadline.openReviewUrl
              ? html`<a href=${deadline.openReviewUrl} target="_blank" rel="noopener noreferrer"
                  >OpenReview</a
                >`
              : nothing}
          </div>
          ${canReview && (proposal.status === "pending" || proposal.status === "approved")
            ? html`<div class="deadline-proposal-row__actions">
                <button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${this.proposalBusy}
                  @click=${() => this.editProposal(proposal)}
                >
                  Revise
                </button>
                <button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${this.proposalBusy}
                  @click=${() => void this.decideProposal(proposal, "rejected")}
                >
                  Reject
                </button>
                <button
                  class="btn btn--sm primary"
                  type="button"
                  ?disabled=${this.proposalBusy}
                  @click=${() => void this.decideProposal(proposal, "published")}
                >
                  Approve and publish
                </button>
              </div>`
            : nothing}
        </article>
      `;
    };
    return html`
      <section
        class="deadline-proposal deadline-proposal--drawer"
        data-testid="deadline-proposal-review-panel"
      >
        <div class="deadline-proposal__heading">
          <div>
            <h2 id="deadline-proposal-drawer-title">
              ${canReview ? "Deadline proposals" : "My deadline proposals"}
            </h2>
          </div>
          <button class="btn btn--sm" type="button" @click=${this.closeProposalDrawer}>
            Close
          </button>
        </div>
        <p class="deadline-proposal__helper">
          ${canReview
            ? "Publishing records the approved payload and adds it to every deadline board."
            : "Track the review status of deadlines you have submitted."}
        </p>
        ${actionable.length
          ? html`<div class="deadline-proposal__queue">${actionable.map(renderRow)}</div>`
          : html`<p class="deadline-proposal__empty">
              ${canReview
                ? "No pending deadline proposals."
                : visibleProposals.length
                  ? "No proposals awaiting review."
                  : "You have not submitted any deadline proposals."}
            </p>`}
        ${reviewed.length
          ? html`<details class="deadline-proposal__reviewed">
              <summary>Reviewed proposals (${reviewed.length})</summary>
              <div class="deadline-proposal__queue">${reviewed.map(renderRow)}</div>
            </details>`
          : nothing}
      </section>
    `;
  }

  private renderProposalDrawer() {
    return html`
      <dialog
        class="deadline-proposal-drawer"
        data-testid="deadline-proposal-drawer"
        aria-labelledby="deadline-proposal-drawer-title"
        @close=${() => {
          this.proposalFormOpen = false;
          this.proposalReviewOpen = false;
          this.editingProposalId = "";
          this.requestUpdate();
        }}
        @click=${(event: Event) => {
          if (event.target === event.currentTarget) {
            this.closeProposalDrawer();
          }
        }}
      >
        <div class="deadline-proposal-drawer__body">
          ${this.renderProposalForm()} ${this.renderProposalReview()}
        </div>
      </dialog>
    `;
  }

  private renderHero(entry: DeadlineBoardEntry | undefined) {
    const lead = this.period === "upcoming" ? "Next" : "Most recent";
    if (!entry) {
      return html`
        <section class="deadline-board__hero" data-period=${this.period}>
          <p class="deadline-board__eyebrow">${lead} deadline</p>
          <h2 class="deadline-board__hero-name">Nothing matches this filter</h2>
        </section>
      `;
    }
    const stage = entry.stage ?? nextVenueStage(entry.venue, this.now, this.displayZone);
    const pendingStage = stage && !stage.submission ? stage : undefined;
    return html`
      <section
        class="deadline-board__hero"
        data-entry-type=${entry.venue.entry_type}
        data-archival-status=${entry.venue.archival_status}
        data-venue-priority=${entry.venue.venue_priority}
        data-change=${deadlineChangeSummary(entry.venue)?.kind ?? nothing}
        data-urgency=${urgency(entry, this.now)}
        data-period=${this.period}
      >
        <p class="deadline-board__eyebrow">
          <span>${lead} deadline</span>${wrapSeparator()}<span>${entry.venue.venue_group}</span>
        </p>
        <h2 class="deadline-action__title">
          ${stage?.label ?? capitalize(entry.venue.deadline_label || "Submission")}
        </h2>
        <p class="deadline-board__hero-name deadline-action__venue">
          ${renderDeadlineTitle(entry.venue)}
        </p>
        <div class="deadline-board__hero-meta-row">
          <div class="deadline-board__hero-meta">
            <span>${pendingStage?.label ?? capitalize(entry.venue.deadline_label)}</span
            >${wrapSeparator()}
            <span class="deadline-board__hero-date-row"
              ><time
                class="deadline-board__hero-date"
                datetime=${pendingStage?.day ?? entry.venue.deadline_aoe}
                >${pendingStage
                  ? renderDeadlineDateLabel(pendingStage.dateLabel)
                  : renderDeadlineDate(entry.venue, this.displayZone)}</time
              >
              ${this.renderHistory(entry.venue, "hero")}</span
            >
            ${renderClassification(entry.venue, "hero")}
          </div>
        </div>
        ${renderAbstractRequirement(entry.venue, this.venues, this.displayZone, this.now)}
        ${!entry.stage &&
        entry.venue.deadline_time_precision === "date_only" &&
        entry.instant <= this.now
          ? html`<p>${planningCountdownLabel(entry.venue, this.now)}</p>`
          : this.period === "upcoming"
            ? html`<div class="deadline-board__hero-clock">
                <div
                  class="deadline-board__hero-countdown"
                  aria-label=${countdownLabel(countdownTarget(entry, this.now) - this.now)}
                >
                  ${countdownLabel(countdownTarget(entry, this.now) - this.now)}
                </div>
              </div>`
            : nothing}
      </section>
    `;
  }

  private renderModes() {
    return html`
      <div class="deadline-board__modes">
        <div class="deadline-board__period" role="group" aria-label="Deadline period">
          <button
            type="button"
            aria-pressed=${String(this.period === "past")}
            data-testid="deadline-period-past"
            @click=${() => this.setPeriod("past")}
          >
            Past
          </button>
          <button
            type="button"
            aria-pressed=${String(this.period === "upcoming")}
            data-testid="deadline-period-upcoming"
            @click=${() => this.setPeriod("upcoming")}
          >
            Upcoming
          </button>
        </div>
        <div class="deadline-board__view" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed=${String(this.view === "groups")}
            @click=${() => this.setView("groups")}
          >
            Groups
          </button>
          <button
            type="button"
            aria-pressed=${String(this.view === "cards")}
            @click=${() => this.setView("cards")}
          >
            Cards
          </button>
          <button
            type="button"
            aria-pressed=${String(this.view === "table")}
            @click=${() => this.setView("table")}
          >
            Table
          </button>
        </div>
      </div>
    `;
  }

  private renderControls(
    entries: readonly DeadlineBoardEntry[],
    periodEntries: readonly DeadlineBoardEntry[],
    filters: DeadlineBoardFilters,
  ) {
    const count = <Key extends keyof DeadlineBoardFilters>(
      key: Key,
      value: DeadlineBoardFilters[Key],
    ) =>
      filterDeadlineBoardEntries(periodEntries, "", this.query, {
        ...filters,
        [key]: value,
      }).length;
    return html`
      <div class="deadline-board__controls">
        <label class="deadline-board__search">
          <span class="sr-only">Search deadlines</span>
          <input
            type="search"
            placeholder="Search conferences & workshops…"
            .value=${this.query}
            @input=${this.setQuery}
          />
        </label>
        <label class="deadline-board__facet">
          <span class="sr-only">Filter by entry type</span>
          <select
            data-testid="deadline-filter-entry-type"
            .value=${this.entryType}
            @change=${this.setEntryType}
          >
            ${[
              { value: "paper_deadlines" as const, label: "Paper deadlines (excluding workshops)" },
              ...ENTRY_TYPE_OPTIONS,
            ].map(
              (option) => html`<option value=${option.value}>
                ${option.label} (${count("entryType", option.value)})
              </option>`,
            )}
          </select>
          <span class="country-select__chevron" aria-hidden="true">${icons.chevronDown}</span>
        </label>
        <label class="deadline-board__facet">
          <span class="sr-only">Filter by archival status</span>
          <select
            data-testid="deadline-filter-archival-status"
            .value=${this.archivalStatus}
            @change=${this.setArchivalStatus}
          >
            ${[
              { value: "publication_actions" as const, label: "Archival papers & ARR submissions" },
              ...ARCHIVAL_STATUS_OPTIONS,
            ].map(
              (option) => html`<option value=${option.value}>
                ${option.label} (${count("archivalStatus", option.value)})
              </option>`,
            )}
          </select>
          <span class="country-select__chevron" aria-hidden="true">${icons.chevronDown}</span>
        </label>
        <label class="deadline-board__facet">
          <span class="sr-only">Filter by location</span>
          <select
            aria-label="Filter by location"
            data-testid="deadline-filter-location"
            .value=${this.location}
            @change=${(event: Event) => {
              this.location = (event.target as HTMLSelectElement).value;
              this.requestUpdate();
            }}
          >
            <option value="">All locations (${count("location", "")})</option>
            ${[...new Set(this.venues.flatMap(venueLocationSites))]
              .toSorted((a, b) => a.localeCompare(b))
              .map(
                (site) => html`<option value=${site}>${site} (${count("location", site)})</option>`,
              )}
            <option value="unknown">Location unknown (${count("location", "unknown")})</option>
          </select>
          <span class="country-select__chevron" aria-hidden="true">${icons.chevronDown}</span>
        </label>

        ${renderStageFilter(
          this.stageFilter,
          stageFilterOptions(
            this.venues.flatMap((venue) => venueStages(venue, this.displayZone, this.venues)),
          ),
          (stage) => {
            this.stageFilter = stage;
            this.requestUpdate();
          },
          (stage) =>
            filterDeadlineBoardEntries(
              entriesForDeadlinePeriod(
                buildDeadlineBoardEntries(this.venues),
                this.now,
                this.period,
                stage,
                this.displayZone,
                this.venues,
              ),
              "",
              this.query,
              filters,
            ).length,
        )}
        ${renderDeadlineTimezone(this.displayZone, (zone) => {
          this.displayZone = zone;
          saveDeadlineTimezone(zone);
          this.requestUpdate();
        })}
        <div class="deadline-board__groups" role="group" aria-label="Filter by venue">
          <button
            type="button"
            aria-pressed=${String(!this.activeGroup)}
            data-testid="deadline-group-all"
            @click=${() => this.selectGroup("")}
          >
            All <span>${entries.length}</span>
          </button>
          ${groupOptions(entries).map(
            (group) => html`
              <button
                type="button"
                aria-pressed=${String(this.activeGroup === group.id)}
                data-testid=${`deadline-group-${group.id}`}
                @click=${() => this.selectGroup(group.id)}
              >
                ${group.label} <span>${group.count}</span>
              </button>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderStageHistory(
    venue: DeadlineVenue,
    stage: DeadlineMilestone & { abstractVenue?: DeadlineVenue },
    placement: string,
  ): TemplateResult | typeof nothing {
    if (stage.abstractVenue) {
      return this.renderHistory(stage.abstractVenue, `${placement}-abstract`, true);
    }
    if (
      stage.milestone === "submission" &&
      stage.date ===
        (venue.deadline_time_precision === "date_only" ? venue.deadline_date : venue.deadline_aoe)
    ) {
      return this.renderHistory(venue, `${placement}-submission`, true);
    }
    if (stage.milestone === "notification_by") {
      return nothing;
    }
    return renderStageDetails({
      venue,
      stage,
      placement,
      dateLabel: milestoneDateLabel(stage, this.displayZone),
      canCorrect: Boolean(this.memberId && this.accessRole !== "anonymous"),
      correct: () => {
        this.openProposalForm();
        this.correctionTarget = venue;
        this.correctionStage = stage;
        this.correctionContext = venue;
        this.correctionChoice = String(
          venueSchedule(venue, { venues: this.venues })
            .filter((row) => row.kind !== "period" && row.milestone !== "notification_by")
            .findIndex((row) => row.milestone === stage.milestone && row.label === stage.label),
        );
        this.requestUpdate();
      },
    });
  }

  private renderHistory(
    venue: DeadlineVenue,
    placement: string,
    primary = false,
  ): TemplateResult | typeof nothing {
    const selected =
      this.selectedStage(venue) ??
      (venue.venue_type === "workshop" && this.period === "upcoming"
        ? nextVenueStage(venue, this.now, this.displayZone)
        : undefined);
    if (!primary && selected?.milestone && !selected.submission) {
      return this.renderStageHistory(venue, selected.milestone, placement);
    }
    const previous = priorDeadlineRevisions(venue);
    const change = deadlineChangeSummary(venue);
    const extended = venue.deadline_extended || change?.kind === "extended";
    const historyId = `deadline-history-${placement}-${venue.id.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
    const anchorName = `--${historyId}`;
    return html`<span
      class="deadline-card__note deadline-card__history"
      data-change=${extended ? "extended" : (change?.kind ?? "history")}
    >
      <button
        type="button"
        class="btn btn--icon deadline-card__history-trigger"
        popovertarget=${historyId}
        aria-haspopup="dialog"
        aria-label=${`Deadline details: ${venue.name} ${venue.deadline_label}`}
        data-tooltip="Deadline details"
        style=${`anchor-name: ${anchorName}`}
      >
        ${icons.moreHorizontal}
      </button>
      <div
        id=${historyId}
        class="deadline-card__history-panel"
        popover="auto"
        role="dialog"
        aria-label=${`Deadline details for ${venue.name}`}
        style=${`position-anchor: ${anchorName}`}
      >
        <header class="deadline-details__header">
          <strong>${venue.name}</strong>
          <p>${capitalize(venue.deadline_label)}</p>

          ${venue.deadline_time_precision === "date_only"
            ? html`<p>
                Plan before
                ${zonedDeadlineLabel(
                  deadlineInstantMs(venue),
                  displayTimezone(
                    this.displayZone,
                    venue.deadline_timezone || "Pacific/Kiritimati",
                  ),
                )}.
                This is the start of the published
                day${venue.deadline_timezone
                  ? ` in ${venue.deadline_timezone}`
                  : " in UTC+14, the earliest possible timezone"};
                the source does not specify a closing time.
              </p>`
            : nothing}
        </header>

        <dl class="deadline-details__facts">
          <dt>Location</dt>
          <dd>
            ${venueLocationSites(venue).length ? renderVenueLocation(venue) : "Not published"}
          </dd>
          <dt>Source date</dt>
          <dd>${deadlineDisplayLabel(venue, "original", true)}</dd>
          ${venue.source_checked_at
            ? html`<dt>Last checked</dt>
                <dd>
                  <time datetime=${venue.source_checked_at}
                    >${plainDateLabel(venue.source_checked_at)}</time
                  >
                </dd>`
            : nothing}
        </dl>
        ${previous.length || extended
          ? html`<section class="deadline-details__history">
              <strong>Date changes</strong>
              ${previous.length
                ? html`<ul>
                    ${previous.map(
                      (revision) => html`<li>
                        ${renderDeadlineDate(revision, this.displayZone)} ·
                        ${capitalize(revision.deadline_label || "deadline")} · recorded
                        ${revision.observed_at.slice(0, 10)}
                        ${revision.link
                          ? html` ·
                              <a href=${revision.link} target="_blank" rel="noopener noreferrer"
                                >source ↗</a
                              >`
                          : nothing}
                      </li>`,
                    )}
                  </ul>`
                : html`<p>
                    ${extended
                      ? "The source marks this deadline as extended, but does not publish the earlier date."
                      : "No earlier dates recorded."}
                  </p>`}
            </section>`
          : nothing}
        <footer class="deadline-details__footer">
          ${this.memberId && this.accessRole !== "anonymous"
            ? html`<button
                class="btn btn--sm"
                type="button"
                aria-label=${`Suggest correction: ${venue.name} ${venue.deadline_label}`}
                data-tooltip="Suggest a deadline correction"
                title="Suggest a deadline correction"
                @click=${(event: Event) => {
                  (event.currentTarget as HTMLElement)
                    .closest<HTMLElement>("[popover]")
                    ?.hidePopover?.();
                  this.openProposalForm();
                  this.correctionTarget = venue;
                  this.requestUpdate();
                }}
              >
                Suggest deadline correction
              </button>`
            : nothing}
          ${this.renderSourceActions(venue, { timeline: false })}
        </footer>
      </div>
    </span>`;
  }

  private renderScheduleToggle(venue: DeadlineVenue, label?: string) {
    const open = this.expandedSchedules.has(venue.id);
    return html`<button
      type="button"
      class="deadline-schedule-toggle"
      aria-label=${`Schedule for ${venue.name}`}
      aria-expanded=${String(open)}
      @click=${() => {
        if (open) {
          this.expandedSchedules.delete(venue.id);
        } else {
          this.expandedSchedules.add(venue.id);
        }
        this.requestUpdate();
      }}
    >
      ${label ? html`<span class="deadline-card__stage">${label}</span>` : nothing}<span
        aria-hidden="true"
        >${icons.chevronDown}</span
      >
    </button>`;
  }

  private renderSchedule(venue: DeadlineVenue, label: string) {
    const entries = venueSchedule(venue, { includeSubmission: true, venues: this.venues }).filter(
      (entry) => entry.milestone !== "notification_by",
    );
    // One entry means the submission alone, which the card already shows above. A disclosure
    // whose only content repeats the headline is a control that costs a click to learn nothing.
    const abstractStatus = entries.some((entry) => entry.milestone === "abstract")
      ? undefined
      : abstractRequirementStatus(venue);
    const count = entries.length + (abstractStatus ? 1 : 0);
    if (!count || (count === 1 && !abstractStatus && entries[0]?.milestone === "submission")) {
      return nothing;
    }
    const unknownAbstract = abstractStatus
      ? html`<li class="deadline-card__milestone" data-milestone="abstract">
          <span class="deadline-card__milestone-label">Abstract</span>
          <span class="deadline-card__milestone-date">${abstractStatus}</span>
        </li>`
      : nothing;
    const rows = entries.map(
      (entry) => html`<li
        class="deadline-card__milestone"
        data-milestone=${entry.milestone}
        data-next=${String(
          (this.selectedStage(venue) ?? nextVenueStage(venue, this.now))?.instant ===
            milestoneEndInstant(entry),
        )}
      >
        <span class="deadline-card__milestone-label">${capitalize(entry.label)}</span>
        <span class="deadline-stage-date"
          ><span class="deadline-card__milestone-date"
            >${renderDeadlineDateLabel(
              entry.abstractVenue
                ? renderAbstractMilestoneDate(entry.abstractVenue, this.displayZone, this.now)
                : milestoneDateLabel(entry, this.displayZone),
            )}</span
          >${this.renderStageHistory(venue, entry, "schedule")}</span
        >
      </li>`,
    );
    const open = this.expandedSchedules.has(venue.id);
    return html`<div class="deadline-card__schedule-details" data-testid="deadline-schedule">
      ${this.renderScheduleToggle(venue, label)}
      ${open
        ? html`<ul class="deadline-card__schedule">
            ${unknownAbstract}${rows}
          </ul>`
        : nothing}
    </div>`;
  }

  private renderStale(venue: DeadlineVenue) {
    const status = venue.deadline_source_status || "";
    const note =
      venue.stale || status === "source_unavailable"
        ? "Source not observed in the latest sweep."
        : status.includes("disagree") || status.includes("conflict")
          ? "Sources disagree. Showing the matched OpenReview deadline."
          : status === "portal_unverified" || status === "openreview_final_submission"
            ? "Announced date; the matching submission portal cutoff has not been verified."
            : status === "administrator_approved"
              ? "Date corrected after administrator review."
              : "";
    return html`${renderWorkshopNotificationNotes(venue)}${note
      ? html`<p class="deadline-card__note">${note}</p>`
      : nothing}`;
  }

  private renderCard(entry: DeadlineBoardEntry) {
    const { venue } = entry;
    const stage =
      entry.stage ??
      (venue.venue_type === "workshop" &&
      this.period === "upcoming" &&
      Number.isFinite(entry.instant)
        ? nextVenueStage(venue, this.now, this.displayZone)
        : undefined);
    const displayedInstant = stage?.instant ?? entry.instant;
    const stageLabel = stage?.label ?? capitalize(venue.deadline_label || "Submission");
    const schedule = this.renderSchedule(venue, stageLabel);
    return html`
      <article
        class="deadline-card"
        data-entry-type=${venue.entry_type}
        data-archival-status=${venue.archival_status}
        data-venue-priority=${venue.venue_priority}
        data-urgency=${!Number.isFinite(displayedInstant)
          ? "unknown"
          : displayedInstant <= this.now
            ? "passed"
            : urgencyOf(displayedInstant, this.now)}
        data-period=${this.period}
      >
        <div class="deadline-card__topline">
          <span class="deadline-card__type">${ENTRY_TYPE_LABELS[venue.entry_type]}</span>
          ${Number.isFinite(displayedInstant)
            ? html`<span class="deadline-card__urgency"
                >${daysLeftLabel(displayedInstant, this.now)}</span
              >`
            : nothing}
        </div>
        <h2 class="deadline-action__title">${stageLabel}</h2>
        <p class="deadline-card__name deadline-action__venue">${renderDeadlineTitle(venue)}</p>
        ${venue.name !== workshopGroupLabel(venue.venue_group)
          ? html`<p class="deadline-card__group" title=${workshopGroupLabel(venue.venue_group)}>
              <span class="deadline-card__group-name"
                >${workshopGroupLabel(venue.venue_group)}</span
              >
            </p>`
          : nothing}
        <div class="deadline-card__context">${renderClassification(venue)}</div>
        <span class="deadline-card__date-row">
          <time class="deadline-card__date" datetime=${stage?.day ?? venue.deadline_aoe}>
            ${stage && !stage.submission
              ? renderDeadlineDateLabel(stage.dateLabel)
              : renderDeadlineDate(venue, this.displayZone)}
          </time>
          ${this.renderHistory(venue, "card")}
        </span>
        ${Number.isFinite(displayedInstant)
          ? html`<p class="deadline-card__countdown">
              ${stage && !stage.submission
                ? stage.instant <= this.now
                  ? "passed"
                  : countdownLabel(stage.instant - this.now)
                : venue.deadline_time_precision === "date_only"
                  ? planningCountdownLabel(venue, this.now)
                  : displayedInstant <= this.now
                    ? "passed"
                    : countdownLabel(displayedInstant - this.now)}
            </p>`
          : nothing}
        ${renderAbstractRequirement(venue, this.venues, this.displayZone, this.now)}
        ${schedule === nothing
          ? html`<div class="deadline-card__schedule-details">
              <span class="deadline-card__stage">${stageLabel}</span>
            </div>`
          : schedule}
        ${this.renderStale(venue)} ${this.renderSourceActions(venue)}
      </article>
    `;
  }

  private timelineVenue(venue: DeadlineVenue): DeadlineVenue {
    if (venue.deadline_id.includes(":stage:")) {
      return venue;
    }
    const stage = this.selectedStage(venue);
    if (!stage || stage.submission) {
      return venue;
    }
    const aoe = new Date(stage.instant - 12 * 3600000).toISOString().replace("T", " ").slice(0, 19);
    return {
      ...venue,
      deadline_id: `${venue.deadline_id}:stage:${stage.key}:${stage.day}`,
      name: `${venue.name} — ${stage.label}`,
      deadline_label: stage.label,
      deadline_aoe: aoe,
      deadline_at: new Date(stage.instant).toISOString(),
      deadline_planning_at: new Date(stage.instant).toISOString(),
      deadline_time_precision: "exact",
    };
  }

  private async addToTimeline(sourceVenue: DeadlineVenue): Promise<void> {
    const selected = this.selectedStage(sourceVenue);
    const venue = this.timelineVenue(sourceVenue);
    const milestones = this.timelineMilestones;
    if (
      !Number.isFinite(deadlineInstantMs(venue)) ||
      deadlineInstantMs(venue) <= this.now ||
      !milestones ||
      !this.onSaveTimeline ||
      this.timelineBusyId
    ) {
      return;
    }
    this.timelineBusyId = venue.deadline_id;
    this.timelineFailedId = "";
    this.requestUpdate();
    try {
      const milestone = selected?.milestone;
      const plainDate =
        milestone &&
        !/[ T]\d{2}:\d{2}/u.test(milestone.ends || milestone.date || milestone.starts || "");
      const row = plainDate
        ? {
            deadline_id: venue.deadline_id,
            label: venue.name,
            date: (milestone.ends || milestone.date || milestone.starts || "").slice(0, 10),
            ...(sourceVenue.link ? { link: sourceVenue.link } : {}),
          }
        : deadlineMilestoneRow(venue);
      const saved = await this.onSaveTimeline([...milestones, row]);
      if (!saved) {
        this.timelineFailedId = venue.deadline_id;
      }
    } catch {
      this.timelineFailedId = venue.deadline_id;
    } finally {
      this.timelineBusyId = "";
      this.requestUpdate();
    }
  }

  /**
   * "Add to my timeline": copies this deadline onto the signed-in member's own milestones, the list
   * Time Availability plans around.
   *
   * Offered only once the member's own milestone list has loaded. A save writes the whole list, so
   * a button that could be pressed before the list arrived would replace every milestone the member
   * already had with this one. Past deadlines get no button: there is nothing left to plan back from.
   */
  private renderTimelineAction(sourceVenue: DeadlineVenue) {
    const venue = this.timelineVenue(sourceVenue);
    const milestones = this.timelineMilestones;
    if (
      !Number.isFinite(deadlineInstantMs(venue)) ||
      deadlineInstantMs(venue) <= this.now ||
      !milestones ||
      !this.onSaveTimeline ||
      !this.memberId ||
      this.accessRole === "anonymous" ||
      this.period === "past"
    ) {
      return nothing;
    }
    if (hasDeadlineMilestone(milestones, venue)) {
      return html`<span
        class="deadline-card__timeline-status"
        role="status"
        data-testid="deadline-on-timeline"
        data-tooltip="On your timeline"
        ><span aria-hidden="true">${icons.check}</span
        ><span class="sr-only">On your timeline</span></span
      >`;
    }
    const busy = this.timelineBusyId === venue.deadline_id;
    return html`<button
        type="button"
        class="btn primary deadline-card__timeline-button"
        title=${busy ? "Adding to my timeline…" : "Add to my timeline"}
        data-testid="deadline-add-to-timeline"
        aria-busy=${busy}
        aria-label=${`Add to my timeline: ${venue.name} ${venue.deadline_label}`}
        ?disabled=${Boolean(this.timelineBusyId)}
        @click=${() => void this.addToTimeline(sourceVenue)}
      >
        <span aria-hidden="true">${icons.clockPlus}</span>
        <span>${busy ? "Adding…" : "Add to my timeline"}</span>
      </button>
      ${this.timelineFailedId === venue.deadline_id
        ? html`<span class="deadline-card__timeline-error" role="alert"
            >Couldn't add it. Try again.</span
          >`
        : nothing}`;
  }

  private renderSourceActions(venue: DeadlineVenue, options: { timeline?: boolean } = {}) {
    if (!this.memberId || this.accessRole === "anonymous") {
      return this.renderSourceLinks(venue, options);
    }
    const recommendation = html`<deadline-recommendation
      .deadlineId=${venue.deadline_id}
      .venueName=${venue.name}
      .memberId=${this.memberId}
      .directory=${this.recommendationDirectory}
      .store=${this.recommendationStore}
      @recommendation-sent=${() => this.loadRecommendations()}
    ></deadline-recommendation>`;
    const sources = this.renderSourceLinks(venue, options);
    return options.timeline === false
      ? html`<span class="deadline-recommendation-details">${recommendation}</span>${sources}`
      : html`<span class="deadline-recommendation-actions">${recommendation}${sources}</span>`;
  }

  private renderSourceLinks(venue: DeadlineVenue, options: { timeline?: boolean } = {}) {
    const timeline = options.timeline === false ? nothing : this.renderTimelineAction(venue);
    const workshop = workshopSourceLinks(venue);
    if (!workshop) {
      return venue.link || timeline !== nothing
        ? html`<span class="deadline-card__actions">
            ${timeline !== nothing
              ? html`<span class="deadline-card__personal-actions">${timeline}</span>`
              : nothing}
            ${venue.link
              ? html`<a
                  class="deadline-card__source deadline-card__source--button"
                  href=${venue.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label=${`Website for ${venue.name}`}
                  >Website ↗</a
                >`
              : nothing}
          </span>`
        : nothing;
    }
    return html`<span class="deadline-card__actions">
      ${timeline !== nothing
        ? html`<span class="deadline-card__personal-actions">${timeline}</span>`
        : nothing}
      ${workshop.openReviewUrl
        ? html`<a
            class="deadline-card__source deadline-card__source--button"
            href=${workshop.openReviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${`OpenReview for ${venue.name}`}
            >OpenReview ↗</a
          >`
        : nothing}
      ${workshop.sourceUrl
        ? html`<a
            class="deadline-card__source deadline-card__source--button"
            href=${workshop.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${`${workshop.sourceLabel} for ${venue.name}`}
            >${workshop.sourceLabel} ↗</a
          >`
        : html`<span class="deadline-card__missing">CFP not found yet</span>`}
    </span>`;
  }

  private renderTable(entries: readonly DeadlineBoardEntry[]) {
    return html`
      <div class="deadline-table-wrap">
        <table class="deadline-table">
          <thead>
            <tr>
              <th>Countdown</th>
              <th>Deadline</th>
              <th>Stage</th>
              <th>Item</th>
              <th>Type</th>
              <th>Venue</th>
              <th><span class="sr-only">Source and history</span></th>
            </tr>
          </thead>
          <tbody>
            ${entries.map((entry) => {
              const stage =
                entry.stage ??
                (entry.venue.venue_type === "workshop" &&
                this.period === "upcoming" &&
                Number.isFinite(entry.instant)
                  ? nextVenueStage(entry.venue, this.now, this.displayZone)
                  : undefined);
              const displayedInstant = stage?.instant ?? entry.instant;
              const schedule = venueSchedule(entry.venue, {
                includeSubmission: true,
                venues: this.venues,
              }).filter((item) => item.milestone !== "notification_by");
              const scheduleOpen = this.expandedSchedules.has(entry.venue.id);
              const parentUrgency = !Number.isFinite(displayedInstant)
                ? "unknown"
                : displayedInstant <= this.now
                  ? "passed"
                  : urgencyOf(displayedInstant, this.now);
              return html`
                <tr
                  data-entry-type=${entry.venue.entry_type}
                  data-archival-status=${entry.venue.archival_status}
                  data-venue-priority=${entry.venue.venue_priority}
                  data-urgency=${!Number.isFinite(displayedInstant)
                    ? "unknown"
                    : displayedInstant <= this.now
                      ? "passed"
                      : urgencyOf(displayedInstant, this.now)}
                  data-period=${this.period}
                >
                  <td class="deadline-table__countdown">
                    ${!Number.isFinite(displayedInstant)
                      ? nothing
                      : stage && !stage.submission
                        ? stage.instant <= this.now
                          ? "passed"
                          : countdownLabel(stage.instant - this.now)
                        : entry.venue.deadline_time_precision === "date_only"
                          ? planningCountdownLabel(entry.venue, this.now)
                          : displayedInstant <= this.now
                            ? "passed"
                            : countdownLabel(displayedInstant - this.now)}
                  </td>
                  <td class="deadline-table__date">
                    <span class="deadline-table__date-row">
                      ${stage && !stage.submission
                        ? renderDeadlineDateLabel(stage.dateLabel)
                        : renderDeadlineDate(entry.venue, this.displayZone)}
                      ${this.renderHistory(entry.venue, "table")}
                    </span>
                  </td>
                  <td class="deadline-table__stage">
                    <span class="deadline-table__stage-content"
                      >${stage?.label ??
                      capitaliseFirst(
                        entry.venue.deadline_label || "Submission",
                      )}${schedule.length > 1
                        ? this.renderScheduleToggle(entry.venue)
                        : nothing}</span
                    >
                  </td>
                  <td class="deadline-table__name">
                    ${renderDeadlineTitle(entry.venue)}
                    ${renderAbstractRequirement(
                      entry.venue,
                      this.venues,
                      this.displayZone,
                      this.now,
                    )}
                  </td>
                  <td>
                    <span class="deadline-card__labels">
                      <span class="deadline-card__type"
                        >${ENTRY_TYPE_LABELS[entry.venue.entry_type]}</span
                      >
                      ${renderClassification(entry.venue, "table")}
                    </span>
                  </td>
                  <td class="deadline-table__venue">${entry.venue.venue_group}</td>
                  <td>
                    ${entry.venue.stale
                      ? html`<span
                          class="deadline-table__stale"
                          title="Source not observed in the latest sweep."
                          >stale</span
                        >`
                      : nothing}
                    ${this.renderStale(entry.venue)} ${this.renderSourceActions(entry.venue)}
                  </td>
                </tr>
                ${scheduleOpen && schedule.length > 1
                  ? schedule.map(
                      (milestone) => html` <tr
                        class="deadline-table__schedule-row"
                        data-urgency=${parentUrgency}
                        data-next=${String(
                          (entry.stage ?? nextVenueStage(entry.venue, this.now))?.instant ===
                            milestoneEndInstant(milestone),
                        )}
                      >
                        <td aria-hidden="true"></td>
                        <td>
                          <span class="deadline-stage-date"
                            >${milestoneDateLabel(
                              milestone,
                              this.displayZone,
                            )}${this.renderStageHistory(
                              entry.venue,
                              milestone,
                              "table-schedule",
                            )}</span
                          >
                        </td>
                        <td>${milestone.label}</td>
                        <td colspan="4"></td>
                      </tr>`,
                    )
                  : nothing}
              `;
            })}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderGroupRow(
    entry: DeadlineBoardEntry,
    conference: string,
    groupKind: DeadlineBoardGroup["kind"] = "workshops",
  ) {
    const { venue } = entry;
    const baseTitle = groupRowTitle(venue, conference, groupKind);
    const title =
      entry.stage && venue.venue_type !== "workshop"
        ? {
            name: entry.stage.label,
            stage: [baseTitle.name === entry.stage.label ? "" : baseTitle.name, baseTitle.stage]
              .filter(Boolean)
              .join(" · "),
          }
        : baseTitle;
    const change = deadlineChangeSummary(venue);
    const workshop = venue.venue_type === "workshop";
    const stage =
      entry.stage ??
      (workshop && this.period === "upcoming" && Number.isFinite(entry.instant)
        ? nextVenueStage(venue, this.now, this.displayZone)
        : undefined);
    const displayedInstant = stage?.instant ?? entry.instant;
    const schedule =
      workshop || entry.stage
        ? venueSchedule(venue, { includeSubmission: true, venues: this.venues }).filter(
            (item) => item.milestone !== "notification_by",
          )
        : [];
    const scheduleOpen = this.expandedSchedules.has(venue.id);
    const note = [
      workshop ? "" : title.stage,
      venue.stale ? "Source not observed in the latest sweep" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return html`
      <div
        class="deadline-group__row"
        data-entry-type=${venue.entry_type}
        data-archival-status=${venue.archival_status}
        data-venue-priority=${venue.venue_priority}
        data-change=${change?.kind ?? nothing}
        data-urgency=${!Number.isFinite(displayedInstant)
          ? "unknown"
          : displayedInstant <= this.now
            ? "passed"
            : urgencyOf(displayedInstant, this.now)}
        data-period=${this.period}
      >
        <span class="deadline-group__row-countdown">
          ${stage && !stage.submission
            ? stage.instant <= this.now
              ? "passed"
              : countdownLabel(stage.instant - this.now)
            : venue.deadline_time_precision === "date_only"
              ? planningCountdownLabel(venue, this.now)
              : entry.instant <= this.now
                ? "passed"
                : countdownLabel(entry.instant - this.now)}
        </span>
        <span class="deadline-group__row-date-wrap">
          <span class="deadline-group__date-line"
            ><time class="deadline-group__row-date" datetime=${stage?.day ?? venue.deadline_aoe}>
              ${stage && !stage.submission
                ? renderDeadlineDateLabel(stage.dateLabel)
                : renderDeadlineDate(venue, this.displayZone)}
            </time>
            ${this.renderHistory(venue, "group")}</span
          >
          ${workshop
            ? html`<span class="deadline-group__date-stage"
                ><span
                  >${stage?.label ?? capitaliseFirst(venue.deadline_label || "Submission")}</span
                >
                ${schedule.length > 1 ? this.renderScheduleToggle(venue) : nothing}
              </span>`
            : nothing}
        </span>
        <div class="deadline-group__row-main">
          <h3 class="deadline-group__row-name" title=${venue.name}>
            ${renderDeadlineTitle(venue, stage?.label ?? title.name)}
          </h3>
          <p class="deadline-group__row-note">
            <span class="deadline-action__venue">${renderDeadlineTitle(venue)}</span>
            ${note ? html`<span class="deadline-group__row-detail">${note}</span>` : nothing}
            <span class="deadline-card__labels">
              <span class="deadline-card__type">${ENTRY_TYPE_LABELS[venue.entry_type]}</span>

              ${renderClassification(venue, "group")}
            </span>
          </p>
          ${renderAbstractRequirement(venue, this.venues, this.displayZone, this.now)}
          ${this.renderStale(venue)}
        </div>
        ${this.renderSourceActions(venue)}
      </div>
      ${scheduleOpen
        ? html`<div
            class="deadline-workshop-schedule"
            data-urgency=${!Number.isFinite(displayedInstant)
              ? "unknown"
              : displayedInstant <= this.now
                ? "passed"
                : urgencyOf(displayedInstant, this.now)}
            aria-label=${`${venue.name} schedule`}
          >
            ${schedule.map((milestone) =>
              this.renderTimelineMilestone({
                kind: "milestone",
                day: milestoneStart(milestone),
                rank: 0,
                label: milestone.label,
                milestone,
                venue,
              }),
            )}
          </div>`
        : nothing}
    `;
  }

  private renderGroupSection(
    label: string,
    entries: readonly DeadlineBoardEntry[],
    conference: string,
  ) {
    if (!entries.length) {
      return nothing;
    }
    return html`
      <section class="deadline-group__section">
        <p class="deadline-group__section-head">
          <strong>${label}</strong><span>${entries.length}</span>
        </p>
        ${entries.map((entry) => this.renderGroupRow(entry, conference, "workshops"))}
      </section>
    `;
  }

  /** Supporting schedule details emphasize the next stage without repeating its countdown. */
  private renderTimelineMilestone(item: Extract<DeadlineTimelineItem, { kind: "milestone" }>) {
    const instant = milestoneEndInstant(item.milestone);
    const next = nextVenueStage(item.venue, this.now, this.displayZone);
    const stageState = instant <= this.now ? "past" : next?.instant === instant ? "next" : "future";
    return html`
      <div
        class="deadline-group__row deadline-group__row--milestone"
        data-milestone=${item.milestone.milestone}
        data-stage-state=${stageState}
        data-urgency=${!Number.isFinite(instant)
          ? "unknown"
          : instant <= this.now
            ? "passed"
            : urgencyOf(instant, this.now)}
      >
        <span class="deadline-group__row-countdown" aria-hidden="true"></span>
        <span class="deadline-group__row-date-wrap">
          <span class="deadline-group__row-date"
            >${item.milestone.abstractVenue
              ? renderAbstractMilestoneDate(
                  item.milestone.abstractVenue,
                  this.displayZone,
                  this.now,
                )
              : milestoneDateLabel(item.milestone, this.displayZone)}</span
          >${this.renderStageHistory(item.venue, item.milestone, "timeline")}
        </span>
        <div class="deadline-group__row-main">
          <p class="deadline-group__row-name">${item.label}</p>
        </div>
      </div>
    `;
  }

  /** The conference's whole calendar, submissions and published stages in one order. */
  private renderConferenceTimeline(group: DeadlineBoardGroup) {
    return html`
      <section class="deadline-group__section" data-testid="deadline-conference-timeline">
        ${group.timeline.map((item) =>
          item.kind === "entry"
            ? this.renderGroupRow(item.entry, group.label, "conference")
            : this.renderTimelineMilestone(item),
        )}
      </section>
    `;
  }

  private renderGroups(entries: readonly DeadlineBoardEntry[]) {
    return html`<div class="deadline-board__group-list">
      ${groupDeadlineBoardEntries(entries, this.venues).map((group, index) => {
        // A card, not a group: no disclosure triangle, no section headings, nothing to expand.
        // Rendered through the same row renderer the panel uses so the two cannot drift apart.
        const solo = group.entries[0];
        if (group.kind === "workshops" && group.standalone && solo) {
          return html`<section
            class="deadline-group deadline-group--standalone"
            data-count="1"
            data-standalone="true"
            data-urgency=${urgency(solo, this.now)}
            data-period=${this.period}
          >
            <!-- Full venue name, not the stage: a standalone row carries no group heading
                 above it, so it is the only place the venue gets named. -->
            ${this.renderGroupRow(solo, group.label, "workshops")}
          </section>`;
        }
        const attendance =
          this.accessRole === "admin" && group.kind === "conference"
            ? conferenceRosterFor(
                group.entries.map((entry) => entry.venue),
                this.conferenceRosters,
              )
            : undefined;
        const open = this.expandedGroups.has(group.id);
        const panelId = `deadline-group-panel-${index}`;
        // A conference counts its own calendar. Splitting one venue's rows by archival status
        // would say the same thing on every line, where "2 deadlines · 4 more dates" tells the
        // reader what is behind the triangle before they open it.
        const laterDates = group.timeline.length - group.entries.length;
        // The collapsed row summarises the soonest thing the group is waiting on. Entries arrive
        // ordered by that stage, so the lead entry carries it -- and for a conference the lab has
        // already submitted to, the stage is its notification or the conference itself rather
        // than the deadline it closed weeks ago.
        const leadStage =
          group.entries[0].stage ??
          (Number.isFinite(group.entries[0].instant)
            ? nextVenueStage(group.entries[0].venue, this.now, this.displayZone)
            : undefined);
        const leadPending = leadStage && !leadStage.submission ? leadStage : undefined;
        const notificationPolicy =
          group.kind === "workshops"
            ? sharedWorkshopNotificationPolicy(group.entries.map((entry) => entry.venue))
            : undefined;
        const counts =
          group.kind === "conference"
            ? [
                `${group.entries.length} deadline${group.entries.length === 1 ? "" : "s"}`,
                laterDates > 0 ? `${laterDates} more date${laterDates === 1 ? "" : "s"}` : "",
              ].filter(Boolean)
            : [
                group.sections.archival.length ? `${group.sections.archival.length} archival` : "",
                group.sections.nonArchival.length
                  ? `${group.sections.nonArchival.length} non-archival`
                  : "",
                group.sections.mixed.length
                  ? `${group.sections.mixed.length} archival + non-archival`
                  : "",
                group.sections.unknown.length ? `${group.sections.unknown.length} unknown` : "",
                group.sections.other.length ? `${group.sections.other.length} other` : "",
              ].filter(Boolean);
        return html`
          <section
            class="deadline-group"
            data-group-kind=${group.kind}
            data-count=${group.entries.length}
            data-urgency=${urgency(group.entries[0], this.now)}
            data-period=${this.period}
            ?data-open=${open}
          >
            <button
              type="button"
              class="deadline-group__summary"
              aria-expanded=${String(open)}
              aria-controls=${panelId}
              @click=${() => this.toggleGroup(group.id)}
            >
              <span class="deadline-group__chevron" aria-hidden="true">${icons.chevronRight}</span>
              <span class="deadline-group__summary-countdown"
                >${!group.entries[0].stage &&
                group.entries[0].venue.deadline_time_precision === "date_only"
                  ? planningCountdownLabel(group.entries[0].venue, this.now)
                  : this.period === "past"
                    ? "passed"
                    : countdownLabel(
                        (leadStage?.instant ?? group.entries[0].instant) - this.now,
                      )}</span
              >
              <span class="deadline-group__heading">
                <strong
                  class=${group.kind === "conference" || leadPending
                    ? "deadline-group__next-stage"
                    : nothing}
                  >${leadStage?.label ??
                  capitalize(group.entries[0].venue.deadline_label || "Submission")}</strong
                >
                <span aria-hidden="true">|</span>
                <span class="deadline-action__venue">${group.label}</span>
                <span aria-hidden="true">|</span>
                <span class="deadline-group__summary-date">
                  ${leadPending
                    ? renderDeadlineDateLabel(leadPending.dateLabel)
                    : renderDeadlineDate(group.entries[0].venue, this.displayZone)}
                </span>
              </span>
              <span class="deadline-group__count"
                >${counts.map(
                  (count, index) => html`${index ? wrapSeparator() : nothing}<span>${count}</span>`,
                )}</span
              >
            </button>
            ${attendance ? renderConferenceAttendance(attendance) : nothing}
            <div class="deadline-group__panel" id=${panelId} ?hidden=${!open}>
              ${notificationPolicy
                ? html`<p class="deadline-group__shared-policy">
                    Organizers must notify authors by
                    ${milestoneDateLabel(notificationPolicy, this.displayZone)}
                    ${notificationPolicy.status === "source_unavailable"
                      ? html`<span>Latest source check failed</span>`
                      : notificationPolicy.status === "unverified" || !notificationPolicy.evidence
                        ? html`<span>Source not verified</span>`
                        : nothing}
                  </p>`
                : nothing}
              ${group.kind === "conference"
                ? this.renderConferenceTimeline(group)
                : html`
                    ${this.renderGroupSection("Archival", group.sections.archival, group.label)}
                    ${this.renderGroupSection(
                      "Non-archival",
                      group.sections.nonArchival,
                      group.label,
                    )}
                    ${this.renderGroupSection(
                      "Archival + non-archival",
                      group.sections.mixed,
                      group.label,
                    )}
                    ${this.renderGroupSection(
                      "Archival status unknown",
                      group.sections.unknown,
                      group.label,
                    )}
                    ${this.renderGroupSection("Other dates", group.sections.other, group.label)}
                  `}
            </div>
          </section>
        `;
      })}
    </div>`;
  }

  protected override render() {
    const canPropose = Boolean(this.memberId) && this.accessRole !== "anonymous";
    const canReview = canPropose && this.accessRole === "admin";
    if (!this.venues.length && (this.datasetLoading || this.datasetFailure)) {
      return html`<section class="deadline-board">
        <h1>${t("tabs.adminbotDeadlines")}</h1>
        ${this.datasetFailure
          ? html`<div class="callout danger" role="alert">${this.datasetFailure}</div>
              <button
                class="btn"
                ?disabled=${this.datasetLoading}
                @click=${() => this.loadPublishedDeadlines()}
              >
                Retry
              </button>`
          : html`<p role="status">Loading live deadlines…</p>`}
      </section>`;
    }
    const all = buildDeadlineBoardEntries(this.venues);
    const periodEntries = entriesForDeadlinePeriod(
      all,
      this.now,
      this.period,
      this.stageFilter,
      this.displayZone,
      this.venues,
    );
    const filters: DeadlineBoardFilters = {
      entryType: this.entryType,
      archivalStatus: this.archivalStatus,
      location: this.location,
    };
    const matching = filterDeadlineBoardEntries(periodEntries, "", this.query, filters);
    if (
      this.activeGroup &&
      !matching.some((entry) => entry.venue.venue_group === this.activeGroup)
    ) {
      this.activeGroup = "";
    }
    const filtered = filterDeadlineBoardEntries(matching, this.activeGroup, "", filters);
    this.recommendationIds = [
      ...new Set(filtered.map((entry) => entry.venue.deadline_id || entry.venue.id)),
    ];
    this.recommendationScope = JSON.stringify(this.recommendationIds);
    const recent =
      this.period === "past"
        ? recentDeadlineActions(
            filterDeadlineBoardEntries(all, this.activeGroup, this.query, filters),
            this.now,
            this.displayZone,
            this.venues,
            this.stageFilter,
          )
        : [];
    const next = headlineDeadlineEntry(filtered);
    const latestSourceCheck = this.venues
      .map((venue) => venue.source_checked_at || "")
      .filter(Boolean)
      .toSorted()
      .at(-1)
      ?.slice(0, 10);
    return html`
      <section class="deadline-board">
        ${this.accessRole === "admin" && this.conferenceError
          ? html`<p class="callout" role="status">${this.conferenceError}</p>`
          : nothing}
        ${this.datasetFailure
          ? html`<p class="callout danger" role="alert" data-testid="deadline-load-error">
              ${this.datasetFailure}
            </p>`
          : nothing}
        <header class="deadline-board__header">
          <div>
            <h1>${t("tabs.adminbotDeadlines")}</h1>
            ${latestSourceCheck
              ? html`<p class="deadline-board__updated">
                  Latest source check
                  <time datetime=${latestSourceCheck}>${plainDateLabel(latestSourceCheck)}</time>
                </p>`
              : nothing}
          </div>
          <div class="deadline-board__header-actions">
            ${canPropose
              ? html`<button
                  class="btn btn--sm"
                  type="button"
                  data-testid="deadline-my-proposals"
                  @click=${() => this.openProposalList("mine")}
                >
                  My proposals
                  <span
                    >${this.proposals.filter(
                      (proposal) => proposal.submitter_member_id === this.memberId,
                    ).length}</span
                  >
                </button>`
              : nothing}
            ${canReview
              ? html`<button
                  class="btn btn--sm"
                  type="button"
                  data-testid="deadline-review-proposals"
                  @click=${() => this.openProposalList("review")}
                >
                  Review proposals
                  <span
                    >${this.proposals.filter(
                      (proposal) => proposal.status === "pending" || proposal.status === "approved",
                    ).length}</span
                  >
                </button>`
              : nothing}
          </div>
        </header>
        ${this.proposalNotice
          ? html`<p class="deadline-proposal__notice" role="status">${this.proposalNotice}</p>`
          : nothing}
        ${this.proposalFailure
          ? html`<p class="deadline-proposal__failure" role="alert">${this.proposalFailure}</p>`
          : nothing}
        ${this.renderProposalDrawer()} ${this.renderModes()}
        ${this.renderControls(matching, periodEntries, filters)}
        ${recent.length
          ? html`<details class="deadline-recent" aria-label="Recently passed actions">
              <summary>Passed in the last 14 days (${recent.length})</summary>
              <p>
                Recently passed action dates. Check your submission status and the venue’s rules.
              </p>
              <ul>
                ${recent.map(
                  (entry) => html`<li>
                    <strong>${entry.stage!.label}</strong>
                    <span class="deadline-action__venue">${renderDeadlineTitle(entry.venue)}</span>
                    <span
                      >Passed ${Math.floor((this.now - entry.instant) / 86400000)}
                      ${Math.floor((this.now - entry.instant) / 86400000) === 1 ? "day" : "days"}
                      ago · ${renderDeadlineDateLabel(entry.stage!.dateLabel)}</span
                    >
                  </li>`,
                )}
              </ul>
            </details>`
          : nothing}
        ${next || !recent.length
          ? html`<div class="deadline-board__overview">${this.renderHero(next)}</div>`
          : nothing}
        ${filtered.length
          ? this.view === "cards"
            ? html`<div class="deadline-board__grid">
                ${filtered.map((entry) => this.renderCard(entry))}
              </div>`
            : this.view === "groups"
              ? this.renderGroups(filtered)
              : this.renderTable(filtered)
          : html`<p class="deadline-board__empty">
              ${recent.length
                ? "No upcoming deadlines match your filter."
                : "No deadlines match your filter."}
            </p>`}
        <span class="deadline-proposal-trigger">
          <button
            class="btn btn--sm primary"
            type="button"
            data-testid="deadline-propose"
            @click=${this.openProposalForm}
          >
            Propose a new deadline
          </button>
        </span>
      </section>
    `;
  }
}

if (!customElements.get("adminbot-deadlines-view")) {
  customElements.define("adminbot-deadlines-view", AdminbotDeadlinesView);
}

export type RenderDeadlinesOptions = {
  role?: AccessRole;
  memberId?: string | null;
  proposalStore?: DeadlineProposalStore;
  recommendationStore?: DeadlineRecommendationStore;
  settings?: Pick<UiSettings, "adminBotUrl"> | null;
  timelineMilestones?: MilestoneRow[] | null;
  onSaveTimeline?: (milestones: MilestoneRow[]) => Promise<boolean>;
};

export function renderDeadlines(options: RenderDeadlinesOptions = {}) {
  return html`<adminbot-deadlines-view
    access-role=${options.role ?? "anonymous"}
    member-id=${options.memberId ?? ""}
    .proposalStore=${options.proposalStore ?? deadlineProposalStoreFor(options.settings)}
    .recommendationStore=${options.recommendationStore ?? recommendationStoreFor(options.settings)}
    .timelineMilestones=${options.timelineMilestones ?? null}
    .onSaveTimeline=${options.onSaveTimeline}
    .conferenceBaseUrl=${resolveAdminBotBaseUrl(options.settings)}
  ></adminbot-deadlines-view>`;
}

const recommendationStores = new Map<string, DeadlineRecommendationStore>();
function recommendationStoreFor(settings?: Pick<UiSettings, "adminBotUrl"> | null) {
  const url = resolveAdminBotBaseUrl(settings);
  let store = recommendationStores.get(url);
  if (!store) {
    store = new AdminBotDeadlineRecommendationStore(url);
    recommendationStores.set(url, store);
  }
  return store;
}
