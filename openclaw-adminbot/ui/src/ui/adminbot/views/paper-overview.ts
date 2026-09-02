// Active Papers: where everybody's papers stand, as a spreadsheet -- one row per person.
//
// This replaced a Gantt chart. The chart drew one timeline bar per step per paper on a shared
// business-day scale, which answered "how long is this paper" beautifully and "which papers need me
// today" not at all -- the question an administrator actually arrives with. Seventy papers of bars
// is a picture you look at; seventy rows sorted by what is outstanding is a list you work through.
// The per-paper timeline did not disappear, it moved to the paper's own card in My Projects &
// Papers, which is where somebody reading one paper already is.
//
// The list is now one row per person rather than one per paper. A lab is staffed, not stacked: the
// administrator's question is which student is carrying three drafts and owes evidence on all of
// them, and a per-paper list can only answer it by making somebody read the author column of
// seventy rows and count. Each person's papers still sit inside their row, carrying the same
// stage, venue and evidence they carried on their own line, and the title still opens the card.
//
// Deliberately the same shape as Profile Completeness next door: a roll-up line, a filter row, then
// one row per person with the scannable measure on the left and the detail on the right. The two
// tabs of Lab Overview answer the same kind of question about the same people, and reading the
// second should cost nothing once you have read the first.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import {
  matchesMemberTypeFilter,
  renderMemberTypeFilter,
} from "../member-type-filter.ts";
import type { PaperSlotOverviewRow } from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";

/**
 * Which papers the page is looking at.
 *
 * `state` is the grouping that makes this a working list rather than an inventory: `attention` is
 * everything with something outstanding on it, which is the sweep, and `dormant` is the pile that
 * would otherwise pad every count on the page.
 */
export type PaperOverviewState = "all" | "attention" | "in_flight" | "dormant";

export type PaperOverviewFilter = {
  search: string;
  venue: string;
  stage: string;
  state: PaperOverviewState;
  /**
   * People whose paper list is folded away, by person key.
   *
   * On the filter rather than in storage because it is the same kind of thing as the search box:
   * how this reader is looking at the list right now. Somebody with eleven papers pushes everyone
   * below them off the screen, and an administrator scanning for who is stuck should be able to
   * put that person's stack away without losing the row that says how they are doing.
   */
  collapsed: string[];
  /**
   * Roster member types to show, as a union. Empty means every type.
   *
   * Applied to the people rows rather than to the papers: a paper does not have a member type, the
   * author does, and a co-authored paper legitimately appears under two people whose types differ.
   * Filtering the papers instead would drop a major coauthor's paper from their own row because a
   * different author on it is an acquaintance.
   */
  memberTypes: string[];
};

export const EMPTY_PAPER_OVERVIEW_FILTER: PaperOverviewFilter = {
  search: "",
  venue: "",
  stage: "",
  state: "all",
  collapsed: [],
  memberTypes: [],
};

/**
 * How far a paper actually is.
 *
 * Two real facts, and nothing invented. The required evidence slots are the paper's own checklist --
 * brainstorm doc, Overleaf link, review done, PDF compiles, submission page and ID, Drive copy,
 * arXiv, the social posts, slides, poster -- and the service already counts how many of them have
 * settled. The venue decision is the one gate no amount of author work opens, so an acceptance
 * counts as one more unit alongside them:
 *
 *     percent = (settled slots + 1 if accepted) / (required slots + 1)
 *
 * No weighting constant, because there is nothing to justify one with: every unit is one thing that
 * either happened or did not. A rejection is not progress -- the paper goes back out on a new
 * attempt -- so it earns the unit only on an acceptance.
 *
 * This replaced the service's `progress_percent`, which was `current_step` looked up in a fixed
 * eight-step plan: the same number for every paper on the same step, capped at 88%, and blind to
 * everything the paper had actually filed.
 */
export type PaperProgress = {
  /** 0 to 100, or null when the service has not counted this paper's evidence at all. */
  percent: number | null;
  /** What the remainder is waiting on, which is what the number cannot say by itself. */
  waitingOn: "evidence" | "decision" | "resubmission" | "nothing";
  provided: number;
  required: number;
  /** Whether the venue-decision unit counted -- true only for an acceptance. */
  accepted: boolean;
};

