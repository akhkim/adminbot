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
  const letters = recLetterQueue(props.requests);
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
          : rows(
              letters.map(
                (request) => html`<li>
                  <strong>${request.member_name}</strong>
                  <span class="muted"
                    >${request.schools?.length
                      ? t("professor.letters.schools", { count: String(request.schools.length) })
                      : t("professor.letters.noSchools")}</span
                  >
                  ${request.deadline_at
                    ? html`<span class="professor__when">${request.deadline_at.slice(0, 10)}</span>`
                    : nothing}
                </li>`,
              ),
              t("professor.letters.empty"),
            ),
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
