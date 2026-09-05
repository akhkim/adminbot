// Native rendering for every Control UI deadline surface.
//
// The service also exposes a self-contained version at GET /deadlines. Both surfaces read the
// generated deadline dataset and present the same board: period, type and archival filters,
// search, venue groups, source links, history, and card/group/table views. This renderer stays in
// app's document flow so the containing page owns one ordinary vertical scroll.

import { html, nothing, LitElement } from "lit";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { UiSettings } from "../../storage.ts";
import type { AccessRole } from "../access.ts";
import {
  AdminBotDeadlineProposalStore,
  deadlineProposalStoreFor,
  type DeadlineProposal,
  type DeadlineProposalInput,
  type DeadlineProposalStore,
  validateDeadlineProposal,
} from "../data/deadline-proposals.ts";
import {
  aoeDateLabel,
  aoeDateTimeLabel,
  aoeInstantMs,
  countdownLabel,
  dateRangeLabel,
  daysLeftLabel,
  MS_DAY,
  plainDateLabel,
  urgencyOf,
  type Urgency,
} from "../data/deadline-time.ts";
import {
  DEADLINE_VENUES,
  type DeadlineMilestone,
  type DeadlineVenue,
} from "../data/deadlines.ts";
import { AOE_TIMEZONE, timezoneOptions } from "../data/timezones.ts";
import { renderAoeDateTime } from "./deadline-date.ts";
import { renderDeadlineParentConferenceSelect } from "./deadline-parent-conference-select.ts";

const DEFAULT_DEADLINE_PROPOSAL_STORE = new AdminBotDeadlineProposalStore();

export type DeadlineBoardEntry = { venue: DeadlineVenue; instant: number };
type DeadlineGroupKind = "archival" | "nonArchival" | "mixed" | "unknown" | "other";
export type DeadlineBoardGroup = {
  id: string;
  label: string;
  entries: DeadlineBoardEntry[];
  instant: number;
  sections: Record<DeadlineGroupKind, DeadlineBoardEntry[]>;
  /**
   * Render as a single card rather than a collapsible group. True for everything that is not a
   * workshop, and for a workshop group that ended up holding one entry.
   */
  standalone: boolean;
};
export type DeadlineBoardView = "cards" | "groups" | "table";
export type DeadlineBoardPeriod = "upcoming" | "past";
export type DeadlineBoardEntryType = "all" | DeadlineVenue["entry_type"];
export type DeadlineBoardArchivalStatus = "all" | DeadlineVenue["archival_status"];
export type DeadlineBoardFilters = Readonly<{
  entryType: DeadlineBoardEntryType;
  archivalStatus: DeadlineBoardArchivalStatus;
}>;
type DeadlineUrgency = Urgency | "passed";

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
    .map((venue) => ({ venue, instant: aoeInstantMs(venue.deadline_aoe) }))
    .filter((entry) => Number.isFinite(entry.instant))
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
  "reviews",
  "rebuttal",
  "notification",
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

/**
 * Everything this venue has published after its submission, in the order it happens.
 *
 * `notification_aoe` is folded in as a decision entry when the curated schedule carries none, so
 * the ~30 rows that know only their notification date (every workshop, mostly) still render one
 * consistent list rather than a special case beside it. A curated notification always wins: it
 * comes off the venue's own calendar with a label the venue chose ("Meta-reviews released" is not
 * "Accept/reject"), where the folded-in one is only a date with no words of its own.
 */
