// The project list under "My Projects & Papers" in the sidebar.
//
// One row per active project, with a colored dot for each lane that still has work open and no dot
// for a lane that is done; hovering a dot says which lane it is and what is waiting. "Choose" flips
// the list into checkboxes, which hide a paper from this list and the cards. Hiding is this
// viewer's own preference, kept in the browser: it changes nothing a coauthor sees.
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { readHiddenPapers, toggleHiddenPaper } from "../hidden-papers.ts";
import {
  laneDotTitle,
  navigateToProject,
  openLanes,
  projectRouteFromPath,
  type ProjectSummary,
} from "./model.ts";

export type ProjectsNavState = AppViewState & {
  myProjects: ProjectSummary[] | null;
  myProjectsChoosing: boolean;
  requestUpdate?: () => void;
};

export function renderLaneDots(summary: ProjectSummary) {
  return html`<span class="lane-dots">
    ${openLanes(summary).map(
      ({ lane, open, ready }) =>
        html`<span
          class="lane-dot lane-dot--${lane.branch} ${ready > 0 ? "" : "lane-dot--waiting"}"
          role="img"
          aria-label=${laneDotTitle(lane, open, ready)}
          data-legend=${laneDotTitle(lane, open, ready)}
        ></span>`,
    )}
  </span>`;
}

export function renderProjectsNav(state: ProjectsNavState) {
  const projects = state.myProjects;
  if (!projects || projects.length === 0 || state.settings.navCollapsed) {
    return nothing;
  }
  const hidden = readHiddenPapers(state.memberId);
  const current =
    state.tab === "myWork"
      ? projectRouteFromPath(window.location.pathname, state.basePath).paperId
      : null;
  const rerender = () => state.requestUpdate?.();
  if (state.myProjectsChoosing) {
    return html`<div class="projects-nav" data-testid="projects-nav-choose">
      ${projects.map(
        (project) =>
          html`<label class="projects-nav__choice">
            <input
              type="checkbox"
              .checked=${!hidden.has(project.paper_id)}
              @change=${() => {
                toggleHiddenPaper(state.memberId, project.paper_id);
                rerender();
              }}
            />
            <span>${project.alias || project.title}</span>
          </label>`,
      )}
      <button
        type="button"
        class="projects-nav__toggle"
        @click=${() => {
          state.myProjectsChoosing = false;
          rerender();
        }}
      >
        Done
      </button>
    </div>`;
  }
  const visible = projects.filter((project) => !hidden.has(project.paper_id));
  return html`<div class="projects-nav" data-testid="projects-nav">
    ${visible.map(
      (project) =>
        html`<a
          class="projects-nav__item ${current === project.paper_id ? "is-active" : ""}"
          href=${`${state.basePath}/my-work/${encodeURIComponent(project.paper_id)}`}
          title=${project.title}
          data-testid=${`projects-nav-${project.paper_id}`}
          @click=${(event: MouseEvent) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
              return;
            }
            event.preventDefault();
            navigateToProject(state, project.paper_id);
          }}
        >
          <span class="projects-nav__name">${project.alias || project.title}</span>
          ${renderLaneDots(project)}
        </a>`,
    )}
    <button
      type="button"
      class="projects-nav__toggle"
      @click=${() => {
        state.myProjectsChoosing = true;
        rerender();
      }}
    >
      ${hidden.size > 0 ? `Choose papers (${hidden.size} hidden)` : "Choose papers"}
    </button>
  </div>`;
}