export function paperProgress(params: {
  slots: PaperSlotOverviewRow | undefined;
  decision: AdminBotPaperRecord["venue_decision"];
  complete: boolean;
}): PaperProgress {
  const accepted = params.decision === "accept";
  const provided = params.slots?.provided_count ?? 0;
  const required = params.slots?.required_count ?? 0;
  const waitingOn = params.complete
    ? "nothing"
    : params.decision === "reject"
      ? "resubmission"
      : // `missing_slots` is the service's own actionable list, not everything unfilled: a paper
        // waiting on a verdict has post-acceptance slots outstanding that nobody can act on, and
        // calling that "waiting on evidence" would point an administrator at the wrong person.
        (params.slots?.missing_slots.length ?? 0) > 0
        ? "evidence"
        : accepted
          ? "nothing"
          : "decision";
  if (params.complete) {
    return { percent: 100, waitingOn, provided, required, accepted };
  }
  // A paper the service has not counted has no progress to report. Zero would be a claim.
  if (!params.slots || required <= 0) {
    return { percent: null, waitingOn, provided, required, accepted };
  }
  const units = required + 1;
  const done = Math.min(provided, required) + (accepted ? 1 : 0);
  return {
    percent: Math.round((done / units) * 100),
    waitingOn,
    provided,
    required,
    accepted,
  };
}

/** One paper with the evidence the service counted for it folded in. */
export type PaperOverviewRow = {
  paper: AdminBotPaperRecord;
  /**
   * How many steps of the flow are behind this paper, and how many there are.
   *
   * Deliberately a step count and not the service's `progress_percent`. That field is a lookup:
   * `current_step` against a fixed eight-step plan weighted by hardcoded day estimates, so every
   * paper on the same step reports the same number forever -- a draft nobody has started and a
   * draft about to be submitted both read 12% -- it jumps 12% to 44% for one step, and a paper on
   * the last step reads 88% and can never reach 100% unless somebody sets `reminder.status`. It
   * measures which step the paper is on, which is what the Stage column says in words anyway. A
   * step count says the same true thing without implying it knows how much of the work is done.
   */
  stepIndex: number;
  stepCount: number;
  /** The cycle is finished: the reminder says so, or the service closed it. */
  complete: boolean;
  /** How far the paper actually is, from what it has filed and what the venue said. */
  progress: PaperProgress;
  currentLabel: string;
  nextLabel: string;
  venue: string;
  deadline: string;
  slots: PaperSlotOverviewRow | undefined;
  openBlockers: number;
  /** Something is outstanding on this paper: evidence, a blocker, or an escalation. */
  needsAttention: boolean;
  /** Nobody is expected to move this right now -- dormant, or the cycle is closed. */
  dormant: boolean;
};

export type PaperOverviewSummary = {
  papers: number;
  attention: number;
  inFlight: number;
  dormant: number;
  /** Papers with no venue recorded. The ones nobody can plan around. */
  withoutVenue: number;
};

const STATE_OPTIONS: Array<{ value: PaperOverviewState; labelKey: string }> = [
  { value: "attention", labelKey: "paperOverview.filters.attention" },
  { value: "in_flight", labelKey: "paperOverview.filters.inFlight" },
  { value: "dormant", labelKey: "paperOverview.filters.dormant" },
  { value: "all", labelKey: "paperOverview.filters.all" },
];

/**
 * The venue a paper is aimed at or landed in.
 *
 * Accepted first: once a paper is in somewhere, that is its venue, and the target it was aimed at
 * months ago is history the row does not need.
 */
export function paperVenue(paper: AdminBotPaperRecord): string {
  const artifacts = paper.artifacts ?? {};
  return (
    paper.accepted_venue?.trim() ||
    paper.venue?.trim() ||
    artifacts.conference?.trim() ||
    artifacts.venue?.trim() ||
    ""
  );
}

