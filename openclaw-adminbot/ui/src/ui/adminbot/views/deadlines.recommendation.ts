import { css, html, LitElement, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import type {
  DeadlineRecommendationDirectory,
  DeadlineRecommendationPreview,
  DeadlineRecommendationStore,
} from "../data/deadline-recommendations.ts";

/** A member suggestion is separate from the member's own submission plans. */
export class DeadlineRecommendation extends LitElement {
  static override properties = {
    deadlineId: {},
    venueName: {},
    memberId: {},
    directory: { attribute: false },
    store: { attribute: false },
    loadError: {},
  };
  deadlineId = "";
  venueName = "";
  memberId = "";
  directory?: DeadlineRecommendationDirectory;
  store?: DeadlineRecommendationStore;
  loadError = "";
  private picker?: DeadlineRecommendationDirectory;
  private memberQuery = "";
  private memberOffset?: number;
  private paperOffset?: number;
  private loading = false;
  private generation = 0;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private recipient = "";
  private paperIds: string[] = [];
  private paperQuery = "";
  private papersOpen = false;
  private activePaper = -1;
  private reason = "";
  private preview?: DeadlineRecommendationPreview;
  private busy = false;
  private error = "";
  private open = false;
  private notice = "";
  private readonly failedAvatars = new Set<string>();
  private async openForm() {
    await this.updateComplete;
    this.preview = undefined;
    this.error = "";
    this.open = true;
    void this.loadPicker("members");
    this.requestUpdate();
  }
  private async loadPicker(mode: "members" | "papers", more = false) {
    if (!this.store) {
      return;
    }
    const generation = ++this.generation;
    this.loading = true;
    this.error = "";
    this.requestUpdate();
    try {
      const result = await this.store.list({
        mode,
        q: mode === "members" ? this.memberQuery : this.paperQuery,
        recipient: this.recipient,
        offset: more ? (mode === "members" ? this.memberOffset : this.paperOffset) : 0,
      });
      if (generation !== this.generation || !this.open || !result) {
        return;
      }
      const previous = this.picker ?? { members: [], papers: [], recommendations: [] };
      this.picker = {
        ...previous,
        [mode]: more ? [...previous[mode], ...result[mode]] : result[mode],
      };
      if (mode === "members") {
        this.memberOffset = result.nextOffset;
      } else {
        this.paperOffset = result.nextOffset;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.requestUpdate();
      }
    }
  }
  protected override willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("store") || changed.has("memberId") || changed.has("deadlineId")) {
      ++this.generation;
      clearTimeout(this.searchTimer);
      this.picker = undefined;
      this.recipient = "";
      this.memberQuery = "";
      this.memberOffset = undefined;
      this.paperOffset = undefined;
      this.failedAvatars.clear();
      this.paperIds = [];
      this.paperQuery = "";
      this.papersOpen = false;
      this.activePaper = -1;
      this.preview = undefined;
      this.reason = "";
      this.error = "";
      this.notice = "";
      this.open = false;
      this.busy = false;
      this.loading = false;
    }
  }
  override disconnectedCallback() {
    ++this.generation;
    clearTimeout(this.searchTimer);
    super.disconnectedCallback();
  }
  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font: inherit;
    }
    button,
    input,
    select,
    textarea {
      font: inherit;
      color: inherit;
    }
    button {
      cursor: pointer;
      border: 1px solid var(--border, #34343c);
      border-radius: 6px;
      padding: 4px 8px;
      background: var(--bg, #18181b);
      font-size: 12px;
      min-height: 28px;
    }
    button:disabled {
      opacity: 0.55;
      cursor: default;
    }
    button:focus-visible,
    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible {
      outline: 2px solid var(--accent, #7d9cff);
      outline-offset: 2px;
    }
    [role="status"] {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    .avatar-button {
      padding: 0;
      border: 0;
      background: transparent;
    }
    @media (pointer: coarse) {
      select,
      textarea {
        font-size: 16px;
      }
      button {
        min-height: 32px;
      }
    }
    .recommend-icon {
      display: block;
      width: 16px;
      height: 16px;
    }
    .people-count {
      position: absolute;
      inset: -5px -5px auto auto;
      pointer-events: none;
      border-radius: 6px;
      padding: 0 2px;
      font-size: 10px;
      background: var(--bg, #18181b);
    }
    .people {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .avatar {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--bg-accent, #303039);
      display: inline-grid;
      place-items: center;
      font-size: 11px;
    }
    dialog {
      box-sizing: border-box;
      width: min(480px, calc(100vw - 24px));
      max-height: calc(100dvh - 32px);
      overflow: auto;
      border: 1px solid var(--border, #34343c);
      border-radius: 12px;
      background: var(--bg, #18181b);
      color: var(--text, #eee);
      padding: 20px;
    }
    dialog::backdrop {
      background: #0008;
    }
    h2 {
      font-size: 18px;
      margin: 0 0 8px;
    }
    p {
      margin: 8px 0 16px;
      font-size: 13px;
    }
    label {
      display: grid;
      gap: 6px;
      margin-top: 14px;
      font-size: 13px;
    }
    input[type="search"],
    select,
    textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 36px;
      padding: 8px;
      border: 1px solid var(--border, #34343c);
      border-radius: 6px;
      background: var(--bg, #18181b);
    }
    .member-controls {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 8px;
    }
    .member-controls select {
      min-width: 0;
    }
    .paper-field {
      display: grid;
      gap: 6px;
      margin-top: 14px;
      font-size: 13px;
    }
    .paper-picker {
      position: relative;
    }
    .paper-options {
      position: absolute;
      z-index: 1;
      inset: calc(100% + 4px) 0 auto;
      padding: 4px;
      border: 1px solid var(--border, #34343c);
      border-radius: 6px;
      background: var(--bg, #18181b);
      box-shadow: 0 4px 12px #0002;
    }
    .paper-list {
      max-height: 160px;
      overflow: auto;
    }
    .paper-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      border-radius: 4px;
      cursor: pointer;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .paper-option[data-active],
    .paper-option:hover {
      background: var(--bg-hover, #27272a);
    }
    .paper-option svg {
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
    }
    .paper-option[aria-selected="false"] svg {
      visibility: hidden;
    }
    .paper-options p {
      margin: 8px;
    }
    .paper-selection {
      color: var(--muted, #92929b);
      font-size: 12px;
    }
    textarea {
      resize: vertical;
      min-height: 80px;
    }
    footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 20px;
    }
    footer button {
      min-height: 36px;
    }
    pre {
      max-height: 40dvh;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: inherit;
      font-size: 13px;
      line-height: 1.5;
    }
    [role="alert"] {
      color: var(--danger, #ed6a79);
    }
  `;
  private closePapers() {
    this.papersOpen = false;
    this.paperQuery = "";
    this.activePaper = -1;
    this.requestUpdate();
  }
  private paperKeydown(event: KeyboardEvent, papers: DeadlineRecommendationDirectory["papers"]) {
    if (event.key === "Escape" && this.papersOpen) {
      event.preventDefault();
      event.stopPropagation();
      this.closePapers();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.papersOpen = true;
      this.activePaper = papers.length
        ? this.activePaper < 0
          ? event.key === "ArrowDown"
            ? 0
            : papers.length - 1
          : (this.activePaper +
              (event.key === "ArrowDown" ? 1 : papers.length - 1) +
              papers.length) %
            papers.length
        : -1;
      this.requestUpdate();
      void this.updateComplete.then(() =>
        this.shadowRoot?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" }),
      );
    } else if (event.key === "Enter" && this.papersOpen && papers[this.activePaper]) {
      event.preventDefault();
      this.togglePaper(papers[this.activePaper].id);
    }
  }
  private togglePaper(id: string) {
    this.paperIds = this.paperIds.includes(id)
      ? this.paperIds.filter((value) => value !== id)
      : [...this.paperIds, id];
    this.requestUpdate();
  }
  private close() {
    if (!this.busy) {
      this.open = false;
      this.closePapers();
      ++this.generation;
      clearTimeout(this.searchTimer);
      this.requestUpdate();
    }
  }
  protected override updated() {
    const dialog = this.shadowRoot?.querySelector("dialog");
    if (this.open && dialog && !dialog.open) {
      dialog.showModal();
    }
    if (!this.open && dialog?.open) {
      dialog.close();
    }
  }
  private async perform(send = false) {
    if (this.busy || !this.store) {
      return;
    }
    const identity = [this.store, this.memberId, this.deadlineId];
    const current = () =>
      identity[0] === this.store &&
      identity[1] === this.memberId &&
      identity[2] === this.deadlineId &&
      this.isConnected;
    this.busy = true;
    this.error = "";
    this.requestUpdate();
    try {
      const preview =
        send && this.preview
          ? await this.store.send(this.preview)
          : await this.store.preview({
              deadline_id: this.deadlineId,
              recipient_member_id: this.recipient,
              paper_ids: this.paperIds,
              reason: this.reason,
            });
      if (!current()) {
        return;
      }
      this.preview = preview;
      if (send && this.preview.status === "sent") {
        this.notice = `Recommended to ${this.preview.recipient_name}`;
        this.open = false;
        this.dispatchEvent(
          new CustomEvent("recommendation-sent", { bubbles: true, composed: true }),
        );
      }
    } catch (error) {
      if (current()) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (current()) {
        this.busy = false;
        this.requestUpdate();
      }
    }
  }
  override render() {
    const ids = new Set(
      this.directory?.recommendations
        .filter((row) => row.deadline_id === this.deadlineId)
        .map((row) => row.recipient_member_id),
    );
    const people = this.directory?.members.filter((member) => ids.has(member.id)) ?? [];
    const candidates =
      (this.picker ?? this.directory)?.members.filter((member) => member.id !== this.memberId) ??
      [];
    const papers =
      (this.picker ?? this.directory)?.papers.filter(
        (paper) =>
          paper.author_member_ids.includes(this.recipient) &&
          paper.title.toLocaleLowerCase().includes(this.paperQuery.toLocaleLowerCase()),
      ) ?? [];
    return html` ${people.length
        ? html`<span class="people" aria-label="Recommended to"
            >${people.slice(0, 1).map(
              (member) => html`<button
                class="avatar-button"
                type="button"
                @click=${() => this.openForm()}
                title=${`Recommended to ${people.map((person) => person.name).join(", ")}`}
                aria-label=${`Recommended to ${people.map((person) => person.name).join(", ")}`}
              >
                ${member.avatar_url &&
                member.avatar_url.startsWith("https://") &&
                !this.failedAvatars.has(member.id)
                  ? html`<img
                      class="avatar"
                      src=${member.avatar_url}
                      alt=${member.name}
                      referrerpolicy="no-referrer"
                      @error=${() => {
                        this.failedAvatars.add(member.id);
                        this.requestUpdate();
                      }}
                    />`
                  : html`<span class="avatar"
                      >${member.name
                        .split(/\s+/u)
                        .map((word) => word[0])
                        .slice(0, 2)
                        .join("")}</span
                    >`}
              </button>`,
            )}${people.length > 1
              ? html`<span class="people-count" aria-hidden="true">+${people.length - 1}</span>`
              : nothing}</span
          >`
        : nothing}
      <button
        type="button"
        aria-label=${`Recommend ${this.venueName} to a member`}
        title=${`Recommend ${this.venueName} to a member`}
        @click=${() => this.openForm()}
      >
        <svg
          class="recommend-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          aria-hidden="true"
        >
          <circle cx="9" cy="7" r="4" />
          <path d="M2 21v-2a7 7 0 0 1 14 0v2M19 8v6m-3-3h6" />
        </svg>
      </button>
      <span role="status" aria-live="polite">${this.notice}</span>
      <dialog
        aria-label="Recommend a deadline"
        @cancel=${(event: Event) => {
          event.preventDefault();
          this.close();
        }}
        @close=${() => {
          this.open = false;
        }}
      >
        <h2>Recommend a deadline</h2>
        <p>${this.venueName}</p>
        ${people.length
          ? html`<p>Recommended to ${people.map((member) => member.name).join(", ")}</p>`
          : nothing}
        ${this.preview
          ? html`<p>
                Slack conversation with ${this.preview.recommender_name},
                ${this.preview.recipient_name}, and AdminBot
              </p>
              <pre role="region" aria-label="Slack message preview" tabindex="0">
${this.preview.message
                  .replaceAll("&lt;", "<")
                  .replaceAll("&gt;", ">")
                  .replaceAll("&amp;", "&")}</pre
              >`
          : html`
              ${this.loadError
                ? html`<p role="alert">${this.loadError}</p>`
                : !this.directory
                  ? html`<p>Loading members…</p>`
                  : nothing}
              <div class="member-controls">
                <label
                  >Search<input
                    type="search"
                    .value=${this.memberQuery}
                    ?disabled=${this.busy}
                    @input=${(event: Event) => {
                      this.memberQuery = (event.target as HTMLInputElement).value;
                      this.recipient = "";
                      this.paperIds = [];
                      this.paperQuery = "";
                      this.papersOpen = false;
                      this.activePaper = -1;
                      if (this.picker) {
                        this.picker = { ...this.picker, papers: [] };
                      }
                      clearTimeout(this.searchTimer);
                      ++this.generation;
                      this.searchTimer = setTimeout(() => void this.loadPicker("members"), 200);
                    }}
                /></label>
                <label
                  >Member<select
                    .value=${this.recipient}
                    ?disabled=${this.busy}
                    @change=${(event: Event) => {
                      clearTimeout(this.searchTimer);
                      this.recipient = (event.target as HTMLSelectElement).value;
                      this.paperIds = [];
                      this.paperQuery = "";
                      this.papersOpen = false;
                      this.activePaper = -1;
                      if (this.picker) {
                        this.picker = { ...this.picker, papers: [] };
                      }
                      this.paperOffset = undefined;
                      if (this.recipient) {
                        void this.loadPicker("papers");
                      } else {
                        ++this.generation;
                        this.loading = false;
                      }
                      this.requestUpdate();
                    }}
                  >
                    <option value="">Choose a member</option>
                    ${candidates.map(
                      (member) =>
                        html`<option value=${member.id} ?disabled=${!member.slack_linked}>
                          ${member.name}${member.slack_linked ? "" : " — Slack not linked"}
                        </option>`,
                    )}
                  </select></label
                >
              </div>
              ${this.memberOffset !== undefined
                ? html`<button
                    type="button"
                    ?disabled=${this.busy || this.loading}
                    @click=${() => this.loadPicker("members", true)}
                  >
                    More members
                  </button>`
                : nothing}
              <div class="paper-field">
                <span id="paper-label">Papers (optional)</span>
                <div
                  class="paper-picker"
                  @focusout=${(event: FocusEvent) => {
                    if (
                      !(event.currentTarget as HTMLElement).contains(
                        event.relatedTarget as Node | null,
                      )
                    ) {
                      this.closePapers();
                    }
                  }}
                >
                  <input
                    id="paper-search"
                    type="search"
                    role="combobox"
                    aria-labelledby="paper-label"
                    aria-autocomplete="list"
                    aria-expanded=${this.papersOpen}
                    aria-controls="paper-list"
                    aria-activedescendant=${ifDefined(
                      this.papersOpen && papers[this.activePaper]
                        ? `paper-${this.activePaper}`
                        : undefined,
                    )}
                    placeholder=${this.paperIds.length
                      ? `${this.paperIds.length} ${this.paperIds.length === 1 ? "paper" : "papers"} selected`
                      : "Search linked papers…"}
                    .value=${this.paperQuery}
                    ?disabled=${this.busy || !this.recipient}
                    @focus=${() => {
                      this.papersOpen = true;
                      void this.loadPicker("papers");
                    }}
                    @click=${() => {
                      this.papersOpen = true;
                      this.requestUpdate();
                    }}
                    @input=${(event: Event) => {
                      this.paperQuery = (event.target as HTMLInputElement).value;
                      this.activePaper = -1;
                      this.papersOpen = true;
                      clearTimeout(this.searchTimer);
                      ++this.generation;
                      this.searchTimer = setTimeout(() => void this.loadPicker("papers"), 200);
                      this.requestUpdate();
                    }}
                    @keydown=${(event: KeyboardEvent) => this.paperKeydown(event, papers)}
                  />
                  ${this.papersOpen
                    ? html`<div class="paper-options">
                        <div
                          id="paper-list"
                          class="paper-list"
                          role="listbox"
                          aria-label="Linked papers"
                          aria-multiselectable="true"
                          aria-busy=${this.loading}
                        >
                          ${papers.map(
                            (paper, index) => html`<div
                              id=${`paper-${index}`}
                              class="paper-option"
                              role="option"
                              aria-selected=${this.paperIds.includes(paper.id)}
                              ?data-active=${this.activePaper === index}
                              @mousedown=${(event: MouseEvent) => event.preventDefault()}
                              @click=${() => {
                                this.activePaper = index;
                                this.togglePaper(paper.id);
                              }}
                            >
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                aria-hidden="true"
                              >
                                <path d="m5 12 4 4L19 6" />
                              </svg>
                              <span>${paper.title}</span>
                            </div>`,
                          )}
                        </div>
                        ${!papers.length
                          ? html`<p>
                              ${this.loading
                                ? "Loading papers…"
                                : this.paperQuery
                                  ? "No matching papers"
                                  : "No linked papers"}
                            </p>`
                          : nothing}
                        ${this.paperOffset !== undefined
                          ? html`<button
                              type="button"
                              ?disabled=${this.loading}
                              @click=${() => this.loadPicker("papers", true)}
                            >
                              More papers
                            </button>`
                          : nothing}
                        <button
                          type="button"
                          @click=${() => {
                            this.closePapers();
                            this.shadowRoot
                              ?.querySelector<HTMLTextAreaElement>("textarea")
                              ?.focus();
                          }}
                        >
                          Done
                        </button>
                      </div>`
                    : nothing}
                </div>
              </div>
              <label
                >Reason (optional)<textarea
                  maxlength="1000"
                  .value=${this.reason}
                  ?disabled=${this.busy}
                  @input=${(event: Event) => {
                    this.reason = (event.target as HTMLTextAreaElement).value;
                  }}
                ></textarea>
              </label>
            `}
        ${this.preview?.status === "sent"
          ? html`<p>This recommendation was already sent.</p>`
          : nothing}
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        <footer>
          <button type="button" ?disabled=${this.busy} @click=${() => this.close()}>
            ${this.preview?.status === "sent" ? "Close" : "Cancel"}
          </button>
          ${this.preview?.status === "pending"
            ? html`<button
                type="button"
                ?disabled=${this.busy}
                @click=${() => {
                  this.preview = undefined;
                  this.requestUpdate();
                }}
              >
                Edit
              </button>`
            : nothing}
          ${this.preview?.status !== "sent"
            ? html`<button
                type="button"
                ?disabled=${this.busy || this.loading || (!this.preview && !this.recipient)}
                @click=${() => this.perform(Boolean(this.preview))}
              >
                ${this.busy
                  ? this.preview
                    ? "Sending…"
                    : "Loading preview…"
                  : this.preview
                    ? "Send in Slack"
                    : "Preview"}
              </button>`
            : nothing}
        </footer>
      </dialog>`;
  }
}
if (!customElements.get("deadline-recommendation")) {
  customElements.define("deadline-recommendation", DeadlineRecommendation);
}
