// Lab Projects: every project in the lab, one row each, for the admins.
//
// My Projects is one person's plate; this is the lab's. It reads GET /lab/projects, which the
// service refuses to anyone but an admin, so the tab being admin-only (access.ts) is only the
// courtesy of not offering a page that would answer 403. A row opens the same project page My
// Projects draws -- this view has no detail of its own to drift from it.
import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  AdminBotLabProject,
  AdminBotLabProjectPaperLinkKind,
  AdminBotLabProjectStatus,
} from "../../../../../extensions/adminbot/src/workflows/papers/lab-projects.js";
import { memberAuthHeaders } from "../api/device-clock.ts";
import { stepLabels } from "../data/paper-steps.ts";

export type LabProject = AdminBotLabProject;

const STATUS_LABEL: Record<AdminBotLabProjectStatus, string> = {
  active: "Active",
  dormant: "Dormant",
  completed: "Completed",
  rejected: "Rejected",
};

const PAPER_LINK_LABEL: Record<AdminBotLabProjectPaperLinkKind, string> = {
  arxiv: "Paper (arXiv)",
  pdf: "Paper (PDF)",
  submission: "Submission",
  overleaf_view: "Draft (Overleaf)",
  github: "GitHub repo",
  project_doc: "Weekly-update doc",
};

/** Whether a project matches the search box: title, alias, any member or author, topic or tag. */
export function labProjectMatches(project: LabProject, query: string): boolean {
  const needles = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (needles.length === 0) {
    return true;
  }
  const haystack = [
    project.title,
    project.alias ?? "",
    project.topic ?? "",
    ...project.tags,
    ...project.members.map((member) => member.name),
    ...project.authors,
  ]
    .join("\n")
    .toLocaleLowerCase();
  return needles.every((needle) => haystack.includes(needle));
}

