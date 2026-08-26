// The professor's morning page: the five things that are hers to do, on one screen.
//
// Everything here is already somewhere else -- the rec-letter queue is on Requests, the adoption
// figure heads Profile Completeness, the timelines are on Time Availability. That is the point.
// Those pages are each built for working through one kind of thing, and the question this page
// answers is the one nobody could answer without opening all five: what is waiting on me.
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
import type { LogisticsRequest, MemberProfileOverviewRow } from "../auth/session.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";

export type ProfessorViewProps = {
  requests: LogisticsRequest[];
  requestsLoading: boolean;
  papers: AdminBotPaperRecord[];
  profiles: MemberProfileOverviewRow[];
  adoption: {
    members: number;
    profile_rate: number;
    project_rate: number;
    signed_in_ever: number;
  } | null;
  /** Proposals waiting on an approver, which are hers alone to give. */
  pendingProposals: number;
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

/** Members whose timeline is thinner than the lab asks for. The list Time Availability is for. */
export function thinTimelines(
  profiles: readonly MemberProfileOverviewRow[],
): MemberProfileOverviewRow[] {
  return profiles
    .filter((row) => row.timeline.total < adminBotTimelineEntryTarget)
    .toSorted((left, right) => left.timeline.total - right.timeline.total);
}

function section(params: {
  id: string;
  title: string;
  count: number;
  sub: string;
  tab: Tab;
  linkLabel: string;
  onOpen: (tab: Tab) => void;
  body: unknown;
}) {
  return html`
    <section class="professor__section" data-testid=${`professor-${params.id}`}>
      <div class="professor__head">
        <div>
          <div class="card-title">${params.title}</div>
          <div class="card-sub">${params.sub}</div>
        </div>
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

export function renderProfessorView(props: ProfessorViewProps) {
  const letters = recLetterQueue(props.requests);
  const drafts = overleafReadingQueue(props.papers);
  const thin = thinTimelines(props.profiles);
  const percent = (rate: number) => `${Math.round(rate * 100)}%`;

  return html`
    <div class="professor">
      ${section({
        id: "letters",
        title: t("professor.letters.title"),
        sub: t("professor.letters.sub"),
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
      })}
      ${section({
        id: "drafts",
        title: t("professor.drafts.title"),
        sub: t("professor.drafts.sub"),
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
      })}
      ${section({
        id: "adoption",
        title: t("professor.adoption.title"),
        sub: t("professor.adoption.sub"),
        count: props.adoption ? props.adoption.members - props.adoption.signed_in_ever : 0,
        tab: "adminbotProfileOverview",
        linkLabel: t("professor.adoption.open"),
        onOpen: props.onOpen,
        body: props.adoption
          ? html`<div class="professor__figures">
              <div>
                <span class="professor__figure ab-num"
                  >${percent(props.adoption.profile_rate)}</span
                >
                <span class="muted">${t("professor.adoption.profile")}</span>
              </div>
              <div>
                <span class="professor__figure ab-num"
                  >${percent(props.adoption.project_rate)}</span
                >
                <span class="muted">${t("professor.adoption.projects")}</span>
              </div>
              <div>
                <span class="professor__figure ab-num"
                  >${props.adoption.signed_in_ever}/${props.adoption.members}</span
                >
                <span class="muted">${t("professor.adoption.signedIn")}</span>
              </div>
            </div>`
          : html`<p class="professor__empty">${t("professor.loading")}</p>`,
      })}
      ${section({
        id: "timelines",
        title: t("professor.timelines.title"),
        sub: t("professor.timelines.sub"),
        count: thin.length,
        tab: "adminbotTimeAvailability",
        linkLabel: t("professor.timelines.open"),
        onOpen: props.onOpen,
        body: rows(
          thin.map(
            (row) => html`<li>
              <strong>${row.name}</strong>
              <span class="muted"
                >${t("professor.timelines.entries", { count: String(row.timeline.total) })}</span
              >
            </li>`,
          ),
          t("professor.timelines.empty"),
        ),
      })}
      ${section({
        id: "approvals",
        title: t("professor.approvals.title"),
        sub: t("professor.approvals.sub"),
        count: props.pendingProposals,
        tab: "adminbot",
        linkLabel: t("professor.approvals.open"),
        onOpen: props.onOpen,
        body: html`<p class="professor__empty">
          ${props.pendingProposals
            ? t("professor.approvals.waiting", { count: String(props.pendingProposals) })
            : t("professor.approvals.empty")}
        </p>`,
      })}
    </div>
  `;
}
