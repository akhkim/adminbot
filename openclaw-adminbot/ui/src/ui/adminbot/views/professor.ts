// The professor's morning page: the things that are hers to do, on one screen.
//
// Everything here is already somewhere else -- the rec-letter queue is on Requests, the adoption
// columns head Profile Completeness and Time Availability. That is the point. Those pages are each
// built for working through one kind of thing, and the question this page answers is the one nobody
// could answer without opening all of them: what is waiting on me.
//
// So it aggregates and links; it does not re-implement. Every section is a count, the few rows
// worth seeing, and the way through to the page that actually does the work. A section that grew
// its own editing controls would be a second place to do the same job, drifting from the first.
import { html, nothing } from "lit";
import {
  adminBotLogisticsSettledStatuses,
  adminBotTimelineEntryTarget,
} from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import type { Tab } from "../../navigation.ts";
import type {
  EscalatedNudgeRow,
  LogisticsRequest,
  MemberProfileOverviewRow,
} from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";

export type ProfessorViewProps = {
  requests: LogisticsRequest[];
  requestsLoading: boolean;
  papers: AdminBotPaperRecord[];
  profiles: MemberProfileOverviewRow[];
  /**
   * Nudges the lab already gave up on chasing automatically.
   *
   * The one section here that is not a view onto another page: every other queue links somewhere
   * built for working through it, and this one has nowhere to go, because the next move is her
   * writing to a person. Which is exactly why it never existed -- the escalation pass stamped
   * these every weekday, said them once in Slack, and kept no list.
   */
  escalated: EscalatedNudgeRow[];
  onOpen: (tab: Tab) => void;
};

/** How many rows a section shows before it stops being a summary. */
const PREVIEW_ROWS = 5;

/** Steps at or before submission: the window in which reading the draft still changes it. */
const PRE_SUBMISSION_STEPS = new Set(["brainstorming_docs", "overleaf_writing", "submission"]);

const SETTLED = new Set<string>(adminBotLogisticsSettledStatuses);

/**
 * Rec letter requests still waiting on the lab, soonest first.
 *
 * `deadline_at` is derived on write from whichever school row is soonest, so this sorts by the same
 * instant the Requests queue does -- two orderings of one queue is how a letter gets missed.
 */
export function recLetterQueue(requests: readonly LogisticsRequest[]): LogisticsRequest[] {
  return requests
    .filter((request) => request.kind === "recommendation_letters" && !SETTLED.has(request.status))
    .toSorted((left, right) =>
      (left.deadline_at ?? "9999").localeCompare(right.deadline_at ?? "9999"),
    );
}

/**
 * How far off a letter is, as the four answers that change what she does about it.
 *
 * A sorted list already put the soonest letter at the top, which is not the same as saying it is
 * late. "2026-02-01" reads as a date whatever today is; "overdue" and "in 3 days" read as an
 * instruction. The names are relative windows rather than months so the section says the same thing
 * in November as it does in June.
 */
export const REC_LETTER_BUCKETS = ["overdue", "week", "month", "later", "undated"] as const;

export type RecLetterBucket = (typeof REC_LETTER_BUCKETS)[number];

/** Days out at which "soon" stops and the rest of the term begins. */
const REC_LETTER_WEEK_DAYS = 7;
const REC_LETTER_MONTH_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RecLetterDue = {
  request: LogisticsRequest;
  bucket: RecLetterBucket;
  /**
   * Whole days between now and the deadline, negative once it is past.
   *
   * Absent when the request carries no deadline yet, which is a real state and not a zero: a
   * member who has not filled in a school's dates has still asked for the letter.
   */
  daysAway?: number;
};

/**
 * The letter queue with each request placed against today.
 *
 * Order is unchanged -- soonest first, undated last -- because it is the same queue the Requests
 * page serves and reordering it here would give the lab two answers to "what is next". The only
 * thing added is where each request falls relative to now, which is what the deadline was for.
 */
export function recLetterDeadlineQueue(
  requests: readonly LogisticsRequest[],
  now: Date = new Date(),
): RecLetterDue[] {
  const nowMs = now.getTime();
  return recLetterQueue(requests).map((request) => {
    const deadlineMs = request.deadline_at ? Date.parse(request.deadline_at) : Number.NaN;
    if (!Number.isFinite(deadlineMs)) {
      // An unparseable stamp is treated as no stamp rather than as the epoch, which would file a
      // typo at the top of the overdue list and bury the letters that really are late.
      return { request, bucket: "undated" };
    }
    const daysAway = Math.ceil((deadlineMs - nowMs) / DAY_MS);
    const bucket: RecLetterBucket =
      deadlineMs < nowMs
        ? "overdue"
        : daysAway <= REC_LETTER_WEEK_DAYS
          ? "week"
          : daysAway <= REC_LETTER_MONTH_DAYS
            ? "month"
            : "later";
    return { request, bucket, daysAway };
  });
}

