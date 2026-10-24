// The card list at /my-work: one compact card per active project, saying where the paper is aimed
// and what is next on it. Opening a card goes to the project's own page.
//
// Around the cards sits what is addressed to the reader across all of their papers: adding a
// project, the decision banners, the blocker roll-up, what the last write or nudge did, the papers
// that are not active right now (finished, rejected, dormant), the ones hidden from this list, and
// the two whole-page drawings -- the flat view and the sheet -- for working across every paper at
// once.
import "../paper-visibility.ts";
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import { clearHiddenPapers, partitionHiddenPapers, readHiddenPapers } from "../hidden-papers.ts";
import { partitionByCompletion } from "../paper-completion.ts";
import { PAPER_GRID_THRESHOLD } from "../paper-grid.ts";
import { renderAddButton, renderAddForm } from "./add-form.ts";
import { renderBlockerBoard } from "./blocker-report.ts";
import { renderDecisionBanners } from "./decisions.ts";
import { projectsListMode, renderListMode, setProjectsListMode } from "./full-views.ts";
import {
  compareProjects,
  navigateToProject,
  ownPapers,
  PROJECT_LANES,
  stepLabel,
  venuePosition,
  type ProjectSummary,
} from "./model.ts";
import { renderLaneDots, type ProjectsNavState } from "./nav.ts";
import { renderOutstanding } from "./progress.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

const TODOS_ON_CARD = 4;

type OverviewState = ProjectsNavState & { myProjectsLoading: boolean };