/** Builds the rows the page shows, before any filter is applied. */
export function paperOverviewRows(params: {
  papers: readonly AdminBotPaperRecord[];
  slots: readonly PaperSlotOverviewRow[];
  blockerCounts: ReadonlyMap<string, number>;
  stepLabel: (step: string) => string;
  /** How many steps the flow has, for a paper the service has not computed a timeline for. */
  stepCount: number;
}): PaperOverviewRow[] {
  const slotsById = new Map(params.slots.map((row) => [row.paper_id, row]));
  return params.papers.map((paper) => {
    const slots = slotsById.get(paper.id);
    const timeline = paper.timeline;
    const current = timeline?.items.find((item) => item.status === "current");
    const next = timeline?.items.find((item) => item.status === "upcoming");
    const openBlockers = params.blockerCounts.get(paper.id) ?? 0;
    const dormant = Boolean(paper.dormant_override || slots?.closed || slots?.cycle_closed);
    const missingEvidence = slots ? slots.required_count - slots.provided_count : 0;
    const stepCount = timeline?.items.length || params.stepCount;
    const complete =
      paper.reminder?.status === "complete" || Boolean(slots?.closed || slots?.cycle_closed);
    return {
      paper,
      stepIndex: complete ? stepCount : (timeline?.current_step_index ?? 0),
      stepCount,
      complete,
      progress: paperProgress({
        slots,
        decision: paper.venue_decision,
        complete,
      }),
      currentLabel: current?.label ?? params.stepLabel(paper.current_step),
      nextLabel: next?.label ?? "",
      venue: paperVenue(paper),
      deadline: paper.deadline?.trim() ?? "",
      slots,
      openBlockers,
      // A dormant paper is outstanding to nobody, whatever it is missing -- counting it would make
      // the sweep permanently non-empty and so permanently ignorable.
      needsAttention:
        !dormant && (missingEvidence > 0 || openBlockers > 0 || Boolean(slots?.escalating)),
      dormant,
    };
  });
}

/** The rows a filter shows. Exported so the page, the count and the tests agree on one definition. */
export function filterPaperRows(
  rows: readonly PaperOverviewRow[],
  filter: PaperOverviewFilter,
): PaperOverviewRow[] {
  const search = filter.search.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (
      search &&
      !`${row.paper.title} ${row.paper.authors.join(" ")} ${row.venue}`
        .toLocaleLowerCase()
        .includes(search)
    ) {
      return false;
    }
    if (filter.venue && row.venue !== filter.venue) {
      return false;
    }
    if (filter.stage && row.paper.current_step !== filter.stage) {
      return false;
    }
    switch (filter.state) {
      case "attention":
        return row.needsAttention;
      case "in_flight":
        return !row.dormant;
      case "dormant":
        return row.dormant;
      default:
        return true;
    }
  });
}

/** The line above the table. Counted over every paper, not over what the filter left. */
export function paperOverviewSummary(rows: readonly PaperOverviewRow[]): PaperOverviewSummary {
  return {
    papers: rows.length,
    attention: rows.filter((row) => row.needsAttention).length,
    inFlight: rows.filter((row) => !row.dormant).length,
    dormant: rows.filter((row) => row.dormant).length,
    withoutVenue: rows.filter((row) => !row.venue).length,
  };
}

/** Every venue named by at least one paper, for the filter. */
export function paperVenueOptions(rows: readonly PaperOverviewRow[]): string[] {
  return [...new Set(rows.map((row) => row.venue).filter(Boolean))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

/**
 * One person, and every paper with their name on it.
 *
 * The table used to be one row per paper, which is the right shape for "how is this paper doing"
 * and the wrong one for the question an administrator actually arrives with -- who is carrying
 * what, and who is holding something up. Seventy paper rows hide the fact that four of them are
 * the same overloaded student; four person rows say it on sight.
 *
 * The paper detail did not go anywhere: each person's papers are listed inside their row, with the
 * same stage, venue and evidence they carried as rows of their own, and the title still opens the
 * paper's card.
 */
export type PaperPersonRow = {
  /** Stable identity: a roster id where the paper links one, otherwise an email or a name. */
  key: string;
  /** How the papers spell them. Empty for the bucket of papers naming nobody. */
  name: string;
  memberId?: string;
  /** Their papers, most outstanding first. */
  papers: PaperOverviewRow[];
  attention: number;
  inFlight: number;
  dormant: number;
  /** Evidence summed over the papers the service has counted for them. */
  provided: number;
  required: number;
  /** What is missing across their papers, deduped -- the list you read back to them. */
  missing: string[];
  /** Mean progress over their counted papers, or null when none of them is counted. */
  percent: number | null;
  /** How many of their papers wait on each thing. Only the non-empty entries are drawn. */
  waiting: Array<{ reason: PaperProgress["waitingOn"]; count: number }>;
  openBlockers: number;
  escalating: boolean;
  needsAttention: boolean;
};

/** The bucket for papers whose author list names nobody. Sorted last, never silently dropped. */
const UNASSIGNED_KEY = " unassigned";

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** A link's identity, which outranks the spelling of the name next to it. */
function authorLinkKey(link: { member_id?: string; email?: string }): string | undefined {
  const memberId = link.member_id?.trim();
  if (memberId) {
    return `member:${memberId}`;
  }
  const email = link.email?.trim();
  return email ? `email:${normalized(email)}` : undefined;
}

/**
 * Names that resolve to one identity across the whole lab.
 *
 * A person is linked on one paper and spelled by name on another; without this they would be two
 * rows. Only unambiguous names resolve -- two members sharing a name is exactly the case where
 * guessing puts somebody else's paper on somebody's row.
 */
function authorIdentityIndex(rows: readonly PaperOverviewRow[]): Map<string, string> {
  const keysByName = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const link of row.paper.author_links ?? []) {
      const key = authorLinkKey(link);
      const name = normalized(link.name ?? "");
      if (!key || !name) {
        continue;
      }
      const keys = keysByName.get(name) ?? new Set<string>();
      keys.add(key);
      keysByName.set(name, keys);
    }
  }
  const index = new Map<string, string>();
  for (const [name, keys] of keysByName) {
    const [only] = [...keys];
    if (keys.size === 1 && only) {
      index.set(name, only);
    }
  }
  return index;
}