export type RecLetterGroup = {
  bucket: RecLetterBucket;
  /** Everything in the bucket, which is not the same as everything drawn: see `rows`. */
  total: number;
  /** The slice this section has room for, already taken from the front of the whole queue. */
  rows: RecLetterDue[];
};

/**
 * The queue as buckets, capped as one list rather than bucket by bucket.
 *
 * The cap is taken across the whole queue before grouping, so a term with eleven letters due next
 * month cannot push an overdue one off the screen, and `total` still reports the real size of each
 * bucket -- a heading that said "3" while listing 3 of 11 would be the lie the cap exists to avoid.
 * Empty buckets are dropped: "Overdue 0" is a row of furniture, and the count above the section
 * already says when there is nothing at all.
 */
export function recLetterGroups(
  due: readonly RecLetterDue[],
  limit = PREVIEW_ROWS,
): RecLetterGroup[] {
  const shown = due.slice(0, limit);
  return REC_LETTER_BUCKETS.map((bucket) => ({
    bucket,
    total: due.filter((entry) => entry.bucket === bucket).length,
    rows: shown.filter((entry) => entry.bucket === bucket),
  })).filter((group) => group.total > 0);
}

/** "in 3 days" / "2 days ago" / "today", or nothing at all when there is no deadline to describe. */
export function recLetterDueLabel(due: RecLetterDue): string {
  if (due.daysAway === undefined) {
    return t("professor.letters.due.none");
  }
  if (due.daysAway === 0) {
    return t("professor.letters.due.today");
  }
  return due.daysAway > 0
    ? t("professor.letters.due.in", { count: String(due.daysAway) })
    : t("professor.letters.due.ago", { count: String(-due.daysAway) });
}

export type OverleafRead = {
  paper: AdminBotPaperRecord;
  url: string;
  deadline: string;
};

/**
 * Drafts that are readable and not yet submitted.
 *
 * A link and a deadline, because those are the two facts that decide whether to open it now. A
 * paper past submission is excluded: reading it then is a different, slower kind of useful, and
 * mixing the two makes the urgent half unreadable.
 */
export function overleafReadingQueue(papers: readonly AdminBotPaperRecord[]): OverleafRead[] {
  return papers
    .flatMap((paper) => {
      const url =
        paper.artifacts?.overleaf_edit_url?.trim() || paper.artifacts?.overleaf_view_url?.trim();
      if (!url || !PRE_SUBMISSION_STEPS.has(paper.current_step)) {
        return [];
      }
      return [{ paper, url, deadline: paper.deadline?.trim() ?? "" }];
    })
    .toSorted(
      (left, right) =>
        (left.deadline || "9999").localeCompare(right.deadline || "9999") ||
        left.paper.title.localeCompare(right.paper.title),
    );
}

/**
 * Who is still on the hook for using AdminBot themselves.
 *
 * Alumni are out of every adoption column: they have left, so a row of theirs that stays blank is
 * not a reminder anybody is going to send. Everyone else stays, external collaborators included --
 * the lab does chase them, and dropping them would quietly shrink the count this section exists to
 * show.
 */
export function adoptionCandidates(
  profiles: readonly MemberProfileOverviewRow[],
): MemberProfileOverviewRow[] {
  return profiles.filter((row) => row.status !== "alumni");
}

/** Members with mandatory profile fields still blank, emptiest record first. */
export function incompleteProfiles(
  profiles: readonly MemberProfileOverviewRow[],
): MemberProfileOverviewRow[] {
  return adoptionCandidates(profiles)
    .filter((row) => row.missing_fields.length > 0)
    .toSorted((left, right) => right.missing_fields.length - left.missing_fields.length);
}

/** Members whose timeline is thinner than the lab asks for. The list Time Availability is for. */
export function thinTimelines(
  profiles: readonly MemberProfileOverviewRow[],
): MemberProfileOverviewRow[] {
  return adoptionCandidates(profiles)
    .filter((row) => row.timeline.total < adminBotTimelineEntryTarget)
    .toSorted((left, right) => left.timeline.total - right.timeline.total);
}

