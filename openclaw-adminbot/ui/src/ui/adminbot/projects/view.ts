// My Projects & Papers: the card list at /my-work, or one project's page below it.
import { resetDecisionBannerState } from "./decisions.ts";
import { resetProjectDetailsState } from "./details.ts";
import { resetProjectsListViews } from "./full-views.ts";
import { projectRouteFromPath } from "./model.ts";
import type { ProjectsNavState } from "./nav.ts";
import { renderProjectsOverview } from "./overview.ts";
import { renderProjectPage, resetProjectPageState } from "./page.ts";
import type { PaperWorkspaceProps } from "./workspace.ts";

export function renderMyProjects(
  state: ProjectsNavState & { myProjectsLoading: boolean },
  props: PaperWorkspaceProps,
) {
  const route = projectRouteFromPath(window.location.pathname, state.basePath);
  return route.paperId
    ? renderProjectPage(state, props, route.paperId, route.tab)
    : renderProjectsOverview(state, props);
}

/**
 * Discards everything these pages hold outside the app state -- pending autosaves, half-typed
 * flat-form and sheet edits, decision answers in progress, which checklists were asked for --
 * before a different member can use this browser session.
 */
export function resetProjectsSessionState(): void {
  resetProjectDetailsState();
  resetDecisionBannerState();
  resetProjectsListViews();
  resetProjectPageState();
}