/** Who a paper belongs to, as identity keys with the name to print for each. */
function paperAuthorEntries(
  paper: AdminBotPaperRecord,
  index: ReadonlyMap<string, string>,
): Map<string, string> {
  const entries = new Map<string, string>();
  const linked = new Set<string>();
  for (const link of paper.author_links ?? []) {
    const name = link.name?.trim() ?? "";
    const key = authorLinkKey(link) ?? (name ? `name:${normalized(name)}` : undefined);
    if (name) {
      linked.add(normalized(name));
    }
    if (key && !entries.has(key)) {
      entries.set(key, name);
    }
  }
  for (const author of paper.authors) {
    const name = author.trim();
    // `authors` is how the paper spells the name; a link for that name on this paper has already
    // said who it is, and re-adding it by name would file the paper under a second person.
    if (!name || linked.has(normalized(name))) {
      continue;
    }
    const key = index.get(normalized(name)) ?? `name:${normalized(name)}`;
    if (!entries.has(key)) {
      entries.set(key, name);
    }
  }
  if (!entries.size) {
    entries.set(UNASSIGNED_KEY, "");
  }
  return entries;
}

const WAITING_ORDER: Array<PaperProgress["waitingOn"]> = ["evidence", "resubmission", "decision"];

/**
 * Folds paper rows into people. A co-authored paper appears on every author's row, because it is
 * outstanding to each of them -- this is a working list, not an accounting of who owns what.
 */
export function paperPersonRows(rows: readonly PaperOverviewRow[]): PaperPersonRow[] {
  const index = authorIdentityIndex(rows);
  const people = new Map<string, PaperPersonRow>();
  for (const row of rows) {
    for (const [key, name] of paperAuthorEntries(row.paper, index)) {
      const person = people.get(key) ?? {
        key,
        name,
        memberId: key.startsWith("member:") ? key.slice("member:".length) : undefined,
        papers: [],
        attention: 0,
        inFlight: 0,
        dormant: 0,
        provided: 0,
        required: 0,
        missing: [],
        percent: null,
        waiting: [],
        openBlockers: 0,
        escalating: false,
        needsAttention: false,
      };
      if (!person.name && name) {
        person.name = name;
      }
      person.papers.push(row);
      people.set(key, person);
    }
  }
  for (const person of people.values()) {
    person.papers = person.papers.toSorted(comparePapers);
    person.attention = person.papers.filter((row) => row.needsAttention).length;
    person.inFlight = person.papers.filter((row) => !row.dormant).length;
    person.dormant = person.papers.filter((row) => row.dormant).length;
    person.openBlockers = person.papers.reduce((total, row) => total + row.openBlockers, 0);
    person.escalating = person.papers.some((row) => Boolean(row.slots?.escalating));
    person.needsAttention = person.attention > 0;
    for (const row of person.papers) {
      person.provided += row.slots?.provided_count ?? 0;
      person.required += row.slots?.required_count ?? 0;
    }
    person.missing = [...new Set(person.papers.flatMap((row) => row.slots?.missing_slots ?? []))];
    const counted = person.papers
      .map((row) => row.progress.percent)
      .filter((percent): percent is number => percent !== null);
    // A mean, not a weighted one: a person is behind on a paper or they are not, and a paper with
    // more required slots is not more of their week than one with fewer.
    person.percent = counted.length
      ? Math.round(counted.reduce((total, percent) => total + percent, 0) / counted.length)
      : null;
    person.waiting = WAITING_ORDER.map((reason) => ({
      reason,
      count: person.papers.filter((row) => !row.dormant && row.progress.waitingOn === reason)
        .length,
    })).filter((entry) => entry.count > 0);
  }
  return [...people.values()].toSorted(comparePeople);
}