/**
 * Members with a paper carrying no update they wrote themselves.
 *
 * Somebody with no papers at all is not behind on anything, so they are not in this column.
 */
export function unattendedProjects(
  profiles: readonly MemberProfileOverviewRow[],
): MemberProfileOverviewRow[] {
  const behind = (row: MemberProfileOverviewRow) => row.projects.total - row.projects.self_updated;
  return adoptionCandidates(profiles)
    .filter((row) => row.projects.total > 0 && behind(row) > 0)
    .toSorted((left, right) => behind(right) - behind(left));
}

type AdoptionColumn = {
  id: "profile" | "timeline" | "papers";
  label: string;
  rows: MemberProfileOverviewRow[];
  detail: (row: MemberProfileOverviewRow) => string;
};

/**
 * The three columns, with the settled ones last.
 *
 * A column nobody has to act on is still worth showing -- it is how you see that the answer is
 * "nobody" rather than "not loaded yet" -- but it should not sit between two columns that do need
 * work.
 */
export function adoptionColumns(profiles: readonly MemberProfileOverviewRow[]): AdoptionColumn[] {
  const columns: AdoptionColumn[] = [
    {
      id: "profile",
      label: t("professor.adoption.column.profile"),
      rows: incompleteProfiles(profiles),
      detail: (row) =>
        t("professor.adoption.missing", { count: String(row.missing_fields.length) }),
    },
    {
      id: "timeline",
      label: t("professor.adoption.column.timeline"),
      rows: thinTimelines(profiles),
      detail: (row) => t("professor.adoption.entries", { count: String(row.timeline.total) }),
    },
    {
      id: "papers",
      label: t("professor.adoption.column.papers"),
      rows: unattendedProjects(profiles),
      detail: (row) =>
        t("professor.adoption.papersDetail", {
          count: String(row.projects.total - row.projects.self_updated),
          total: String(row.projects.total),
        }),
    },
  ];
  return columns.toSorted((left, right) => Number(!left.rows.length) - Number(!right.rows.length));
}

function section(params: {
  id: string;
  title: string;
  count: number;
  tab: Tab;
  linkLabel: string;
  onOpen: (tab: Tab) => void;
  body: unknown;
}) {
  return html`
    <section class="professor__section" data-testid=${`professor-${params.id}`}>
      <div class="professor__head">
        <div class="card-title">${params.title}</div>
        <span class="professor__count ab-num" data-empty=${params.count === 0 ? "true" : "false"}
          >${params.count}</span
        >
      </div>
      ${params.body}
      <button
        class="btn btn--sm professor__open"
        type="button"
        data-testid=${`professor-open-${params.id}`}
        @click=${() => params.onOpen(params.tab)}
      >
        ${params.linkLabel}
        <span aria-hidden="true">${icons.chevronRight}</span>
      </button>
    </section>
  `;
}

function rows(items: unknown[], empty: string) {
  if (!items.length) {
    return html`<p class="professor__empty">${empty}</p>`;
  }
  return html`<ul class="professor__list">
    ${items.slice(0, PREVIEW_ROWS)}
    ${items.length > PREVIEW_ROWS
      ? html`<li class="muted">
          ${t("professor.more", { count: String(items.length - PREVIEW_ROWS) })}
        </li>`
      : nothing}
  </ul>`;
}

/**
 * The letter queue drawn as its deadline buckets.
 *
 * Every row still names the member and how many schools are on the request -- that has not changed,
 * and it is what decides how long the letter takes to write. What is new is the heading it sits
 * under and the relative date beside it, so "Overdue" is answerable at a glance instead of being
 * something she works out from four ISO dates.
 */
function letterBody(due: readonly RecLetterDue[]) {
  if (!due.length) {
    return html`<p class="professor__empty">${t("professor.letters.empty")}</p>`;
  }
  const groups = recLetterGroups(due);
  const hidden = due.length - groups.reduce((sum, group) => sum + group.rows.length, 0);
  return html`<div class="professor__buckets">
    ${groups.map(
      (group) => html`<div
        class="professor__bucket"
        data-testid=${`professor-letters-${group.bucket}`}
        data-bucket=${group.bucket}
      >
        <div class="professor__column-head">
          <span>${t(`professor.letters.bucket.${group.bucket}`)}</span>
          <span class="ab-num">${group.total}</span>
        </div>
        ${group.rows.length
          ? html`<ul class="professor__list">
              ${group.rows.map(
                (entry) => html`<li>
                  <strong>${entry.request.member_name}</strong>
                  <span class="muted"
                    >${entry.request.schools?.length
                      ? t("professor.letters.schools", {
                          count: String(entry.request.schools.length),
                        })
                      : t("professor.letters.noSchools")}</span
                  >
                  <span class="professor__when">${recLetterDueLabel(entry)}</span>
                </li>`,
              )}
            </ul>`
          : nothing}
      </div>`,
    )}
    ${hidden > 0
      ? html`<p class="professor__bucket-more muted">
          ${t("professor.more", { count: String(hidden) })}
        </p>`
      : nothing}
  </div>`;
}

