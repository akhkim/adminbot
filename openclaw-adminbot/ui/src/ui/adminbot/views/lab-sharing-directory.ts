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
  @state() private maxHours = "";
  @state() private sort = "title";
  @state() private discovered: HelpRequest[] = [];
  @state() private nextCursor: string | null = null;
  @state() private discoveryBusy = false;
  private discoveryGeneration = 0;
  private discoveryTimer?: ReturnType<typeof setTimeout>;
  @state() private revealedProject = "";
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
      this.discovered = [];
      this.discoveryBusy = false;
      this.nextCursor = null;
      this.discoveryGeneration++;
      clearTimeout(this.discoveryTimer);
      this.offerDrafts = {};
      this.query = this.maxHours = "";
      this.revealedProject = "";
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
    this.discoveryGeneration++;
    clearTimeout(this.discoveryTimer);
    super.disconnectedCallback();
  }
  private scheduleDiscovery() {
    clearTimeout(this.discoveryTimer);
    this.discoveryGeneration++;
    this.discovered = [];
    this.nextCursor = null;
    this.discoveryBusy = true;
    this.discoveryTimer = setTimeout(() => void this.loadDiscovery(), 250);
  }
  private async read(path: string) {
    const response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}/lab-sharing${path || "/mine"}`, {
      headers: {Authorization: `Bearer ${this.sessionToken}`}, signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? "Could not load projects.");
    return data;
  }
  private async loadDiscovery(more = false) {
    if (!this.sessionToken) return;
    const generation = ++this.discoveryGeneration;
    this.discoveryBusy = true;
    this.error = "";
    const params = new URLSearchParams({q: this.query, sort: this.sort, limit: "10"});
    if (this.maxHours) params.set("max_hours", this.maxHours);
    if (more && this.nextCursor) params.set("cursor", this.nextCursor);
    try {
      const page = await this.read(`/discover?${params}`);
      if (generation !== this.discoveryGeneration) return;
      const rows = more ? [...this.discovered, ...page.requests] : page.requests;
      this.discovered = [...new Map(rows.map((row: HelpRequest) => [row.paper_id, row])).values()] as HelpRequest[];
      this.nextCursor = page.next_cursor;
    } catch (error) {
      if (generation === this.discoveryGeneration) this.error = error instanceof Error ? error.message : "Could not load projects.";
    } finally {
      if (generation === this.discoveryGeneration) this.discoveryBusy = false;
    }
  }
  async showProject(paperId: string) {
    const generation = ++this.discoveryGeneration;
    clearTimeout(this.discoveryTimer);
    try {
      const data = await this.read(`/projects/${encodeURIComponent(paperId)}`);
      if (generation !== this.discoveryGeneration || !this.sessionToken) return;
      this.revealedProject = paperId;
      this.discovered = [data.request, ...this.discovered.filter(row => row.paper_id !== paperId)];
      await this.updateComplete;
      const card = this.querySelector<HTMLElement>(`[id="lab-project-${encodeURIComponent(paperId)}"]`);
      card?.scrollIntoView({block: "center"}); card?.focus({preventScroll: true});
    } catch (error) {
      if (generation === this.discoveryGeneration) this.error = error instanceof Error ? error.message : "Project unavailable.";
    } finally { if (generation === this.discoveryGeneration) this.discoveryBusy = false; }
  }
  private async request(path = "", body?: unknown): Promise<boolean> {
    if (this.busy || !this.sessionToken) {
      return false;
    }
    const generation = this.generation;
    this.busy = true;
    this.error = "";
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}/lab-sharing${path || "/mine"}`, {
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
      let managed: Directory;
      try {
        managed = body === undefined ? result as Directory : await this.read("/mine") as Directory;
      } catch {
        if (generation !== this.generation) return false;
        this.error = "Your change was saved, but the page could not refresh. Use Refresh projects to see the latest state.";
        return true;
      }
      if (generation !== this.generation) return false;
      this.data = managed;
      void this.loadDiscovery();
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
    const eligible = this.discovered.filter(
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
    const filtered = this.discovered;
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
              >Search by topic, project, person, or task
              <input
                class="lab-sharing-ask__input"
                type="search"
                .value=${this.query}
                @input=${(event: Event) => {
                  this.query = (event.target as HTMLInputElement).value;
                              this.revealedProject = "";
                  this.scheduleDiscovery();
                }}
            /></label>
            <div class="lab-sharing-directory__filters">
              <label class="lab-sharing-ask__field">Maximum hours per week
                <input class="lab-sharing-ask__input" type="number" min="1" placeholder="Any" .value=${this.maxHours}
                  @input=${(event: Event) => { this.maxHours = (event.target as HTMLInputElement).value; this.revealedProject = ""; this.scheduleDiscovery(); }} />
              </label>
              <label class="lab-sharing-ask__field">Sort projects
                <select class="lab-sharing-ask__select" .value=${this.sort}
                  @change=${(event: Event) => { this.sort = (event.target as HTMLSelectElement).value; this.revealedProject = ""; this.scheduleDiscovery(); }}>
                  <option value="title">Project name</option><option value="hours">Lowest time commitment</option>
                </select>
              </label>
              <button class="btn" @click=${() => { this.query = this.maxHours = ""; this.revealedProject = ""; this.scheduleDiscovery(); }}>Clear filters</button>
            </div>
            ${this.revealedProject ? html`<p class="muted">Selected project shown first.</p>` : nothing}
            <p class="muted" role="status">${filtered.length} ${filtered.length === 1 ? "project" : "projects"} loaded${this.nextCursor ? " · more available" : ""}</p>
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
                  ${this.discoveryBusy ? "Searching projects…" : "No projects match these filters. Try fewer search terms or increase the weekly hours."}
                </p>`}
            ${this.nextCursor ? html`<button class="btn" ?disabled=${this.discoveryBusy} @click=${() => this.loadDiscovery(true)}>Show more projects</button>` : nothing}
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
