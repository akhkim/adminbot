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
import {
  projectsListMode,
  renderListMode,
  setProjectsListMode,
  type ProjectsListMode,
} from "./full-views.ts";
import { renderListMore, renderListSearch, windowLists } from "./list-window.ts";
import {
  sortedProjects,
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
  // published, and a list that silently shrinks is how somebody loses a paper. Both groups are drawn
  // the same way -- open, under a heading -- because one list folded and its neighbour open made
  // readers guess which rule applied; length is handled by the shared window, not by folding.
  const { ongoing, completed } = partitionByCompletion(others);
  return html`<section class="projects__others" data-testid="projects-others">
    ${ongoing.length
      ? html`<h3 class="projects__others-title">Not active right now</h3>
          <ul class="projects__other-list">
            ${ongoing.map((paper) => renderOtherRow(state, props, paper))}
          </ul>`
      : nothing}
    ${completed.length
      ? html`<div data-testid="my-work-completed">
          <h3 class="projects__others-title">Completed</h3>
          <ul class="projects__other-list">
            ${completed.map((paper) => renderOtherRow(state, props, paper))}
          </ul>
        </div>`
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
  const rerender = () => props.onRerender?.();
  const listed = windowLists(projects, others);
  return html`${projects.length === 0
    ? html`<p class="projects__empty" data-testid="my-work-empty">
        ${hiddenCount > 0 && others.length === 0
          ? t("myWork.hidden.allHidden")
          : others.length === 0
            ? // A member who has never filed a paper, or was never added to one, lands here: say
              // where papers come from rather than only that there are none.
              "No papers on file for you yet. Add one with Add a project, or ask the paper's lead to list you as an author and it appears here."
            : "No active projects right now. Your other papers are below."}
      </p>`
    : html`<div class="projects__cards">
        ${listed.first.map((project) =>
          projectLink(
            state,
            project.paper_id,
            "project-card",
            `project-card-${project.paper_id}`,
            renderCard(project),
          ),
        )}
      </div>`}
  ${renderOtherPapers(state, props, listed.second)}
  ${renderListMore(listed.shown, listed.matched, rerender)}`;
}

const MODE_LABELS: Record<ProjectsListMode, string> = {
  cards: "Cards",
  sheet: "Sheet",
  flat: "All fields",
};

/**
 * One switch for the three drawings, with the current one marked. Three loose buttons named after
 * what they did ("Fill in as a spreadsheet", "View legacy view") did not say which view was open or
 * how to get back; a segmented switch answers both at a glance.
 */
function renderModeSwitch(mode: ProjectsListMode, count: number, rerender: () => void) {
  const modes: ProjectsListMode[] =
    count > PAPER_GRID_THRESHOLD ? ["cards", "sheet", "flat"] : ["cards", "flat"];
  if (count === 0) {
    return nothing;
  }
  return html`<div class="projects__modes" role="group" aria-label="View">
    ${modes.map(
      (option) =>
        html`<button
          type="button"
          class="projects__mode"
          data-testid=${option === "sheet"
            ? "my-work-open-grid"
            : option === "flat"
              ? "my-work-open-legacy"
              : "my-work-open-cards"}
          aria-pressed=${mode === option ? "true" : "false"}
          @click=${() => {
            setProjectsListMode(option);
            rerender();
          }}
        >
          ${MODE_LABELS[option]}
        </button>`,
    )}
  </div>`;
}

export function renderProjectsOverview(state: OverviewState, props: PaperWorkspaceProps) {
  const hiddenIds = readHiddenPapers(state.memberId);
  // Read once per render: this is synchronous storage, and a thirty-paper list would otherwise
  // parse the same JSON thirty times.
  const { visible, hidden: tucked } = partitionHiddenPapers(
    ownPapers(state, { sorted: true }),
    hiddenIds,
  );
  const projects = sortedProjects(state.myProjects ?? []).filter(
    (project) => !hiddenIds.has(project.paper_id),
  );
  const activeIds = new Set((state.myProjects ?? []).map((project) => project.paper_id));
  // Only meaningful once the active list is in: before that every paper would look inactive.
  const others =
    state.myProjects === null && !state.myProjectsError
      ? []
      : visible.filter((paper) => !activeIds.has(paper.id));
  // Lands on the sheet for an administrator, or for anybody with five or more papers, as the old
  // My Projects page did; everyone else lands on the cards. A press on either button outranks it.
  const mode = projectsListMode({
    count: visible.length,
    admin: props.viewerIsAdmin ?? false,
    // The same key the hidden-papers list reads, so both preferences follow the same person.
    memberId: state.memberId,
  });
  const rerender = () => props.onRerender?.();
  const members = state.adminBotData?.members ?? [];
  return html`<section class="projects" data-testid="projects-overview">
    <!-- One header for every view, in two rows on a phone: what you see (view, add) and how you
         narrow it (search, hide). Each view drew its own search box under a header that already
         wrapped to two rows, so the first paper sat a third of a screen down. -->
    <header class="projects__head">
      ${renderModeSwitch(mode, visible.length, rerender)} ${renderAddButton(state, props)}
      ${renderListSearch(visible.length, rerender)}
      <adminbot-paper-visibility
        class="projects__hide"
        .papers=${visible}
        .memberId=${props.memberId}
        @visibility-changed=${rerender}
      ></adminbot-paper-visibility>
    </header>
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