function renderCard(project: ProjectSummary) {
  const laneLabel = (branch: string) =>
    PROJECT_LANES.find((lane) => lane.branch === branch)?.label ?? branch;
  const todos = project.todos.slice(0, TODOS_ON_CARD);
  return html`
    <h3 class="project-card__title">${project.title}</h3>
    ${project.alias ? html`<p class="project-card__alias">#${project.alias}</p>` : nothing}
    <p class="project-card__venue">${venuePosition(project)}</p>
    <!-- The count and the deadline the old card's subtitle carried: how much is on file, and how
         soon it is due. -->
    <p class="project-card__meta" data-testid=${`project-card-meta-${project.paper_id}`}>
      <span class="ab-num">${project.provided_count}/${project.required_count}</span> on file
      ${project.deadline
        ? html`· due <span class="ab-num">${project.deadline.slice(0, 10)}</span>`
        : nothing}
    </p>
    ${renderLaneDots(project)}
    ${todos.length
      ? html`<ul class="project-card__todos">
          ${todos.map(
            (todo) =>
              html`<li class=${todo.ready ? "is-ready" : "is-waiting"}>
                <span class="lane-dot lane-dot--${todo.lane}" aria-hidden="true"></span>
                <span>${todo.label}</span>
                <small>${todo.ready ? "now" : laneLabel(todo.lane)}</small>
              </li>`,
          )}
          ${project.todos.length > TODOS_ON_CARD
            ? html`<li class="project-card__more">
                +${project.todos.length - TODOS_ON_CARD} more
              </li>`
            : nothing}
        </ul>`
      : html`<p class="project-card__done">Nothing open. Everything is in.</p>`}
  `;
}

function projectLink(
  state: OverviewState,
  paperId: string,
  className: string,
  testId: string,
  body: unknown,
) {
  return html`<a
    class=${className}
    href=${`${state.basePath}/my-work/${encodeURIComponent(paperId)}`}
    data-testid=${testId}
    @click=${(event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
        return;
      }
      event.preventDefault();
      navigateToProject(state, paperId);
    }}
    >${body}</a
  >`;
}

/**
 * One row for a paper the card list leaves out. GET /my/projects lists active work only, so a
 * finished, rejected or dormant paper has no card -- but it is still the member's, still has a page,
 * and a rejected one is waiting for a new venue. The status line is the service's own overview row.
 */
function renderOtherRow(
  state: OverviewState,
  props: PaperWorkspaceProps,
  paper: AdminBotPaperRecord,
) {
  const row = props.overview.find((candidate) => candidate.paper_id === paper.id);
  return html`<li class="projects__other" data-testid=${`my-work-item-${paper.id}`}>
    ${projectLink(
      state,
      paper.id,
      "projects__other-link",
      `project-other-${paper.id}`,
      html`<span class="projects__other-title">${paper.title}</span>`,
    )}
    <span class="projects__other-meta">${stepLabel(paper.current_step)}</span>
    ${row ? renderOutstanding(row) : nothing}
  </li>`;
}

function renderOtherPapers(
  state: OverviewState,
  props: PaperWorkspaceProps,
  others: AdminBotPaperRecord[],
) {
  if (others.length === 0) {
    return nothing;
  }
  // Finished papers stay on the page rather than disappearing: they are the record of what the lab
  // published, and a list that silently shrinks is how somebody loses a paper.
  const { ongoing, completed } = partitionByCompletion(others);
  return html`<section class="projects__others" data-testid="projects-others">
    ${ongoing.length
      ? html`<h3 class="projects__others-title">Not active right now</h3>
          <ul class="projects__other-list">
            ${ongoing.map((paper) => renderOtherRow(state, props, paper))}
          </ul>`
      : nothing}
    ${completed.length
      ? html`<details class="my-work__done" data-testid="my-work-completed">
          <summary class="my-work__done-summary">Completed (${completed.length})</summary>
          <ul class="projects__other-list">
            ${completed.map((paper) => renderOtherRow(state, props, paper))}
          </ul>
        </details>`
      : nothing}
  </section>`;
}

function renderCards(
  state: OverviewState,
  props: PaperWorkspaceProps,
  projects: ProjectSummary[],
  others: AdminBotPaperRecord[],
  hiddenCount: number,
) {
  if (state.myProjectsError) {
    return html`<p class="my-work__error-line" role="alert" data-testid="projects-error">
        ${state.myProjectsError}
        <button
          type="button"
          class="btn btn--sm"
          @click=${() => {
            // Clearing the error is what lets the next render read the list again.
            state.myProjectsError = null;
            props.onRerender?.();
          }}
        >
          Try again
        </button>
      </p>
      ${renderOtherPapers(state, props, others)}`;
  }
  if (state.myProjects === null) {
    return html`<p class="projects__empty">Loading your projects…</p>`;
  }
  return html`${projects.length === 0
    ? html`<p class="projects__empty">
        ${hiddenCount > 0 && others.length === 0
          ? t("myWork.hidden.allHidden")
          : "No active projects. Start one with Add a project."}
      </p>`
    : html`<div class="projects__cards">
        ${projects.map((project) =>
          projectLink(
            state,
            project.paper_id,
            "project-card",
            `project-card-${project.paper_id}`,
            renderCard(project),
          ),
        )}
      </div>`}
  ${renderOtherPapers(state, props, others)}`;
}

export function renderProjectsOverview(state: OverviewState, props: PaperWorkspaceProps) {
  const hiddenIds = readHiddenPapers(state.memberId);
  // Read once per render: this is synchronous storage, and a thirty-paper list would otherwise
  // parse the same JSON thirty times.
  const { visible, hidden: tucked } = partitionHiddenPapers(
    ownPapers(state).sort(compareProjects),
    hiddenIds,
  );
  const projects = (state.myProjects ?? [])
    .filter((project) => !hiddenIds.has(project.paper_id))
    .sort(compareProjects);
  const activeIds = new Set((state.myProjects ?? []).map((project) => project.paper_id));
  // Only meaningful once the active list is in: before that every paper would look inactive.
  const others =
    state.myProjects === null && !state.myProjectsError
      ? []
      : visible.filter((paper) => !activeIds.has(paper.id));
  // Lands on the sheet for an administrator, or for anybody with five or more papers, as the old
  // My Projects page did; everyone else lands on the cards. A press on either button outranks it.
  const mode = projectsListMode({ count: visible.length, admin: props.viewerIsAdmin ?? false });
  const rerender = () => props.onRerender?.();
  const members = state.adminBotData?.members ?? [];
  return html`<section class="projects" data-testid="projects-overview">
    <header class="projects__head">
      <p class="projects__lede">
        Your active projects. A dot is a lane with work still open; hover it for what it is.
      </p>
      <div class="my-work__section-actions">
        ${visible.length > PAPER_GRID_THRESHOLD
          ? html`<button
              type="button"
              class="btn btn--sm"
              data-testid="my-work-open-grid"
              aria-pressed=${mode === "sheet" ? "true" : "false"}
              @click=${() => {
                setProjectsListMode("sheet");
                rerender();
              }}
            >
              Fill in as a spreadsheet (${visible.length})
            </button>`
          : nothing}
        ${visible.length
          ? html`<button
              type="button"
              class="btn btn--sm"
              data-testid="my-work-open-legacy"
              aria-pressed=${mode === "flat" ? "true" : "false"}
              @click=${() => {
                setProjectsListMode("flat");
                rerender();
              }}
            >
              View legacy view (${visible.length})
            </button>`
          : nothing}
        ${renderAddButton(state, props)}
      </div>
    </header>
    <adminbot-paper-visibility
      .papers=${visible}
      .memberId=${props.memberId}
      @visibility-changed=${rerender}
    ></adminbot-paper-visibility>
    ${state.myWorkProjectDraft !== null ? renderAddForm(state, props) : nothing}
    ${renderDecisionBanners(visible, props, members)} ${renderBlockerBoard(state, visible)}
    ${props.slotsNotice
      ? html`<p class="my-work__notice-line" role="status">${props.slotsNotice}</p>`
      : nothing}
    ${props.slotsError
      ? html`<p class="my-work__error-line" role="alert">${props.slotsError}</p>`
      : nothing}
    ${mode === "cards"
      ? renderCards(state, props, projects, others, tucked.length)
      : renderListMode(state, props, visible, mode)}
    <!-- Says how many are held back and offers them straight back. A list that silently drops
         rows is indistinguishable from one that lost them. -->
    ${tucked.length
      ? html`<p class="my-work__hidden-line" data-testid="my-work-hidden-line">
          ${t("myWork.hidden.count", { count: String(tucked.length) })}
          <button
            type="button"
            class="btn btn--sm"
            data-testid="my-work-show-hidden"
            @click=${() => {
              clearHiddenPapers(props.memberId);
              rerender();
            }}
          >
            ${t("myWork.hidden.showAll")}
          </button>
        </p>`
      : nothing}
    <p class="my-work__notice">${t("myWork.items.syncNotice")}</p>
  </section>`;
}
