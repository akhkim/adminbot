// My Projects & Papers: the card list at /my-work, or one project's page below it.
import { projectRouteFromPath } from "./model.ts";
import type { ProjectsNavState } from "./nav.ts";
import { renderProjectsOverview } from "./overview.ts";
import { renderProjectPage } from "./page.ts";

export function renderMyProjects(state: ProjectsNavState & { myProjectsLoading: boolean }) {
  const route = projectRouteFromPath(window.location.pathname, state.basePath);
  return route.paperId
    ? renderProjectPage(state, route.paperId, route.tab)
    : renderProjectsOverview(state);
}