export function venueSchedule(venue: DeadlineVenue): DeadlineMilestone[] {
  const curated = venue.schedule ?? [];
  const entries = [...curated];
  if (venue.notification_aoe && !curated.some((entry) => entry.milestone === "notification")) {
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

/** One schedule entry's date, read the way its `kind` says to read it. */
export function milestoneDateLabel(entry: DeadlineMilestone): string {
  if (entry.kind === "period") {
    return dateRangeLabel(entry.starts ?? "", entry.ends ?? "");
  }
  // Only an AoE cutoff gets the AoE suffix. A day the venue acts on is a plain calendar date, and
  // "conference opens Apr 26 AoE" would claim a precision nobody published.
  return entry.kind === "deadline"
    ? `${aoeDateLabel(entry.date ?? "")} AoE`
    : plainDateLabel(entry.date ?? "");
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
  return (
    entries.find(
      (entry) =>
        entry.venue.archival_status === "archival" && entry.venue.entry_type !== "workshop",
    ) ??
    entries.find((entry) => entry.venue.entry_type !== "workshop") ??
    entries[0]
  );
}

export function entriesForDeadlinePeriod(
  entries: readonly DeadlineBoardEntry[],
  now: number,
  period: DeadlineBoardPeriod,
): DeadlineBoardEntry[] {
  return entries
    .filter((entry) => (period === "upcoming" ? entry.instant > now : entry.instant <= now))
    .toSorted((left, right) =>
      period === "upcoming"
        ? left.instant - right.instant || left.venue.name.localeCompare(right.venue.name)
        : right.instant - left.instant || left.venue.name.localeCompare(right.venue.name),
    );
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
    if (filters.entryType !== "all" && venue.entry_type !== filters.entryType) {
      return false;
    }
    if (filters.archivalStatus !== "all" && venue.archival_status !== filters.archivalStatus) {
      return false;
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
 * Bundle workshops by parent conference; leave everything else as its own card.
 *
 * Grouping earned its place for the 140 workshops, where one EMNLP heading replaces ten near
 * identical rows. It never earned it for conferences: ICLR 2027's abstract and full-paper
 * deadlines are two dates a person plans around separately, and folding them behind one collapsed
 * heading hid the abstract deadline entirely. A group of one is likewise just a card wearing a
 * disclosure triangle, so it is flattened back into one.
 *
 * `standalone` carries that decision to the renderer rather than the renderer re-deriving it, so
 * the flat list and the grouped list cannot disagree about what counts as a group.
 */
export function groupDeadlineBoardEntries(
  entries: readonly DeadlineBoardEntry[],
): DeadlineBoardGroup[] {
  const groups = new Map<string, DeadlineBoardGroup>();
  // One ordered list, appended to as each group or card is first seen. Sorting the result by
  // instant instead would silently reverse the "Past" view, which arrives newest-first.
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
    const makeSections = (): Record<DeadlineGroupKind, DeadlineBoardEntry[]> => {
      const sections: Record<DeadlineGroupKind, DeadlineBoardEntry[]> = {
        archival: [],
        nonArchival: [],
        mixed: [],
        unknown: [],
        other: [],
      };
      sections[kind].push(entry);
      return sections;
    };

    // Anything that is not a workshop is its own card, keyed by venue id so two entries from the
    // same conference (ICLR's abstract and full paper) can never collide into one heading.
    if (entry.venue.entry_type !== "workshop") {
      ordered.push({
        id: `${id}::${entry.venue.id}::${entry.instant}`,
        label: id,
        entries: [entry],
        instant: entry.instant,
        sections: makeSections(),
        standalone: true,
      });
      continue;
    }

    const current = groups.get(id);
    if (current) {
      current.entries.push(entry);
      current.sections[kind].push(entry);
    } else {
      const created: DeadlineBoardGroup = {
        id,
        label: workshopGroupLabel(id),
        entries: [entry],
        instant: entry.instant,
        sections: makeSections(),
        standalone: false,
      };
      groups.set(id, created);
      ordered.push(created);
    }
  }
  // A workshop group that attracted only one entry is a card, not a group.
  for (const group of groups.values()) {
    if (group.entries.length === 1) {
      group.standalone = true;
    }
  }
  return ordered;
}

function groupOptions(entries: readonly DeadlineBoardEntry[], period: DeadlineBoardPeriod) {
  const groups = new Map<string, { id: string; label: string; count: number; instant: number }>();
  for (const entry of entries) {
    const current = groups.get(entry.venue.venue_group);
    if (current) {
      current.count += 1;
      current.instant =
        period === "upcoming"
          ? Math.min(current.instant, entry.instant)
          : Math.max(current.instant, entry.instant);
    } else {
      groups.set(entry.venue.venue_group, {
        id: entry.venue.venue_group,
        // Same wording as the group heading. The id stays the raw venue_group, which is what
        // filtering matches on, so renaming the chip cannot break selection.
        label: workshopGroupLabel(entry.venue.venue_group),
        count: 1,
        instant: entry.instant,
      });
    }
  }
  return [...groups.values()].toSorted((left, right) => {
    const chronology =
      period === "upcoming" ? left.instant - right.instant : right.instant - left.instant;
    return chronology || left.label.localeCompare(right.label);
  });
}

export function workshopSourceLinks(venue: DeadlineVenue): {
  titleUrl: string;
  sourceUrl: string;
  sourceLabel: "Call for papers" | "Official site" | "";
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
    sourceLabel: cfpUrl ? "Call for papers" : homepageUrl ? "Official site" : "",
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
    .filter(
      (deadline, index, revisions) => deadline.slice(0, 16) !== revisions[index - 1]?.slice(0, 16),
    );
  if (dates.at(-1)?.slice(0, 16) !== venue.deadline_aoe.slice(0, 16)) {
    dates.push(venue.deadline_aoe);
  }
  if (dates.length < 2) {
    return null;
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
  return change ? `${change.label}: ${change.dates.map(aoeDateTimeLabel).join(" → ")}` : "";
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
 * Only the publication policy is shown now.
 *
 * The Primary/Secondary venue priority was dropped from the board: it applied to 10 of 154 venues,
 * carried no date information, and sat beside the archival label where the two were routinely read
 * as one classification. `venue_priority` is still on the record for anything that wants to rank
 * venues — it is simply not a badge.
 */
function renderClassification(venue: DeadlineVenue) {
  const archival = archivalLabelOf(venue);
  return archival
    ? html`<span class="deadline-classification">
        <span class="deadline-archival" data-archival=${venue.archival_status}>${archival}</span>
      </span>`
    : nothing;
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
  { value: "all", label: "All entry types" },
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
  { value: "all", label: "All archival statuses" },
  { value: "archival", label: "Archival" },
  { value: "non_archival", label: "Non-archival" },
  { value: "mixed", label: "Archival + non-archival" },
  { value: "unknown", label: "Archival status unknown" },
];

function urgency(entry: DeadlineBoardEntry, now: number): DeadlineUrgency {
  return entry.instant <= now ? "passed" : urgencyOf(entry.instant, now);
}

function capitalize(value: string): string {
  return value ? `${value[0].toLocaleUpperCase()}${value.slice(1)}` : "Deadline";
}

function groupRowTitle(venue: DeadlineVenue, conference: string) {
  const stage = capitalize(venue.deadline_label);
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

function countdownParts(diff: number) {
  const left = Math.max(diff, 0);
  return {
    days: Math.floor(left / MS_DAY),
    hours: Math.floor(left / 3_600_000) % 24,
    minutes: Math.floor(left / 60_000) % 60,
    seconds: Math.floor(left / 1000) % 60,
  };
}

const pad = (value: number): string => String(value).padStart(2, "0");

function aoeDayKey(now: number): string {
  return new Date(now - 12 * 3_600_000).toISOString().slice(0, 10);
}

class AdminbotDeadlinesView extends LitElement {
  static override properties = {
    accessRole: { type: String, attribute: "access-role" },
    memberId: { type: String, attribute: "member-id" },
    proposalStore: { attribute: false },
  };

  accessRole: AccessRole = "anonymous";
  memberId = "";
  proposalStore: DeadlineProposalStore = DEFAULT_DEADLINE_PROPOSAL_STORE;

  private timer: number | undefined;
  private readonly expandedGroups = new Set<string>();
  private now = Date.now();
  private activeGroup = "";
  private query = "";
  private entryType: DeadlineBoardEntryType = "all";
  private archivalStatus: DeadlineBoardArchivalStatus = "all";
  private period: DeadlineBoardPeriod = "upcoming";
  private view: DeadlineBoardView = "groups";
  private venues: DeadlineVenue[] = DEADLINE_VENUES;
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

  override connectedCallback(): void {
    super.connectedCallback();
    this.timer = window.setInterval(() => {
      this.now = Date.now();
      this.requestUpdate();
    }, 1000);
    void this.loadPublishedDeadlines();
    if (this.accessRole !== "anonymous" && this.memberId) {
      void this.loadProposals();
    }
  }

  override disconnectedCallback(): void {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    super.disconnectedCallback();
  }

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("proposalStore")) {
      void this.loadPublishedDeadlines();
      if (this.accessRole !== "anonymous" && this.memberId) {
        void this.loadProposals();
      }
    }
    if (
      (changed.has("accessRole") || changed.has("memberId")) &&
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

  private async loadPublishedDeadlines(): Promise<void> {
    try {
      const venues = await this.proposalStore.listPublished();
      if (venues.length) {
        this.venues = venues;
      }
    } catch {
      // The bundled generated dataset remains a valid read-only fallback while the service
      // reconnects. Proposal writes still fail visibly instead of pretending they were saved.
      this.venues = DEADLINE_VENUES;
    }
    this.requestUpdate();
  }

  private openProposalForm(): void {
    if (!this.memberId) {
      return;
    }
    this.proposalFormOpen = true;
    this.proposalReviewOpen = false;
    this.editingProposalId = "";
    this.proposalNotice = "";
    this.proposalFailure = "";
    this.requestUpdate();
  }

  private async submitProposal(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!this.memberId || this.proposalBusy) {
      return;
    }
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
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
        await this.proposalStore.submit(validation.value, this.proposalSubmissionKey);
      }
      form.reset();
      this.proposalFormOpen = false;
      this.proposalNotice = this.editingProposalId
        ? "A revised deadline is ready for administrator approval."
        : "Proposal submitted for administrator review. It is not public until approved.";
      this.editingProposalId = "";
      this.proposalSubmissionKey = "";
      await this.loadProposals();
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
    if (!this.proposalFormOpen || !this.memberId) {
      return nothing;
    }
    const editing = this.proposals.find((proposal) => proposal.id === this.editingProposalId);
    const value = editing?.deadline;
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
              ${editing ? "Revise deadline proposal" : "Propose a new deadline"}
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
          <label>
            <span>Conference or workshop name</span>
            <input
              name="name"
              required
              autofocus
              .value=${value?.name ?? ""}
              aria-invalid=${String(Boolean(this.proposalErrors.name))}
            />
            ${this.renderProposalFieldError("name")}
          </label>
          <label>
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
          <label>
            <span>Parent conference <small>optional</small></span>
            ${renderDeadlineParentConferenceSelect({
              options: parentConferences,
              value: parentConference,
            })}
          </label>
          <label>
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
              <input
                name="deadlineDate"
                type="date"
                required
                .value=${value?.deadlineDate ?? ""}
                aria-invalid=${String(Boolean(this.proposalErrors.deadlineDate))}
              />
              ${this.renderProposalFieldError("deadlineDate")}
            </label>
            <label>
              <span>Deadline time</span>
              <input
                name="deadlineTime"
                type="time"
                .value=${value?.deadlineTime ?? "23:59"}
                required
                aria-invalid=${String(Boolean(this.proposalErrors.deadlineTime))}
              />
              ${this.renderProposalFieldError("deadlineTime")}
            </label>
            <label>
              <span>Time zone</span>
              <select
                name="timezone"
                required
                aria-invalid=${String(Boolean(this.proposalErrors.timezone))}
              >
                ${timezoneOptions(AOE_TIMEZONE).map(
                  (group) => html`<optgroup label=${group.label}>
                    ${group.options.map(
                      (option) => html`<option
                        value=${option.zone}
                        ?selected=${option.zone === (value?.timezone ?? AOE_TIMEZONE)}
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
            <span>Call for papers URL <small>optional</small></span>
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
      const submitterLabel =
        proposal.submitter_member_id === this.memberId
          ? "Submitted by you"
          : `Submitted by ${proposal.submitter_name || "a lab member"}`;
      return html`
        <article class="deadline-proposal-row" data-status=${proposal.status}>
          <div class="deadline-proposal-row__heading">
            <div>
              <span class="deadline-proposal-row__status">${capitalize(proposal.status)}</span>
              <h3>${deadline.name}</h3>
            </div>
            <span>${deadline.deadlineDate} · ${deadline.deadlineTime} · ${deadline.timezone}</span>
          </div>
          <p>
            ${ENTRY_TYPE_LABELS[deadline.entryType]}
            ${deadline.parentConference
              ? ` · ${deadline.parentConference}${deadline.parentYear ? ` ${deadline.parentYear}` : ""}`
              : ""}
            · ${submitterLabel} · Revision ${proposal.current_revision}
          </p>
          ${deadline.note ? html`<p>${deadline.note}</p>` : nothing}
          ${proposal.duplicate_deadline_ids.length
            ? html`<p class="deadline-proposal-row__duplicate">
                Possible duplicate of ${proposal.duplicate_deadline_ids.join(", ")}
              </p>`
            : nothing}
          <div class="deadline-proposal-row__links">
            <a href=${deadline.homepageUrl} target="_blank" rel="noopener noreferrer">Homepage</a>
            ${deadline.cfpUrl
              ? html`<a href=${deadline.cfpUrl} target="_blank" rel="noopener noreferrer"
                  >Call for papers</a
                >`
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
    const parts = countdownParts(entry.instant - this.now);
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
        <p class="deadline-board__eyebrow">${lead} deadline · ${entry.venue.venue_group}</p>
        <h2 class="deadline-board__hero-name">${renderDeadlineTitle(entry.venue)}</h2>
        <div class="deadline-board__hero-meta-row">
          <div class="deadline-board__hero-meta">
            ${capitalize(entry.venue.deadline_label)} ·
            <time class="deadline-board__hero-date" datetime=${entry.venue.deadline_aoe}
              >${renderAoeDateTime(entry.venue.deadline_aoe)}</time
            >
            ${this.renderHistory(entry.venue, "hero")} ·
            <span class="deadline-board__hero-urgency">${daysLeftLabel(entry.instant, this.now)}</span>
            ${renderClassification(entry.venue)}
          </div>
        </div>
        ${this.period === "upcoming"
          ? html`<div
              class="deadline-board__hero-countdown"
              aria-label=${countdownLabel(entry.instant - this.now)}
            >
              ${this.renderCountdownUnit(parts.days, "days")}
              <span aria-hidden="true">:</span>
              ${this.renderCountdownUnit(pad(parts.hours), "hrs")}
              <span aria-hidden="true">:</span>
              ${this.renderCountdownUnit(pad(parts.minutes), "min")}
              <span aria-hidden="true">:</span>
              ${this.renderCountdownUnit(pad(parts.seconds), "sec")}
            </div>`
          : nothing}
      </section>
    `;
  }

  private renderCountdownUnit(value: string | number, label: string) {
    return html`<span class="deadline-board__countdown-unit">
      <strong>${value}</strong><small>${label}</small>
    </span>`;
  }

  private renderStats(entries: readonly DeadlineBoardEntry[]) {
    const within = (days: number) =>
      entries.filter((entry) => {
        const distance =
          this.period === "upcoming" ? entry.instant - this.now : this.now - entry.instant;
        return distance >= 0 && distance <= days * MS_DAY;
      }).length;
    const today = entries.filter(
      (entry) => entry.venue.deadline_aoe.slice(0, 10) === aoeDayKey(this.now),
    ).length;
    const direction = this.period === "upcoming" ? "Due" : "Passed";
    return html`
      <dl class="deadline-board__stats">
        <div>
          <dt>Matching deadlines</dt>
          <dd>${entries.length}</dd>
        </div>
        <div>
          <dt>${direction} today</dt>
          <dd data-urgency="critical">${today}</dd>
        </div>
        <div>
          <dt>${direction} within 7 days</dt>
          <dd data-urgency="soon">${within(7)}</dd>
        </div>
        <div>
          <dt>${direction} within 30 days</dt>
          <dd data-urgency="planned">${within(30)}</dd>
        </div>
      </dl>
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
            ${ENTRY_TYPE_OPTIONS.map(
              (option) => html`<option value=${option.value}>
                ${option.label} (${count("entryType", option.value)})
              </option>`,
            )}
          </select>
        </label>
        <label class="deadline-board__facet">
          <span class="sr-only">Filter by archival status</span>
          <select
            data-testid="deadline-filter-archival-status"
            .value=${this.archivalStatus}
            @change=${this.setArchivalStatus}
          >
            ${ARCHIVAL_STATUS_OPTIONS.map(
              (option) => html`<option value=${option.value}>
                ${option.label} (${count("archivalStatus", option.value)})
              </option>`,
            )}
          </select>
        </label>
        <div class="deadline-board__groups" role="group" aria-label="Filter by venue">
          <button
            type="button"
            aria-pressed=${String(!this.activeGroup)}
            data-testid="deadline-group-all"
            @click=${() => this.selectGroup("")}
          >
            All <span>${entries.length}</span>
          </button>
          ${groupOptions(entries, this.period).map(
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

  private renderArchivalGuide() {
    return html`
      <details class="deadline-board__guide">
        <summary>What archival status means</summary>
        <p>
          Workshop status follows its own CFP or an official parent policy. A workshop can offer
          archival, non-archival, or separate archival and non-archival routes.
        </p>
        <dl>
          <div>
            <dt>Archival</dt>
            <dd>counts as publishing; the same paper cannot generally be submitted elsewhere.</dd>
          </div>
          <div>
            <dt>Non-archival</dt>
            <dd>does not count as publishing; you can still submit the paper elsewhere.</dd>
          </div>
          <div>
            <dt>Archival + non-archival</dt>
            <dd>choose the CFP's non-archival route if the paper may be submitted elsewhere.</dd>
          </div>
          <div>
            <dt>Unknown</dt>
            <dd>check the call for papers before assuming another submission is allowed.</dd>
          </div>
        </dl>
      </details>
    `;
  }

  private renderHistory(venue: DeadlineVenue, placement: "hero" | "card" | "group" | "table") {
    const previous = priorDeadlineRevisions(venue);
    const change = deadlineChangeSummary(venue);
    const extended = venue.deadline_extended || change?.kind === "extended";
    const available = previous.length > 0 || extended;
    const historyId = `deadline-history-${placement}-${venue.id.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
    const anchorName = `--${historyId}`;
    const countLabel = previous.length
      ? `Deadline history (${previous.length})`
      : extended
        ? "Extended deadline; earlier date unavailable"
        : "No deadline history";
    return html`<span
      class="deadline-card__note deadline-card__history"
      data-change=${extended ? "extended" : (change?.kind ?? "history")}
    >
      <button
        type="button"
        class="btn btn--icon deadline-card__history-trigger"
        popovertarget=${available ? historyId : nothing}
        aria-haspopup=${available ? "dialog" : nothing}
        aria-label=${countLabel}
        data-tooltip=${countLabel}
        style=${`anchor-name: ${anchorName}`}
        ?disabled=${!available}
      >
        ${icons.history}
      </button>
      ${available
        ? html`<div
            id=${historyId}
            class="deadline-card__history-panel"
            popover="auto"
            role="dialog"
            aria-label=${`Deadline history for ${venue.name}`}
            style=${`position-anchor: ${anchorName}`}
          >
            <strong>Deadline history</strong>
            ${previous.length
              ? html`<ul>
                  ${previous.map(
                    (revision) => html`<li>
                      ${renderAoeDateTime(revision.deadline_aoe)} ·
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
                  The official source marks this deadline as extended, but does not publish the
                  earlier date.
                </p>`}
          </div>`
        : nothing}
    </span>`;
  }

  /**
   * The rest of the venue's calendar, under the date the card counts down to.
   *
   * Deliberately quiet: no countdown, no urgency colour, no effect on sorting or on which entry
   * the board leads with. The submission is the thing anybody has to act on, and a rebuttal window
   * six months out competing with it for attention would make the board harder to read, not
   * richer. These are here to be looked up -- "when do decisions land", "can I book that week" --
   * which is a different act from scanning for what is due next.
   *
   * Collapsed past two entries. One or two lines cost nothing open, and that is the common case
   * (a workshop knows only its notification date); ICLR's four would otherwise be the tallest part
   * of a card whose point is a single date.
   */
  private renderSchedule(venue: DeadlineVenue) {
    const entries = venueSchedule(venue);
    if (entries.length === 0) {
      return nothing;
    }
    const rows = entries.map(
      (entry) => html`<li class="deadline-card__milestone" data-milestone=${entry.milestone}>
        <span class="deadline-card__milestone-label">${entry.label}</span>
        <span class="deadline-card__milestone-date">${milestoneDateLabel(entry)}</span>
      </li>`,
    );
    if (entries.length <= 2) {
      return html`<ul class="deadline-card__schedule" data-testid="deadline-schedule">
        ${rows}
      </ul>`;
    }
    return html`<details class="deadline-card__schedule-details" data-testid="deadline-schedule">
      <summary>Rest of the schedule (${entries.length})</summary>
      <ul class="deadline-card__schedule">
        ${rows}
      </ul>
    </details>`;
  }

  private renderStale(venue: DeadlineVenue) {
    return venue.stale
      ? html`<p class="deadline-card__note">Source not observed in the latest sweep.</p>`
      : nothing;
  }

  private renderCard(entry: DeadlineBoardEntry) {
    const { venue, instant } = entry;
    return html`
      <article
        class="deadline-card"
        data-entry-type=${venue.entry_type}
        data-archival-status=${venue.archival_status}
        data-venue-priority=${venue.venue_priority}
        data-urgency=${urgency(entry, this.now)}
        data-period=${this.period}
      >
        <div class="deadline-card__topline">
          <span class="deadline-card__type">${ENTRY_TYPE_LABELS[venue.entry_type]}</span>
          <span class="deadline-card__urgency">${daysLeftLabel(entry.instant, this.now)}</span>
        </div>
        <h2 class="deadline-card__name">${renderDeadlineTitle(venue)}</h2>
        <p
          class="deadline-card__group"
          title=${`${workshopGroupLabel(venue.venue_group)} · ${capitalize(venue.deadline_label)}`}
        >
          <span class="deadline-card__group-name">${workshopGroupLabel(venue.venue_group)}</span>
          <span aria-hidden="true">·</span>
          <span class="deadline-card__stage">${capitalize(venue.deadline_label)}</span>
        </p>
        ${renderClassification(venue)}
        <span class="deadline-card__date-row">
          <time class="deadline-card__date" datetime=${venue.deadline_aoe}>
            ${renderAoeDateTime(venue.deadline_aoe)}
          </time>
          ${this.renderHistory(venue, "card")}
        </span>
        <p class="deadline-card__countdown">
          ${this.period === "past" ? "passed" : countdownLabel(instant - this.now)}
        </p>
        ${this.renderSchedule(venue)}
        ${this.renderStale(venue)} ${this.renderSourceActions(venue)}
      </article>
    `;
  }

  private renderSourceActions(venue: DeadlineVenue) {
    const workshop = workshopSourceLinks(venue);
    if (!workshop) {
      return venue.link
        ? html`<span class="deadline-card__actions">
            <a
              class="deadline-card__source deadline-card__source--button"
              href=${venue.link}
              target="_blank"
              rel="noopener noreferrer"
              aria-label=${`Official site for ${venue.name}`}
              >Official site ↗</a
            >
          </span>`
        : nothing;
    }
    return html`<span class="deadline-card__actions">
      ${workshop.sourceUrl
        ? html`<a
            class="deadline-card__source deadline-card__source--button"
            href=${workshop.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${`${workshop.sourceLabel} for ${venue.name}`}
            >${workshop.sourceLabel} ↗</a
          >`
        : html`<span class="deadline-card__missing">Call for papers not found yet</span>`}
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
    </span>`;
  }

  private renderTable(entries: readonly DeadlineBoardEntry[]) {
    return html`
      <div class="deadline-table-wrap">
        <table class="deadline-table">
          <thead>
            <tr>
              <th>Deadline (AoE)</th>
              <th>Countdown</th>
              <th>Item</th>
              <th>Type</th>
              <th>Venue</th>
              <th><span class="sr-only">Source and history</span></th>
            </tr>
          </thead>
          <tbody>
            ${entries.map((entry) => {
              return html`
                <tr
                  data-entry-type=${entry.venue.entry_type}
                  data-archival-status=${entry.venue.archival_status}
                  data-venue-priority=${entry.venue.venue_priority}
                  data-urgency=${urgency(entry, this.now)}
                  data-period=${this.period}
                >
                  <td class="deadline-table__date">
                    <span class="deadline-table__date-row">
                      ${renderAoeDateTime(entry.venue.deadline_aoe)}
                      ${this.renderHistory(entry.venue, "table")}
                    </span>
                  </td>
                  <td class="deadline-table__countdown">
                    ${this.period === "past" ? "passed" : countdownLabel(entry.instant - this.now)}
                  </td>
                  <td class="deadline-table__name">${renderDeadlineTitle(entry.venue)}</td>
                  <td>
                    <span class="deadline-card__labels">
                      <span class="deadline-card__type"
                        >${ENTRY_TYPE_LABELS[entry.venue.entry_type]}</span
                      >
                      ${renderClassification(entry.venue)}
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
                    ${this.renderSourceActions(entry.venue)}
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderGroupRow(entry: DeadlineBoardEntry, conference: string) {
    const { venue, instant } = entry;
    const title = groupRowTitle(venue, conference);
    const change = deadlineChangeSummary(venue);
    const details = [
      venue.notification_aoe ? `Accept/reject ${aoeDateLabel(venue.notification_aoe)} AoE` : "",
      venue.stale ? "Source not observed in the latest sweep" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const note = [title.stage, details].filter(Boolean).join(" · ");
    return html`
      <div
        class="deadline-group__row"
        data-entry-type=${venue.entry_type}
        data-archival-status=${venue.archival_status}
        data-venue-priority=${venue.venue_priority}
        data-change=${change?.kind ?? nothing}
        data-urgency=${urgency(entry, this.now)}
        data-period=${this.period}
      >
        <span class="deadline-group__row-countdown">
          ${this.period === "past" ? "passed" : countdownLabel(instant - this.now)}
        </span>
        <span class="deadline-group__row-date-wrap">
          <time class="deadline-group__row-date" datetime=${venue.deadline_aoe}>
            ${renderAoeDateTime(venue.deadline_aoe)}
          </time>
          ${this.renderHistory(venue, "group")}
        </span>
        <div class="deadline-group__row-main">
          <h3 class="deadline-group__row-name">${renderDeadlineTitle(venue, title.name)}</h3>
          <p class="deadline-group__row-note">
            ${note ? html`<span class="deadline-group__row-detail">${note}</span>` : nothing}
            <span class="deadline-card__labels">
              <span class="deadline-card__type">${ENTRY_TYPE_LABELS[venue.entry_type]}</span>
              ${renderClassification(venue)}
            </span>
          </p>
        </div>
        ${this.renderSourceActions(venue)}
      </div>
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
        ${entries.map((entry) => this.renderGroupRow(entry, conference))}
      </section>
    `;
  }

  private renderGroups(entries: readonly DeadlineBoardEntry[]) {
    return html`<div class="deadline-board__group-list">
      ${groupDeadlineBoardEntries(entries).map((group, index) => {
        // A card, not a group: no disclosure triangle, no section headings, nothing to expand.
        // Rendered through the same row renderer the panel uses so the two cannot drift apart.
        const solo = group.entries[0];
        if (group.standalone && solo) {
          return html`<section
            class="deadline-group deadline-group--standalone"
            data-count="1"
            data-standalone="true"
            data-urgency=${urgency(solo, this.now)}
            data-period=${this.period}
          >
            ${this.renderGroupRow(solo, group.label)}
          </section>`;
        }
        const open = this.expandedGroups.has(group.id);
        const panelId = `deadline-group-panel-${index}`;
        const counts = [
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
              <span class="deadline-group__chevron" aria-hidden="true">›</span>
              <span class="deadline-group__summary-countdown"
                >${this.period === "past"
                  ? "passed"
                  : countdownLabel(group.instant - this.now)}</span
              >
              <span class="deadline-group__heading">
                <strong>${group.label}</strong>
                <small>${renderAoeDateTime(group.entries[0].venue.deadline_aoe)}</small>
              </span>
              <span class="deadline-group__count">${counts.join(" · ")}</span>
            </button>
            <div class="deadline-group__panel" id=${panelId} ?hidden=${!open}>
              ${this.renderGroupSection("Archival", group.sections.archival, group.label)}
              ${this.renderGroupSection("Non-archival", group.sections.nonArchival, group.label)}
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
            </div>
          </section>
        `;
      })}
    </div>`;
  }

  protected override render() {
    const canPropose = Boolean(this.memberId) && this.accessRole !== "anonymous";
    const canReview = canPropose && this.accessRole === "admin";
    const all = buildDeadlineBoardEntries(this.venues);
    const periodEntries = entriesForDeadlinePeriod(all, this.now, this.period);
    const filters: DeadlineBoardFilters = {
      entryType: this.entryType,
      archivalStatus: this.archivalStatus,
    };
    const matching = filterDeadlineBoardEntries(periodEntries, "", this.query, filters);
    if (
      this.activeGroup &&
      !matching.some((entry) => entry.venue.venue_group === this.activeGroup)
    ) {
      this.activeGroup = "";
    }
    const filtered = filterDeadlineBoardEntries(matching, this.activeGroup, "", filters);
    const next = headlineDeadlineEntry(filtered);
    const latestSourceCheck = this.venues
      .map((venue) => venue.source_checked_at || "")
      .filter(Boolean)
      .toSorted()
      .at(-1)
      ?.slice(0, 10);
    return html`
      <section class="deadline-board">
        <header class="deadline-board__header">
          <div>
            <h1>${t("tabs.adminbotDeadlines")}</h1>
            <p>${t("subtitles.adminbotDeadlines")}</p>
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
            <span
              class="deadline-proposal-trigger"
              title=${canPropose ? nothing : "Sign in to use deadline proposals."}
            >
              <button
                class="btn btn--sm primary"
                type="button"
                data-testid="deadline-propose"
                aria-describedby=${canPropose ? nothing : "deadline-proposal-sign-in-hint"}
                ?disabled=${!canPropose}
                @click=${this.openProposalForm}
              >
                Propose a new deadline
              </button>
            </span>
            ${canPropose
              ? nothing
              : html`<span id="deadline-proposal-sign-in-hint" class="sr-only">
                  Sign in to use deadline proposals.
                </span>`}
          </div>
        </header>
        ${this.proposalNotice
          ? html`<p class="deadline-proposal__notice" role="status">${this.proposalNotice}</p>`
          : nothing}
        ${this.proposalFailure
          ? html`<p class="deadline-proposal__failure" role="alert">${this.proposalFailure}</p>`
          : nothing}
        ${this.renderProposalDrawer()} ${this.renderModes()}
        ${this.renderControls(matching, periodEntries, filters)} ${this.renderArchivalGuide()}
        <div class="deadline-board__overview">
          ${this.renderHero(next)} ${this.renderStats(filtered)}
        </div>
        ${filtered.length
          ? this.view === "cards"
            ? html`<div class="deadline-board__grid">
                ${filtered.map((entry) => this.renderCard(entry))}
              </div>`
            : this.view === "groups"
              ? this.renderGroups(filtered)
              : this.renderTable(filtered)
          : html`<p class="deadline-board__empty">No deadlines match your filter.</p>`}
        <p class="deadline-board__foot">
          Showing ${filtered.length} of ${matching.length} matching ${this.period} deadlines ·
          official venue sites + OpenReview
          ${latestSourceCheck ? ` · source checks through ${latestSourceCheck}` : ""}
        </p>
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
  settings?: Pick<UiSettings, "adminBotUrl"> | null;
};

export function renderDeadlines(options: RenderDeadlinesOptions = {}) {
  return html`<adminbot-deadlines-view
    access-role=${options.role ?? "anonymous"}
    member-id=${options.memberId ?? ""}
    .proposalStore=${options.proposalStore ?? deadlineProposalStoreFor(options.settings)}
  ></adminbot-deadlines-view>`;
}
