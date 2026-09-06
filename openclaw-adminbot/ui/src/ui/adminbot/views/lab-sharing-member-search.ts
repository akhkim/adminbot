import { html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

type MemberMatch = {
  id: string;
  name: string;
  research_branch: string;
  research_topics: string[];
  matched_fields: string[];
  projects: { id: string; title: string }[];
};

export class LabSharingMemberSearch extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private query = "";
  @state() private members: MemberMatch[] = [];
  @state() private busy = false;
  @state() private error = "";
  @state() private truncated = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.reset();
      this.query = "";
    }
  }
  override disconnectedCallback() {
    this.reset();
    super.disconnectedCallback();
  }
  private reset() {
    this.generation++;
    clearTimeout(this.timer);
    this.members = [];
    this.busy = false;
    this.error = "";
    this.truncated = false;
  }
  private change(value: string) {
    this.reset();
    this.query = value;
    if (value.trim().length >= 2) {
      this.busy = true;
      this.timer = setTimeout(() => {
        void this.search();
      }, 250);
    }
  }
  private async search() {
    if (!this.sessionToken || this.query.trim().length < 2) {
      return;
    }
    const generation = ++this.generation;
    this.busy = true;
    this.error = "";
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/u, "")}/lab-sharing/members?q=${encodeURIComponent(this.query.trim())}`,
        { headers: { Authorization: `Bearer ${this.sessionToken}` } },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message ?? "Could not search members.");
      }
      if (generation !== this.generation) {
        return;
      }
      this.members = data.members;
      this.truncated = data.truncated;
    } catch (error) {
      if (generation === this.generation) {
        this.error = error instanceof Error ? error.message : "Could not search members.";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }
  override render() {
    if (!this.sessionToken) {
      return nothing;
    }
    return html`<section class="lab-sharing lab-sharing-directory" aria-label="Find lab members">
      <h2 class="lab-sharing-seek__title">Find lab members</h2>
      <p class="lab-sharing-seek__sub">
        Search names, research topics, or projects currently asking for help.
      </p>
      <label class="lab-sharing-ask__field"
        ><span class="lab-sharing-ask__label">Search members</span>
        <input
          class="lab-sharing-ask__input"
          type="search"
          maxlength="100"
          .value=${this.query}
          @input=${(event: Event) => this.change((event.target as HTMLInputElement).value)}
        />
      </label>
      ${this.query.trim().length < 2
        ? html`<p class="muted">Enter at least two characters.</p>`
        : nothing}
      ${this.busy ? html`<p role="status">Searching members…</p>` : nothing}
      ${this.error
        ? html`<p role="alert">${this.error}</p>
            <button class="btn" @click=${() => this.search()}>Retry search</button>`
        : nothing}
      ${!this.busy && !this.error && this.query.trim().length >= 2 && !this.members.length
        ? html`<p role="status">No members match your search.</p>`
        : nothing}
      ${this.truncated
        ? html`<p class="muted">
            Showing the first 20 matches. Refine your search for more specific results.
          </p>`
        : nothing}
      ${this.members.map(
        (member) => html`<article class="lab-sharing-request">
          <h3 class="lab-sharing-request__project">${member.name}</h3>
          <p>${member.research_branch}</p>
          <div class="lab-sharing-request__needs">
            ${member.research_topics.map(
              (topic) => html`<span class="lab-sharing-request__need">${topic}</span>`,
            )}
          </div>
          <p class="muted">Matched: ${member.matched_fields.join(", ")}</p>
          ${member.projects.map(
            (project) =>
              html`<a href=${`#lab-project-${encodeURIComponent(project.id)}`}
                >${project.title}</a
              >`,
          )}
        </article>`,
      )}
    </section>`;
  }
}
if (!customElements.get("lab-sharing-member-search")) {
  customElements.define("lab-sharing-member-search", LabSharingMemberSearch);
}