function adoptionBody(profiles: readonly MemberProfileOverviewRow[]) {
  return html`<div class="professor__columns">
    ${adoptionColumns(profiles).map(
      (column) => html`<div
        class="professor__column"
        data-testid=${`professor-adoption-${column.id}`}
        data-empty=${column.rows.length === 0 ? "true" : "false"}
      >
        <div class="professor__column-head">
          <span>${column.label}</span>
          <span class="ab-num">${column.rows.length}</span>
        </div>
        ${rows(
          column.rows.map(
            (row) => html`<li>
              <strong>${row.name}</strong>
              <span class="muted">${column.detail(row)}</span>
            </li>`,
          ),
          t("professor.adoption.empty"),
        )}
      </div>`,
    )}
  </div>`;
}

export function renderProfessorView(props: ProfessorViewProps) {
  const letters = recLetterDeadlineQueue(props.requests);
  const drafts = overleafReadingQueue(props.papers);
  // Somebody short on two counts is still one person to remind, so the headline number is people,
  // not rows.
  const toRemind = new Set(
    adoptionColumns(props.profiles).flatMap((column) => column.rows.map((row) => row.id)),
  );

  const sections = [
    {
      settled: props.escalated.length === 0,
      body: section({
        id: "escalated",
        title: t("professor.escalated.title"),
        count: props.escalated.length,
        // Announcements is where she writes to somebody, which is the whole point of an
        // escalation: the automatic chasing is finished and it now wants a person.
        tab: "adminbotAnnouncements",
        linkLabel: t("professor.escalated.open"),
        onOpen: props.onOpen,
        body: rows(
          props.escalated.map(
            (row) => html`<li>
              <strong>${row.name}</strong>
              <span class="muted"
                >${row.items.length === 1
                  ? (row.items[0]?.title ?? "")
                  : t("professor.escalated.items", { count: String(row.items.length) })}</span
              >
              ${row.escalatedAt
                ? html`<span class="professor__when">${row.escalatedAt.slice(0, 10)}</span>`
                : nothing}
            </li>`,
          ),
          t("professor.escalated.empty"),
        ),
      }),
    },
    {
      // A queue still loading is not an empty one, so it holds its place rather than sinking.
      settled: !props.requestsLoading && letters.length === 0,
      body: section({
        id: "letters",
        title: t("professor.letters.title"),
        count: letters.length,
        tab: "adminbotRecLetters",
        linkLabel: t("professor.letters.open"),
        onOpen: props.onOpen,
        body: props.requestsLoading
          ? html`<p class="professor__empty">${t("professor.loading")}</p>`
          : letterBody(letters),
      }),
    },
    {
      settled: drafts.length === 0,
      body: section({
        id: "drafts",
        title: t("professor.drafts.title"),
        count: drafts.length,
        tab: "adminbotPapers",
        linkLabel: t("professor.drafts.open"),
        onOpen: props.onOpen,
        body: rows(
          drafts.map(
            (draft) => html`<li>
              <a href=${draft.url} target="_blank" rel="noreferrer noopener"
                >${draft.paper.title}</a
              >
              <span class="muted">${draft.paper.authors.join(", ")}</span>
              ${draft.deadline
                ? html`<span class="professor__when">${draft.deadline}</span>`
                : nothing}
            </li>`,
          ),
          t("professor.drafts.empty"),
        ),
      }),
    },
    {
      settled: toRemind.size === 0,
      body: section({
        id: "adoption",
        title: t("professor.adoption.title"),
        count: toRemind.size,
        tab: "adminbotProfileOverview",
        linkLabel: t("professor.adoption.open"),
        onOpen: props.onOpen,
        body: adoptionBody(props.profiles),
      }),
    },
  ];

  // Settled sections keep their relative order but sink below the ones with something in them: the
  // page is read top down, and nothing outstanding should not cost the first screen.
  return html`
    <div class="professor">
      ${sections
        .toSorted((left, right) => Number(left.settled) - Number(right.settled))
        .map((entry) => entry.body)}
    </div>
  `;
}