/** Outstanding first, dormant last, then by title -- the order somebody works down. */
function comparePapers(left: PaperOverviewRow, right: PaperOverviewRow): number {
  if (left.needsAttention !== right.needsAttention) {
    return left.needsAttention ? -1 : 1;
  }
  if (left.dormant !== right.dormant) {
    return left.dormant ? 1 : -1;
  }
  return left.paper.title.localeCompare(right.paper.title);
}

/** The person somebody is waiting on most, first. The nameless bucket never outranks a person. */
function comparePeople(left: PaperPersonRow, right: PaperPersonRow): number {
  const unnamed = Number(left.key === UNASSIGNED_KEY) - Number(right.key === UNASSIGNED_KEY);
  if (unnamed !== 0) {
    return unnamed;
  }
  if (left.attention !== right.attention) {
    return right.attention - left.attention;
  }
  if (left.papers.length !== right.papers.length) {
    return right.papers.length - left.papers.length;
  }
  return left.name.localeCompare(right.name);
}

export type PaperOverviewProps = {
  rows: PaperOverviewRow[];
  filter: PaperOverviewFilter;
  onFilterChange: (filter: PaperOverviewFilter) => void;
  /** Opens the paper itself. The row is a summary; the record is edited where it is edited. */
  onOpenPaper: (paperId: string) => void;
  stages: ReadonlyArray<{ value: string; label: string }>;
  /**
   * This person's roster member type, for the type filter.
   *
   * A lookup rather than a field on the row because the rows are folded out of papers, and a paper
   * carries an author link, not a roster record. Optional so the table still renders for a caller
   * that has no roster to hand -- which is every test that is not about this filter, and is why an
   * absent lookup reads as "unknown type" rather than as "filter everything out".
   */
  memberTypeOf?: (memberId: string | undefined) => string | undefined;
  /** Drawn in the header, where the page's own actions belong. Optional so tests need none. */
  actions?: unknown;
};

