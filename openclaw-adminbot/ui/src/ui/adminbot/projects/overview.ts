// The card list at /my-work: one compact card per active project, saying where the paper is aimed
// and what is next on it. Opening a card goes to the project's own page.
import { html, nothing } from "lit";
import { adminBotNormalizePaperAlias } from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { saveAdminBotPaper } from "../controllers/admin.ts";
import { paperSteps } from "../data/paper-steps.ts";
import { readHiddenPapers } from "../hidden-papers.ts";
import { findOwnMember } from "../views/profile-fields.ts";
import { navigateToProject, PROJECT_LANES, venuePosition, type ProjectSummary } from "./model.ts";
import { renderLaneDots, type ProjectsNavState } from "./nav.ts";

const TODOS_ON_CARD = 4;

function renderCard(project: ProjectSummary) {
  const laneLabel = (branch: string) =>
    PROJECT_LANES.find((lane) => lane.branch === branch)?.label ?? branch;
  const todos = project.todos.slice(0, TODOS_ON_CARD);
  return html`
    <h3 class="project-card__title">${project.title}</h3>
    ${project.alias ? html`<p class="project-card__alias">#${project.alias}</p>` : nothing}
    <p class="project-card__venue">${venuePosition(project)}</p>
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

function renderNewProject(state: ProjectsNavState & { myProjectsNewOpen?: boolean }) {
  if (!state.myProjectsNewOpen) {
    return html`<button
      type="button"
      class="btn"
      data-testid="projects-new"
      @click=${() => {
        state.myProjectsNewOpen = true;
        state.requestUpdate?.();
      }}
    >
      New project
    </button>`;
  }
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const title = String(form.get("title") ?? "").trim();
    const alias = adminBotNormalizePaperAlias(String(form.get("alias") ?? "")) ?? "";
    const startedOn = String(form.get("startedOn") ?? "");
    if (!title || !startedOn) {
      return;
    }
    const member = findOwnMember(state);
    void saveAdminBotPaper(state, {
      // The service upserts by id and a new paper has none yet, so it is slugged from the title.
      id: title
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/(^-|-$)/gu, "")
        .slice(0, 60),
      title,
      alias,
      startedOn,
      authors: member?.name?.trim() ? [member.name.trim()] : [],
      currentStep: paperSteps[0],
    }).then(() => {
      state.myProjectsNewOpen = false;
      state.myProjects = null;
      state.requestUpdate?.();
    });
  };
  return html`<form class="project-new" @submit=${submit} data-testid="projects-new-form">
    <label>Title <input name="title" required maxlength="300" /></label>
    <label>Short name <input name="alias" placeholder="e.g. group-align" maxlength="40" /></label>
    <label>Started <input name="startedOn" type="date" required /></label>
    <button type="submit" class="btn primary">Create</button>
    <button
      type="button"
      class="btn"
      @click=${() => {
        state.myProjectsNewOpen = false;
        state.requestUpdate?.();
      }}
    >
      Cancel
    </button>
  </form>`;
}

export function renderProjectsOverview(state: ProjectsNavState & { myProjectsLoading: boolean }) {
  const hidden = readHiddenPapers(state.memberId);
  const projects = (state.myProjects ?? []).filter((project) => !hidden.has(project.paper_id));
  return html`<section class="projects" data-testid="projects-overview">
    <header class="projects__head">
      <p class="projects__lede">
        Your active projects. A dot is a lane with work still open; hover it for what it is.
        ${hidden.size > 0 ? html`${hidden.size} hidden from this list.` : nothing}
      </p>
      ${renderNewProject(state)}
    </header>
    ${state.myProjects === null && state.myProjectsLoading
      ? html`<p class="projects__empty">Loading your projects…</p>`
      : projects.length === 0
        ? html`<p class="projects__empty">No active projects. Start one with New project.</p>`
        : html`<div class="projects__cards">
            ${projects.map(
              (project) =>
                html`<a
                  class="project-card"
                  href=${`${state.basePath}/my-work/${encodeURIComponent(project.paper_id)}`}
                  data-testid=${`project-card-${project.paper_id}`}
                  @click=${(event: MouseEvent) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
                      return;
                    }
                    event.preventDefault();
                    navigateToProject(state, project.paper_id);
                  }}
                  >${renderCard(project)}</a
                >`,
            )}
          </div>`}
  </section>`;
}
