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
type Interest = {
  paper_id: string;
  title: string;
  member_name: string;
  hours_per_week: number;
  note: string;
  status: "active" | "withdrawn";
  updated_at: string;
  is_own: boolean;
};
type Directory = {
  interests?: Interest[];
  projects: { id: string; title: string }[];
  requests: HelpRequest[];
};

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
  @state() private offerDrafts: Record<string, { hours_per_week: string; note: string }> = {};
  private generation = 0;
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.generation++;
      this.data = null;
      this.offerDrafts = {};
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
  async showProject(paperId: string) {
    const generation = this.generation;
    this.query = "";
    await this.updateComplete;
    if (generation !== this.generation || !this.sessionToken) {
      return;
    }
    const card = this.querySelector<HTMLElement>(
      `[id="lab-project-${encodeURIComponent(paperId)}"]`,
    );
    card?.scrollIntoView({ block: "center" });
    card?.focus({ preventScroll: true });
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
        method:
          body === undefined
            ? "GET"
            : path.endsWith("/close") || path.endsWith("/withdraw")
              ? "POST"
              : "PUT",
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
  private renderInterests() {
    if (!this.data) {
      return nothing;
    }
    const interests = this.data.interests ?? [];
    const eligible = this.data.requests.filter(
      (request) => request.status === "open" && !request.can_manage,
    );
    const own = interests.filter((interest) => interest.is_own);
    return html`
      ${eligible.length ? html`<h3 class="lab-sharing-seek__title">Offer to help</h3>` : nothing}
      ${eligible.map((request) => {
        const saved = own.find((interest) => interest.paper_id === request.paper_id);
        const draft = this.offerDrafts[request.paper_id] ?? {
          hours_per_week: String(saved?.hours_per_week ?? 1),
          note: saved?.note ?? "",
        };
        const update = (field: "hours_per_week" | "note", value: string) => {
          this.offerDrafts = {
            ...this.offerDrafts,
            [request.paper_id]: { ...draft, [field]: value },
          };
        };
        return html`<form
          aria-label=${`Offer for ${request.title}`}
          @submit=${async (event: SubmitEvent) => {
            event.preventDefault();
            this.notice = "";
            if (
              await this.request(`/requests/${encodeURIComponent(request.paper_id)}/interest`, {
                hours_per_week: Number(draft.hours_per_week),
                note: draft.note,
              })
            ) {
              this.notice = "Offer saved. Project authors and administrators can review it.";
            }
          }}
        >
          <fieldset class="lab-sharing-ask" ?disabled=${this.busy}>
            <legend>${request.title}</legend>
            <p>
              Your availability and note are visible to you, project authors, and administrators.
              Offering help does not add you to the project.
            </p>
            <label class="lab-sharing-ask__field"
              ><span class="lab-sharing-ask__label">Your hours per week</span>
              <input
                class="lab-sharing-ask__input"
                type="number"
                required
                min="0.5"
                max="168"
                step="0.5"
                .value=${draft.hours_per_week}
                @input=${(event: Event) =>
                  update("hours_per_week", (event.target as HTMLInputElement).value)}
            /></label>
            <label class="lab-sharing-ask__field"
              ><span class="lab-sharing-ask__label">Note (optional)</span>
              <textarea
                class="lab-sharing-ask__textarea"
                maxlength="1000"
                .value=${draft.note}
                @input=${(event: Event) =>
                  update("note", (event.target as HTMLTextAreaElement).value)}
              ></textarea>
            </label>
            <button class="btn primary" type="submit">
              ${saved?.status === "active" ? "Update offer" : "Offer to help"}
            </button>
          </fieldset>
        </form>`;
      })}
      ${own.length ? html`<h3 class="lab-sharing-seek__title">Your offers</h3>` : nothing}
      ${own.map(
        (interest) => html`<article class="lab-sharing-request">
          <h3 class="lab-sharing-request__project">${interest.title}</h3>
          <p>
            ${interest.status === "active" ? "Active" : "Withdrawn"} · ${interest.hours_per_week}
            hours per week
          </p>
          <p class="lab-sharing-request__note">${interest.note}</p>
          <p class="muted">Updated ${interest.updated_at}</p>
          ${interest.status === "active"
            ? html`<button
                class="btn"
                ?disabled=${this.busy}
                @click=${async () => {
                  this.notice = "";
                  if (
                    await this.request(
                      `/requests/${encodeURIComponent(interest.paper_id)}/interest/withdraw`,
                      {},
                    )
                  ) {
                    this.notice = "Offer withdrawn.";
                  }
                }}
              >
                Withdraw offer
              </button>`
            : nothing}
        </article>`,
      )}
      ${interests.some((interest) => !interest.is_own)
        ? html`<h3 class="lab-sharing-seek__title">Offers on your projects</h3>`
        : nothing}
      ${interests
        .filter((interest) => !interest.is_own)
        .map(
          (interest) => html`<article class="lab-sharing-request">
            <h3 class="lab-sharing-request__project">
              ${interest.title} · ${interest.member_name}
            </h3>
            <p>${interest.hours_per_week} hours per week</p>
            <p class="lab-sharing-request__note">${interest.note}</p>
            <p class="muted">Updated ${interest.updated_at}</p>
          </article>`,
        )}
    `;
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
    return html`<section
      class="lab-sharing lab-sharing-directory"
      aria-label="Project help requests"
    >
      <h2 class="lab-sharing-seek__title">Open projects</h2>
      <p class="lab-sharing-seek__sub">
        Find projects looking for help. Requests are shared with signed-in lab members.
      </p>
      <button class="btn" ?disabled=${this.busy} @click=${() => this.request()}>
        Refresh projects
      </button>
      ${this.busy ? html`<p class="muted" role="status">Loading…</p>` : nothing}
      ${this.error ? html`<p class="callout danger" role="alert">${this.error}</p>` : nothing}
      ${this.notice ? html`<p class="muted" role="status">${this.notice}</p>` : nothing}
      ${this.data
        ? html`
            <label class="lab-sharing-ask__field"
              >Search projects or tags
              <input
                class="lab-sharing-ask__input"
                type="search"
                .value=${this.query}
                @input=${(event: Event) => {
                  this.query = (event.target as HTMLInputElement).value;
                }}
            /></label>
            ${filtered.length
              ? filtered.map(
                  (request) => html`<article
                    class="lab-sharing-request"
                    id=${`lab-project-${encodeURIComponent(request.paper_id)}`}
                    tabindex="-1"
                    data-project=${request.paper_id}
                  >
                    <h3 class="lab-sharing-request__project">${request.title}</h3>
                    <p class="lab-sharing-request__time">Posted by ${request.owner_name}</p>
                    <p class="lab-sharing-request__note">${request.description}</p>
                    <div class="lab-sharing-request__needs">
                      ${request.tags.map(
                        (tag) => html`<span class="lab-sharing-request__need">${tag}</span>`,
                      )}
                    </div>
                    <p>
                      ${request.members_needed} people needed · ${request.hours_per_week} hours per
                      week per person
                    </p>
                    ${request.timeline ? html`<p>Timeline: ${request.timeline}</p>` : nothing}
                    ${request.can_manage
                      ? html`<div class="lab-sharing-directory__actions">
                          <button
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
                          </button>
                        </div>`
                      : nothing}
                  </article>`,
                )
              : html`<p>
                  ${open.length
                    ? "No projects match your search."
                    : "No projects are asking for help yet."}
                </p>`}
            ${this.renderInterests()}
            <h3 class="lab-sharing-seek__title">Your project help request</h3>
            ${this.data.projects.length
              ? html`<form @submit=${(event: SubmitEvent) => this.save(event)}>
                  <fieldset class="lab-sharing-ask" ?disabled=${this.busy}>
                    <label class="lab-sharing-ask__field"
                      ><span class="lab-sharing-ask__label">Project</span>
                      <select
                        class="lab-sharing-ask__select"
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
                    <label class="lab-sharing-ask__field"
                      ><span class="lab-sharing-ask__label">Tasks and help needed</span>
                      <textarea
                        class="lab-sharing-ask__textarea"
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
                    <label class="lab-sharing-ask__field"
                      ><span class="lab-sharing-ask__label">Tags (comma separated)</span>
                      <input
                        class="lab-sharing-ask__input"
                        .value=${this.draft.tags}
                        @input=${(event: Event) => {
                          this.draft = {
                            ...this.draft,
                            tags: (event.target as HTMLInputElement).value,
                          };
                        }}
                    /></label>
                    <label class="lab-sharing-ask__field"
                      ><span class="lab-sharing-ask__label">People needed</span>
                      <input
                        class="lab-sharing-ask__input"
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
                    <label class="lab-sharing-ask__field"
                      ><span class="lab-sharing-ask__label">Hours per week per person</span>
                      <input
                        class="lab-sharing-ask__input"
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
                    <label class="lab-sharing-ask__field"
                      ><span class="lab-sharing-ask__label">Timeline (optional)</span>
                      <input
                        class="lab-sharing-ask__input"
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
