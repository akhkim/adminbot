// The project list under "My Projects & Papers" in the sidebar.
//
// One row per active project, with a colored dot for each lane that still has work open and no dot
// for a lane that is done; hovering a dot says which lane it is and what is waiting. Papers hidden
// with "Hide papers" on My Work are left out here too; that is the one place to hide or restore
// them, so the sidebar stays a list of links.
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { readHiddenPapers } from "../hidden-papers.ts";
import {
  sortedProjects,
  laneDotTitle,
  navigateToProject,
  openLanes,
  projectRouteFromPath,
  type ProjectSummary,
} from "./model.ts";

/** Papers listed in the sidebar before "All N papers". Enough for the ones in hand this week. */
const NAV_ITEMS = 8;

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
  return html`<details class="projects-nav-disclosure">
    <summary class="projects-nav__toggle">Papers</summary>
    ${renderProjectsNavItems(state, sortedProjects(projects))}
  </details>`;
}

function renderProjectsNavItems(state: ProjectsNavState, projects: ProjectSummary[]) {
  const hidden = readHiddenPapers(state.memberId);
  const current =
    state.tab === "myWork"
      ? projectRouteFromPath(window.location.pathname, state.basePath).paperId
      : null;
  const visible = projects.filter((project) => !hidden.has(project.paper_id));
  // A sidebar is for jumping between the few papers in hand, not for listing all of them: past
  // NAV_ITEMS the rest are one press away on My Work, which has search. The current paper is
  // always kept so the highlight never disappears off the end.
  const listed = visible.slice(0, NAV_ITEMS);
  const currentProject = visible.find((project) => project.paper_id === current);
  if (currentProject && !listed.includes(currentProject)) {
    listed.push(currentProject);
  }
  return html`<div class="projects-nav" data-testid="projects-nav">
    ${listed.map(
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
    ${visible.length > listed.length
      ? html`<a
          class="projects-nav__item projects-nav__all"
          href=${`${state.basePath}/my-work`}
          data-testid="projects-nav-all"
          @click=${(event: MouseEvent) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
              return;
            }
            event.preventDefault();
            navigateToProject(state, null);
          }}
          >All ${visible.length} papers</a
        >`
      : nothing}
  </div>`;
}