export function renderPaperOverviewTable(props: PaperOverviewProps) {
  const summary = paperOverviewSummary(props.rows);
  const shown = filterPaperRows(props.rows, props.filter);
  const people = paperPersonRows(shown).filter((person) =>
    matchesMemberTypeFilter(props.memberTypeOf?.(person.memberId), props.filter.memberTypes),
  );
  const venues = paperVenueOptions(props.rows);
  return html`
    <section class="adminbot-shell paper-overview" data-testid="adminbot-paper-overview">
      <div class="card adminbot-card adminbot-card--wide">
        <div class="profile-overview__heading">
          <div>
            <div class="card-title">${t("paperOverview.title")}</div>
            <div class="card-sub">${t("paperOverview.sub")}</div>
          </div>
          <div class="profile-overview__actions">
            <label class="profile-overview__filter">
              <span class="sr-only">${t("paperOverview.filters.searchLabel")}</span>
              <input
                class="input"
                type="search"
                data-testid="paper-overview-search"
                placeholder=${t("paperOverview.filters.searchPlaceholder")}
                .value=${props.filter.search}
                @input=${(event: Event) =>
                  props.onFilterChange({
                    ...props.filter,
                    search: (event.target as HTMLInputElement).value,
                  })}
              />
            </label>
            ${renderSelect({
              testId: "paper-overview-filter-state",
              label: t("paperOverview.filters.stateLabel"),
              value: props.filter.state,
              options: STATE_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              })),
              onChange: (value) =>
                props.onFilterChange({
                  ...props.filter,
                  state: value as PaperOverviewState,
                }),
            })}
            ${renderSelect({
              testId: "paper-overview-filter-stage",
              label: t("paperOverview.filters.stageLabel"),
              value: props.filter.stage,
              options: [
                { value: "", label: t("paperOverview.filters.allStages") },
                ...props.stages,
              ],
              onChange: (value) => props.onFilterChange({ ...props.filter, stage: value }),
            })}
            ${renderSelect({
              testId: "paper-overview-filter-venue",
              label: t("paperOverview.filters.venueLabel"),
              value: props.filter.venue,
              options: [
                { value: "", label: t("paperOverview.filters.allVenues") },
                ...venues.map((venue) => ({ value: venue, label: venue })),
              ],
              onChange: (value) => props.onFilterChange({ ...props.filter, venue: value }),
            })}
            ${renderMemberTypeFilter({
              selected: props.filter.memberTypes,
              onChange: (memberTypes) => props.onFilterChange({ ...props.filter, memberTypes }),
              testIdPrefix: "paper-overview",
              label: t("profileOverview.filters.memberTypeLabel"),
            })}
            ${props.actions ?? nothing}
          </div>
        </div>

        ${renderSummary(summary, props, paperPersonRows(props.rows).length)}
        ${people.length
          ? html`
              <div class="profile-overview__scroll">
                <table class="profile-overview__table paper-overview__table">
                  <thead>
                    <tr>
                      <th scope="col" class="profile-overview__head">
                        ${t("paperOverview.columns.person")}
                      </th>
                      <th scope="col" class="profile-overview__head">
                        ${t("paperOverview.columns.progress")}
                      </th>
                      <th scope="col" class="profile-overview__head">
                        ${t("paperOverview.columns.evidence")}
                      </th>
                      <th scope="col" class="profile-overview__head">
                        ${t("paperOverview.columns.papers")}
                      </th>
                      <th scope="col" class="profile-overview__head">
                        ${t("paperOverview.columns.outstanding")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    ${people.map((person) => renderPersonRow(props, person))}
                  </tbody>
                </table>
              </div>
            `
          : html`<p class="logistics-requests__empty" data-testid="paper-overview-empty">
              ${props.rows.length ? t("paperOverview.noMatches") : t("paperOverview.empty")}
            </p>`}
      </div>
    </section>
  `;
}

/**
 * The roll-up, whose figures double as the filter.
 *
 * Pressing a number is the same gesture as reading it: an administrator who has just been told
 * eleven papers need attention wants those eleven, and making them hunt for the matching option in
 * a select is asking them to say it twice. The figures still count papers -- the table groups them
 * by person, but "eleven papers need attention" is the fact, and one person can carry three of
 * them -- so the head count sits alongside as a plain figure rather than a fifth filter.
 */
function renderSummary(summary: PaperOverviewSummary, props: PaperOverviewProps, people: number) {
  const figure = (
    value: number,
    labelKey: string,
    state: PaperOverviewState,
    tone?: "attention",
  ) => html`
    <button
      class="paper-overview__figure ${props.filter.state === state ? "is-active" : ""}"
      type="button"
      data-testid=${`paper-overview-figure-${state}`}
      aria-pressed=${props.filter.state === state ? "true" : "false"}
      @click=${() => props.onFilterChange({ ...props.filter, state })}
    >
      <span
        class="profile-overview__adoption-figure ab-num ${tone === "attention" && value > 0
          ? "is-attention"
          : ""}"
        >${value}</span
      >
      <span class="muted">${t(labelKey)}</span>
    </button>
  `;
  return html`
    <div class="profile-overview__adoption-summary" data-testid="paper-overview-summary">
      ${figure(summary.attention, "paperOverview.summary.attention", "attention", "attention")}
      ${figure(summary.inFlight, "paperOverview.summary.inFlight", "in_flight")}
      ${figure(summary.dormant, "paperOverview.summary.dormant", "dormant")}
      ${figure(summary.papers, "paperOverview.summary.papers", "all")}
      <div class="paper-overview__figure paper-overview__figure--static">
        <span class="profile-overview__adoption-figure ab-num" data-testid="paper-overview-people"
          >${people}</span
        >
        <span class="muted">${t("paperOverview.summary.people")}</span>
      </div>
      ${summary.withoutVenue
        ? html`<div class="paper-overview__figure paper-overview__figure--static">
            <span class="profile-overview__adoption-figure ab-num">${summary.withoutVenue}</span>
            <span class="muted">${t("paperOverview.summary.withoutVenue")}</span>
          </div>`
        : nothing}
    </div>
  `;
}

function renderSelect(params: {
  testId: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return html`
    <label class="profile-overview__filter">
      <span class="sr-only">${params.label}</span>
      <select
        class="target__select"
        data-testid=${params.testId}
        @change=${(event: Event) => params.onChange((event.target as HTMLSelectElement).value)}
      >
        ${params.options.map(
          (option) => html`
            <option value=${option.value} ?selected=${option.value === params.value}>
              ${option.label}
            </option>
          `,
        )}
      </select>
    </label>
  `;
}

/**
 * The progress cell: how far this person's papers are between them, and what the rest waits on.
 *
 * The waiting-on lines are not decoration. Two people both at 60% are different problems when one
 * of them owes evidence on three drafts and the other has filed everything and is waiting on
 * programme committees, and a bar alone cannot tell them apart.
 */
function renderPersonProgressCell(person: PaperPersonRow) {
  const percent = person.percent;
  if (percent === null) {
    return html`<span class="muted">${t("paperOverview.progressUnknown")}</span>`;
  }
  return html`
    <div class="paper-overview__progress">
      <div class="profile-overview__progress">
        <div
          class="profile-overview__bar ${percent >= 100 ? "is-complete" : ""}"
          role="img"
          aria-label=${t("paperOverview.progressLabel", {
            percent: String(percent),
            provided: String(person.provided),
            required: String(person.required),
          })}
        >
          <span class="profile-overview__bar-fill" style="width: ${percent}%"></span>
        </div>
        <span class="profile-overview__percent ab-num">${percent}%</span>
      </div>
      ${person.waiting.length
        ? person.waiting.map(
            (entry) =>
              html`<span class="profile-overview__status" data-waiting=${entry.reason}
                >${t("paperOverview.person.waiting", {
                  count: String(entry.count),
                  reason: t(`paperOverview.waitingOn.${entry.reason}`),
                })}</span
              >`,
          )
        : html`<span class="profile-overview__status" data-waiting="nothing"
            >${t("paperOverview.waitingOn.nothing")}</span
          >`}
    </div>
  `;
}

/**
 * The evidence cell: how much of what this person owes has arrived, across their papers.
 *
 * Named blanks under the count, not just a fraction, for the same reason Profile Completeness names
 * missing fields: the name is the thing an administrator repeats to the author. Capped at three
 * because past that the answer is "most of it" and the row stops being scannable.
 */
function renderPersonEvidenceCell(person: PaperPersonRow) {
  if (!person.required) {
    return html`<span class="muted">${t("paperOverview.noEvidence")}</span>`;
  }
  const missing = person.required - person.provided;
  return html`
    <div class="paper-overview__evidence">
      <span class="ab-num ${missing > 0 ? "is-attention" : ""}"
        >${person.provided}/${person.required}</span
      >
      ${person.missing.length
        ? html`<ul class="profile-overview__missing">
            ${person.missing.slice(0, 3).map((slot) => html`<li>${slot.replaceAll("_", " ")}</li>`)}
            ${person.missing.length > 3
              ? html`<li class="muted">
                  ${t("paperOverview.moreMissing", { count: String(person.missing.length - 3) })}
                </li>`
              : nothing}
          </ul>`
        : html`<span class="profile-overview__done">${t("paperOverview.allEvidence")}</span>`}
    </div>
  `;
}

/**
 * One of the person's papers, inside their row.
 *
 * Everything the old per-paper row carried except the bar: the stage in words, the venue and its
 * deadline, this paper's own evidence fraction, and the title as the way into its card. The bar
 * moved up to the person, because a bar per paper inside a row is the chart this page replaced.
 */
function renderPersonPaper(props: PaperOverviewProps, row: PaperOverviewRow) {
  return html`
    <li
      class="paper-overview__paper"
      data-attention=${row.needsAttention}
      data-dormant=${row.dormant}
    >
      <button
        class="logistics-requests__open"
        type="button"
        data-testid=${`paper-overview-open-${row.paper.id}`}
        @click=${() => props.onOpenPaper(row.paper.id)}
      >
        ${row.paper.title}
      </button>
      <div class="paper-overview__stage">
        <span class="profile-overview__status">
          ${row.complete
            ? t("paperOverview.stageComplete")
            : t("paperOverview.personStage", {
                stage: row.currentLabel,
                step: t("paperOverview.stageLabel", {
                  index: String(row.stepIndex + 1),
                  total: String(row.stepCount),
                }),
              })}
        </span>
        ${!row.complete && row.nextLabel
          ? html`<span class="profile-overview__status"
              >${t("paperOverview.next", { step: row.nextLabel })}</span
            >`
          : nothing}
      </div>
      <div class="paper-overview__paper-facts">
        ${row.venue
          ? html`<span class="profile-overview__status">${row.venue}</span>`
          : html`<span class="profile-overview__flag">${t("paperOverview.noVenue")}</span>`}
        ${row.deadline
          ? html`<span class="profile-overview__status">${row.deadline}</span>`
          : nothing}
        ${row.slots
          ? html`<span
              class="ab-num ${row.slots.required_count > row.slots.provided_count
                ? "is-attention"
                : ""}"
              >${row.slots.provided_count}/${row.slots.required_count}</span
            >`
          : nothing}
        <span class="profile-overview__status" data-waiting=${row.progress.waitingOn}
          >${t(`paperOverview.waitingOn.${row.progress.waitingOn}`)}</span
        >
        ${row.openBlockers
          ? html`<span class="profile-overview__flag" data-testid="paper-overview-blocked"
              >${t("paperOverview.blocked", { count: String(row.openBlockers) })}</span
            >`
          : nothing}
        ${row.slots?.escalating
          ? html`<span class="profile-overview__flag">${t("paperOverview.escalating")}</span>`
          : nothing}
        ${row.dormant
          ? html`<span class="paper-overview__chip">${t("paperOverview.dormant")}</span>`
          : nothing}
      </div>
    </li>
  `;
}

/** The person-level flags: what somebody has to chase them about, summed over their papers. */
function renderPersonOutstandingCell(person: PaperPersonRow) {
  const flags = [
    person.openBlockers
      ? html`<span class="profile-overview__flag"
          >${t("paperOverview.blocked", { count: String(person.openBlockers) })}</span
        >`
      : nothing,
    person.escalating
      ? html`<span class="profile-overview__flag">${t("paperOverview.escalating")}</span>`
      : nothing,
    person.dormant
      ? html`<span class="paper-overview__chip"
          >${t("paperOverview.person.dormant", { count: String(person.dormant) })}</span
        >`
      : nothing,
  ].filter((flag) => flag !== nothing);
  if (!flags.length) {
    return html`<span class="muted">—</span>`;
  }
  return html`<div class="paper-overview__flags">${flags}</div>`;
}

/** Fold one person's papers away, or bring them back. */
function togglePerson(props: PaperOverviewProps, key: string) {
  const collapsed = new Set(props.filter.collapsed ?? []);
  if (collapsed.has(key)) {
    collapsed.delete(key);
  } else {
    collapsed.add(key);
  }
  props.onFilterChange({ ...props.filter, collapsed: [...collapsed] });
}

function renderPersonRow(props: PaperOverviewProps, person: PaperPersonRow) {
  const collapsed = (props.filter.collapsed ?? []).includes(person.key);
  return html`
    <tr
      class="profile-overview__row paper-overview__row"
      data-attention=${person.needsAttention}
      data-dormant=${person.inFlight === 0}
      data-person=${person.key}
    >
      <td class="profile-overview__cell">
        <div class="paper-overview__person">
          <!-- The name is the control. Nothing else on the row is a plausible target for "show me
               less of this person", and a separate chevron would be one more thing to aim at on a
               table somebody is scanning. -->
          <button
            type="button"
            class="paper-overview__person-toggle"
            aria-expanded=${collapsed ? "false" : "true"}
            data-testid=${`paper-overview-person-toggle-${person.key}`}
            title=${collapsed
              ? t("paperOverview.person.expandTitle")
              : t("paperOverview.person.collapseTitle")}
            @click=${() => togglePerson(props, person.key)}
          >
            <span class="paper-overview__person-chevron" aria-hidden="true"
              >${collapsed ? "▸" : "▾"}</span
            >
            <strong>${person.name || t("paperOverview.noAuthors")}</strong>
          </button>
          <span class="profile-overview__status"
            >${t("paperOverview.person.papers", { count: String(person.papers.length) })}</span
          >
          ${person.attention
            ? html`<span class="profile-overview__flag"
                >${t("paperOverview.person.attention", { count: String(person.attention) })}</span
              >`
            : nothing}
        </div>
      </td>
      <td class="profile-overview__cell">${renderPersonProgressCell(person)}</td>
      <td class="profile-overview__cell profile-overview__cell--missing">
        ${renderPersonEvidenceCell(person)}
      </td>
      <td class="profile-overview__cell">
        <!-- Folded away, not filtered out. The person's row keeps its progress, evidence and
             outstanding counts, because those are what an administrator is scanning for; it is
             the stack of titles underneath that costs the screen. -->
        ${collapsed
          ? html`<button
              type="button"
              class="paper-overview__papers-folded"
              data-testid=${`paper-overview-person-folded-${person.key}`}
              @click=${() => togglePerson(props, person.key)}
            >
              ${t("paperOverview.person.folded", { count: String(person.papers.length) })}
            </button>`
          : html`<ul class="paper-overview__papers">
              ${person.papers.map((row) => renderPersonPaper(props, row))}
            </ul>`}
      </td>
      <td class="profile-overview__cell">${renderPersonOutstandingCell(person)}</td>
    </tr>
  `;
}
