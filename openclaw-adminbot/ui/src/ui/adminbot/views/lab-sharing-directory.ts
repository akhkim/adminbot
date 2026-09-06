import { html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

type HelpRequest = {
  paper_id: string;
  title: string;
  owner_name: string;
  description: string;
  tags: string[];
  members_needed: number;
  hours_per_week: number;
  timeline: string;
  status: "open" | "closed";
  can_manage: boolean;
};
type Directory = { projects: { id: string; title: string }[]; requests: HelpRequest[] };

/** A real service-backed island; the other Lab Sharing panels remain explicitly previews. */
export class LabSharingDirectory extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private data: Directory | null = null;
  @state() private busy = false;
  @state() private error = "";
  @state() private notice = "";
  @state() private query = "";
  @state() private draft = {
    paper_id: "",
    description: "",
    tags: "",
    members_needed: 1,
    hours_per_week: 1,
    timeline: "",
  };
  private generation = 0;
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.generation++;
      this.data = null;
      this.error = "";
      this.notice = "";
      this.draft = {
        paper_id: "",
        description: "",
        tags: "",
        members_needed: 1,
        hours_per_week: 1,
        timeline: "",
      };
      this.busy = false;
      if (this.sessionToken) {
        void this.request();
      }
    }
  }
  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }
  private async request(path = "", body?: unknown): Promise<boolean> {
    if (this.busy || !this.sessionToken) {
      return false;
    }
    const generation = this.generation;
    this.busy = true;
    this.error = "";
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}/lab-sharing${path}`, {
        method: body === undefined ? "GET" : path.endsWith("/close") ? "POST" : "PUT",
        headers: {
          Authorization: `Bearer ${this.sessionToken}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error?.message ?? "Could not load Lab Sharing.");
      }
      if (generation !== this.generation) {
        return false;
      }
      this.data = result as Directory;
      return true;
    } catch (error) {
      if (generation === this.generation) {
        this.error =
          error instanceof Error
            ? error.message
            : "Could not reach AdminBot. Retry when the service is available.";
      }
      return false;
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }
  private async save(event: SubmitEvent) {
    event.preventDefault();
    this.notice = "";
    const { paper_id, ...draft } = this.draft;
    if (
      await this.request(`/requests/${encodeURIComponent(paper_id)}`, {
        ...draft,
        tags: draft.tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      })
    ) {
      this.notice = "Help request saved. It is visible to signed-in lab members.";
    }
  }
  private edit(request: HelpRequest) {
    this.draft = {
      paper_id: request.paper_id,
      description: request.description,
      tags: request.tags.join(", "),
      members_needed: request.members_needed,
      hours_per_week: request.hours_per_week,
      timeline: request.timeline,
    };
    this.querySelector<HTMLSelectElement>("select")?.focus();
  }
  override render() {
    if (!this.sessionToken) {
      return html`<p>Sign in to see open projects.</p>`;
    }
    const open = this.data?.requests.filter((request) => request.status === "open") ?? [];
    const query = this.query.trim().toLowerCase();
    const filtered = open.filter((request) =>
      `${request.title} ${request.description} ${request.tags.join(" ")}`
        .toLowerCase()
        .includes(query),
    );
    return html`<section class="card lab-sharing-directory" aria-label="Project help requests">
      <style>
        .lab-sharing-directory {
          display: grid;
          gap: 16px;
          min-width: 0;
        }
        .lab-sharing-directory form,
        .lab-sharing-directory fieldset {
          display: grid;
          gap: 14px;
          min-width: 0;
        }
        .lab-sharing-directory label {
          display: grid;
          gap: 6px;
          min-width: 0;
        }
        .lab-sharing-directory input,
        .lab-sharing-directory textarea,
        .lab-sharing-directory select {
          width: 100%;
          box-sizing: border-box;
          min-width: 0;
          padding: 10px 12px;
          background: var(--bg, #171717);
          color: var(--text, #eee);
          border: 1px solid var(--border, #444);
          border-radius: 8px;
          font: inherit;
        }
        .lab-sharing-directory textarea {
          min-height: 110px;
        }
        .lab-sharing-directory article {
          overflow-wrap: anywhere;
        }
        .lab-sharing-directory button {
          width: fit-content;
        }
      </style>
      <h2>Open projects</h2>
      <p>Find projects looking for help. Requests are shared with signed-in lab members.</p>
      <button class="btn" ?disabled=${this.busy} @click=${() => this.request()}>
        Refresh projects
      </button>
      ${this.busy ? html`<p role="status">Loading…</p>` : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.notice ? html`<p role="status">${this.notice}</p>` : nothing}
      ${this.data
        ? html`
            <label
              >Search projects or tags
              <input
                type="search"
                .value=${this.query}
                @input=${(event: Event) => {
                  this.query = (event.target as HTMLInputElement).value;
                }}
            /></label>
            ${filtered.length
              ? filtered.map(
                  (request) => html`<article class="card" data-project=${request.paper_id}>
                    <h3>${request.title}</h3>
                    <p>Posted by ${request.owner_name}</p>
                    <p style="white-space:pre-wrap">${request.description}</p>
                    <p>${request.tags.join(" · ")}</p>
                    <p>
                      ${request.members_needed} people needed · ${request.hours_per_week} hours per
                      week per person
                    </p>
                    ${request.timeline ? html`<p>Timeline: ${request.timeline}</p>` : nothing}
                    ${request.can_manage
                      ? html`<button
                            class="btn"
                            ?disabled=${this.busy}
                            @click=${() => this.edit(request)}
                          >
                            Edit request
                          </button>
                          <button
                            class="btn"
                            ?disabled=${this.busy}
                            @click=${async () => {
                              this.notice = "";
                              if (
                                await this.request(
                                  `/requests/${encodeURIComponent(request.paper_id)}/close`,
                                  {},
                                )
                              ) {
                                this.notice =
                                  "Request closed. You can reopen it from your requests.";
                              }
                            }}
                          >
                            Close request
                          </button>`
                      : nothing}
                  </article>`,
                )
              : html`<p>
                  ${open.length
                    ? "No projects match your search."
                    : "No projects are asking for help yet."}
                </p>`}
            <h3>Your project help request</h3>
            ${this.data.projects.length
              ? html`<form @submit=${(event: SubmitEvent) => this.save(event)}>
                  <fieldset ?disabled=${this.busy}>
                    <label
                      >Project
                      <select
                        required
                        .value=${this.draft.paper_id}
                        @change=${(event: Event) => {
                          const paperId = (event.target as HTMLSelectElement).value;
                          const existing = this.data?.requests.find(
                            (request) => request.paper_id === paperId,
                          );
                          if (existing) {
                            this.edit(existing);
                          } else {
                            this.draft = {
                              paper_id: paperId,
                              description: "",
                              tags: "",
                              members_needed: 1,
                              hours_per_week: 1,
                              timeline: "",
                            };
                          }
                        }}
                      >
                        <option value="">Choose your project</option>
                        ${this.data.projects.map(
                          (project) => html`<option value=${project.id}>${project.title}</option>`,
                        )}
                      </select></label
                    >
                    <label
                      >Tasks and help needed
                      <textarea
                        required
                        maxlength="4000"
                        .value=${this.draft.description}
                        @input=${(event: Event) => {
                          this.draft = {
                            ...this.draft,
                            description: (event.target as HTMLTextAreaElement).value,
                          };
                        }}
                      ></textarea>
                    </label>
                    <label
                      >Tags (comma separated)
                      <input
                        .value=${this.draft.tags}
                        @input=${(event: Event) => {
                          this.draft = {
                            ...this.draft,
                            tags: (event.target as HTMLInputElement).value,
                          };
                        }}
                    /></label>
                    <label
                      >People needed
                      <input
                        type="number"
                        required
                        min="1"
                        max="100"
                        step="1"
                        .value=${String(this.draft.members_needed)}
                        @input=${(event: Event) => {
                          this.draft = {
                            ...this.draft,
                            members_needed: Number((event.target as HTMLInputElement).value),
                          };
                        }}
                    /></label>
                    <label
                      >Hours per week per person
                      <input
                        type="number"
                        required
                        min="0.5"
                        max="168"
                        step="0.5"
                        .value=${String(this.draft.hours_per_week)}
                        @input=${(event: Event) => {
                          this.draft = {
                            ...this.draft,
                            hours_per_week: Number((event.target as HTMLInputElement).value),
                          };
                        }}
                    /></label>
                    <label
                      >Timeline (optional)
                      <input
                        maxlength="300"
                        .value=${this.draft.timeline}
                        @input=${(event: Event) => {
                          this.draft = {
                            ...this.draft,
                            timeline: (event.target as HTMLInputElement).value,
                          };
                        }}
                    /></label>
                    <p>
                      Saving opens or updates the request for this project. No email or Slack
                      message is sent.
                    </p>
                    <button class="btn primary" type="submit">Save help request</button>
                  </fieldset>
                </form>`
              : html`<p>
                  You can post a help request after you are listed as an author on a project.
                </p>`}
            ${this.data.requests.some(
              (request) => request.status === "closed" && request.can_manage,
            )
              ? html`<h3>Your closed requests</h3>
                  ${this.data.requests
                    .filter((request) => request.status === "closed" && request.can_manage)
                    .map(
                      (request) =>
                        html`<p>
                          ${request.title}
                          <button
                            class="btn"
                            ?disabled=${this.busy}
                            @click=${() => this.edit(request)}
                          >
                            Edit and reopen
                          </button>
                        </p>`,
                    )}`
              : nothing}
          `
        : nothing}
    </section>`;
  }
}
if (!customElements.get("lab-sharing-directory")) {
  customElements.define("lab-sharing-directory", LabSharingDirectory);
}