function day(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

export class LabProjectsView extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @property({ attribute: false }) onOpen: (paperId: string) => void = () => {};
  @state() private projects: LabProject[] | null = null;
  @state() private query = "";
  @state() private status: AdminBotLabProjectStatus | "all" = "all";
  @state() private loading = false;
  @state() private error = "";
  private controller?: AbortController;

  static override styles = css`
    :host {
      display: block;
      max-width: 1100px;
      color: var(--text);
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    input[type="search"] {
      flex: 1 1 18rem;
      min-height: 36px;
    }
    input,
    select,
    button {
      font: inherit;
      color: inherit;
      background: transparent;
      border: 1px solid var(--border, #8885);
      border-radius: 8px;
      padding: 6px 10px;
    }
    button,
    select {
      cursor: pointer;
    }
    .hint {
      color: var(--muted);
      font-size: 13px;
      margin: 0 0 12px;
    }
    .error {
      color: var(--danger, #c0392b);
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    li {
      border: 1px solid var(--border, #8885);
      border-radius: 12px;
      padding: 14px 16px;
      display: grid;
      gap: 6px;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: baseline;
    }
    .title {
      font: inherit;
      font-weight: 600;
      font-size: 15px;
      border: 0;
      padding: 0;
      text-align: left;
      color: var(--accent, #486bdf);
    }
    .title:hover {
      text-decoration: underline;
    }
    .alias,
    .meta {
      color: var(--muted);
      font-size: 13px;
    }
    .pill {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 999px;
      font-size: 12px;
      border: 1px solid var(--border, #8885);
    }
    .pill.active {
      border-color: var(--accent, #486bdf);
      color: var(--accent, #486bdf);
    }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
      font-size: 13px;
    }
    .links a {
      color: var(--accent, #486bdf);
    }
    .slot.empty {
      color: var(--muted);
    }
    :focus-visible {
      outline: 2px solid var(--accent, #486bdf);
      outline-offset: 3px;
    }
  `;

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      void this.load();
    }
  }

  override disconnectedCallback() {
    this.controller?.abort();
    super.disconnectedCallback();
  }

  private async load() {
    this.controller?.abort();
    if (!this.sessionToken) {
      this.projects = null;
      this.error = "Sign in as an admin to see the lab's projects.";
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.loading = true;
    this.error = "";
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/lab/projects`, {
        headers: memberAuthHeaders(this.sessionToken),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as {
        projects?: LabProject[];
        error?: { message?: string };
      } | null;
      if (!response.ok || !body?.projects) {
        this.projects = null;
        this.error =
          response.status === 403
            ? "Lab Projects is for admins."
            : (body?.error?.message ?? `The project list could not load (${response.status}).`);
        return;
      }
      this.projects = body.projects;
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      this.projects = null;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.controller === controller) {
        this.loading = false;
      }
    }
  }

  private open(event: Event, paperId: string) {
    event.preventDefault();
    this.onOpen(paperId);
  }

  private renderSlot(label: string, link: { url: string } | null) {
    return link
      ? html`<a class="slot" href=${link.url} target="_blank" rel="noopener noreferrer"
          >${label}</a
        >`
      : html`<span class="slot empty">${label}: not yet</span>`;
  }

  private renderProject(project: LabProject) {
    const weekly = project.last_weekly_update;
    const primary = project.links.primary;
    return html`<li data-testid=${`lab-project-${project.paper_id}`}>
      <div class="head">
        <button
          type="button"
          class="title"
          title="Open the project page"
          @click=${(event: Event) => this.open(event, project.paper_id)}
        >
          ${project.title}
        </button>
        ${project.alias ? html`<span class="alias">#${project.alias}</span>` : nothing}
        <span class="pill ${project.status}">${STATUS_LABEL[project.status]}</span>
        <span class="pill">${stepLabels[project.current_step] ?? project.current_step}</span>
      </div>
      <div class="meta">
        ${project.topic ? html`<span>${project.topic}</span> · ` : nothing}
        ${project.tags.length ? html`<span>${project.tags.join(", ")}</span> · ` : nothing}
        <span class="members"
          >${project.members.length
            ? project.members.map((member) => member.name).join(", ")
            : project.authors.join(", ") || "No members linked"}</span
        >
      </div>
      <div class="meta">
        Last update <span class="updated">${day(project.last_update_at)}</span>
        ${weekly
          ? ` · weekly update by ${weekly.name ?? weekly.member_id} for the week of ${weekly.week_start}`
          : nothing}
      </div>
      <div class="links">
        ${primary
          ? html`<a class="primary" href=${primary.url} target="_blank" rel="noopener noreferrer"
              >${PAPER_LINK_LABEL[primary.kind]}</a
            >`
          : html`<span class="slot empty">No paper, repo or doc linked yet</span>`}
        ${project.links.github && primary?.kind !== "github"
          ? html`<a href=${project.links.github.url} target="_blank" rel="noopener noreferrer"
              >GitHub repo</a
            >`
          : nothing}
        ${project.links.slack_channel
          ? html`<span class="slack">Slack #${project.links.slack_channel}</span>`
          : nothing}
        ${this.renderSlot("Slides", project.links.slides)}
        ${this.renderSlot("Poster", project.links.poster)}
      </div>
    </li>`;
  }

  override render() {
    const all = this.projects ?? [];
    const shown = all.filter(
      (project) =>
        (this.status === "all" || project.status === this.status) &&
        labProjectMatches(project, this.query),
    );
    return html`<section>
      <div class="controls">
        <input
          type="search"
          aria-label="Search projects"
          placeholder="Search by title, member or topic"
          .value=${this.query}
          @input=${(event: Event) => (this.query = (event.target as HTMLInputElement).value)}
        />
        <select
          aria-label="Status"
          @change=${(event: Event) =>
            (this.status = (event.target as HTMLSelectElement).value as typeof this.status)}
        >
          <option value="all" ?selected=${this.status === "all"}>Every status</option>
          ${(Object.keys(STATUS_LABEL) as AdminBotLabProjectStatus[]).map(
            (status) =>
              html`<option value=${status} ?selected=${this.status === status}>
                ${STATUS_LABEL[status]}
              </option>`,
          )}
        </select>
        <button type="button" @click=${() => void this.load()} ?disabled=${this.loading}>
          ${this.loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : nothing}
      ${this.projects
        ? html`<p class="hint" data-testid="lab-projects-count">
              ${shown.length === all.length
                ? `${all.length} projects, most recently updated first.`
                : `${shown.length} of ${all.length} projects.`}
              Open one for its full page.
            </p>
            ${shown.length
              ? html`<ul>
                  ${shown.map((project) => this.renderProject(project))}
                </ul>`
              : html`<p class="hint" data-testid="lab-projects-empty">No project matches.</p>`}`
        : this.loading
          ? html`<p class="hint">Loading the lab's projects…</p>`
          : nothing}
    </section>`;
  }
}

if (!customElements.get("adminbot-lab-projects")) {
  customElements.define("adminbot-lab-projects", LabProjectsView);
}

export function renderLabProjects(
  baseUrl: string,
  sessionToken: string,
  onOpen: (paperId: string) => void,
) {
  return html`<adminbot-lab-projects
    .baseUrl=${baseUrl}
    .sessionToken=${sessionToken}
    .onOpen=${onOpen}
  ></adminbot-lab-projects>`;
}
