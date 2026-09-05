// Control UI view renders the AdminBot Opportunities board: PhD programs, internships, grants and
// awards, and Rising Stars workshops, split across sub-tabs.
//
// Two sources, merged at read time. The bundled OPPORTUNITIES snapshot is lab-vetted and ships with
// the build. Member-contributed entries come from the service, which decides what this caller may
// see: approved entries for everybody including a signed-out visitor, plus the caller's own
// submissions whatever state they are in. The board is a public tab, so the add/edit/delete
// controls only render for a member with a session -- and the service re-checks every one of them,
// because the hidden control is visibility, not security.
//
// Undated entries are first-class here rather than filtered out: an annual program whose next
// cycle has not been announced is still the thing a member wants to know exists. They render as
// "Deadline TBA" and sort last, never as an expired or invented date.
import { html, nothing, LitElement } from "lit";
import {
  deleteOpportunity,
  decideOpportunity,
  decideOpportunityDeadline,
  fetchOpportunities,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  submitOpportunity,
  updateOpportunity,
} from "../auth/session.ts";
import {
  OPPORTUNITIES,
  OPPORTUNITY_CATEGORIES,
  OPPORTUNITY_CATEGORY_LABELS,
  isContributedOpportunity,
  type AdminBotOpportunityDraft,
  type AdminBotOpportunityView,
  type Opportunity,
  type OpportunityCategory,
} from "../data/opportunities-data.ts";

const MS_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Filter = OpportunityCategory | "all";

// AoE (UTC-12): a wall-clock deadline maps to its UTC instant + 12h. Same convention as the
// deadlines board, so a date means the same thing on both tabs.
function aoeInstantMs(aoe: string): number {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(aoe);
  if (!m) {
    return Number.NaN;
  }
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) + 12 * 3600 * 1000;
}

function aoeDateLabel(aoe: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})/u.exec(aoe);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : "";
}

// "in 12 days" / "in 1 day" / "today". Deliberately coarser than the deadlines board's live
// countdown: this is a browsing surface, not a submission-day clock.
function relativeLabel(instant: number, now: number): string {
  const days = Math.floor((instant - now) / MS_DAY);
  if (days < 0) {
    return "closed";
  }
  if (days === 0) {
    return "today";
  }
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

function urgencyColor(instant: number, now: number): string {
  if (!Number.isFinite(instant)) {
    return "#66799a";
  }
  const days = Math.floor((instant - now) / MS_DAY);
  if (days < 0) {
    return "#66799a";
  }
  if (days <= 7) {
    return "#f2606a";
  }
  if (days <= 30) {
    return "#eab54a";
  }
  return "#34d3a6";
}

type Row = { item: Opportunity | AdminBotOpportunityView; instant: number };

// Dated entries ascending, then undated. NaN never participates in the numeric compare, so the
// ordering stays total regardless of how many entries are undated.
function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const aDated = Number.isFinite(a.instant);
    const bDated = Number.isFinite(b.instant);
    if (aDated && bDated) {
      return a.instant - b.instant;
    }
    if (aDated !== bDated) {
      return aDated ? -1 : 1;
    }
    return a.item.name.localeCompare(b.item.name);
  });
}

export type BoardEntry = Opportunity | AdminBotOpportunityView;

export function opportunityRows(filter: Filter, items: BoardEntry[] = OPPORTUNITIES): Row[] {
  const scoped = filter === "all" ? items : items.filter((item) => item.category === filter);
  return sortRows(scoped.map((item) => ({ item, instant: aoeInstantMs(item.deadline_aoe) })));
}

export function categoryCount(category: Filter, items: BoardEntry[] = OPPORTUNITIES): number {
  return category === "all"
    ? items.length
    : items.filter((item) => item.category === category).length;
}

const EMPTY_FORM: () => AdminBotOpportunityDraft = () => ({
  name: "",
  category: "rising_stars",
  org: "",
  deadline_aoe: "",
  link: "",
  eligibility: "",
  note: "",
  application_window: "",
});

// Custom element so the sub-tab selection lives with the view rather than in app state -- nothing
// outside this tab needs to know which category is showing. The filter is a plain field driven by
// an explicit requestUpdate(), not a Lit reactive property: a declared property plus a class field
// would shadow the generated accessor and silently break reactivity.
class AdminbotOpportunitiesView extends LitElement {
  private filter: Filter = "all";
  private formOpen = false;
  private form = EMPTY_FORM();
  private deadlineTba = false;
  private pendingDeleteId: string | null = null;
  private editingId: string | null = null;
  /**
   * Whether this viewer may contribute at all.
   *
   * Read once from the stored session rather than passed in, because this element is rendered from
   * two places -- the signed-in app and the visitor shell -- and only one of them has props to
   * give it. A stale `true` here buys nothing: every write is re-checked by the service against the
   * session token, so the worst case is a control that renders and then reports a 401.
   */
  private signedIn = Boolean(loadStoredMemberSession());
  private contributed: AdminBotOpportunityView[] = [];
  private notice: { kind: "error" | "success"; text: string } | null = null;
  private busy = false;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    const stored = loadStoredMemberSession();
    this.signedIn = Boolean(stored);
    const result = await fetchOpportunities(resolveAdminBotBaseUrl(), stored?.sessionToken ?? null);
    // A board that cannot reach the service still has the bundled half to show, which is the whole
    // tab for a visitor anyway. Failing to a blank page would be worse than failing to the snapshot.
    this.contributed = result.ok ? result.value : [];
    this.requestUpdate();
  }

  /** The bundled snapshot plus whatever the service decided this caller may see. */
  private entries(): BoardEntry[] {
    return [...OPPORTUNITIES, ...this.contributed];
  }

  private select(next: Filter): void {
    this.filter = next;
    this.requestUpdate();
  }

  private openForm(): void {
    this.form = EMPTY_FORM();
    this.deadlineTba = false;
    this.formOpen = true;
    this.requestUpdate();
  }

  private closeForm(): void {
    this.formOpen = false;
    this.editingId = null;
    this.requestUpdate();
  }

  private updateField<K extends keyof AdminBotOpportunityDraft>(
    key: K,
    value: AdminBotOpportunityDraft[K],
  ): void {
    (this.form as Record<string, unknown>)[key] = value;
    this.requestUpdate();
  }

  private toggleDeadlineTba(): void {
    this.deadlineTba = !this.deadlineTba;
    if (this.deadlineTba) {
      this.form.deadline_aoe = "";
    }
    this.requestUpdate();
  }

  private async submitForm(): Promise<void> {
    const stored = loadStoredMemberSession();
    if (!stored || this.busy) {
      return;
    }
    const draft: AdminBotOpportunityDraft = {
      ...this.form,
      name: this.form.name.trim(),
      org: this.form.org?.trim() || undefined,
      deadline_aoe: this.form.deadline_aoe?.trim() || "",
      link: this.form.link?.trim() || undefined,
      eligibility: this.form.eligibility?.trim() || undefined,
      note: this.form.note?.trim() || undefined,
      application_window: this.form.application_window?.trim() || undefined,
    };
    if (!draft.name) {
      return;
    }
    this.busy = true;
    this.notice = null;
    this.requestUpdate();
    try {
      const baseUrl = resolveAdminBotBaseUrl();
      const result = this.editingId
        ? await updateOpportunity(this.editingId, draft, stored.sessionToken, baseUrl)
        : await submitOpportunity(draft, stored.sessionToken, baseUrl);
      if (!result.ok) {
        this.notice = { kind: "error", text: result.message ?? "That could not be saved." };
        return;
      }
      this.notice = {
        kind: "success",
        // Worth saying out loud: a member who adds an entry and cannot find it on the board should
        // learn here that it is waiting on review, not conclude the save failed.
        text: this.editingId
          ? "Saved."
          : "Submitted. An admin reviews it before it appears for the rest of the lab.",
      };
      this.formOpen = false;
      this.editingId = null;
      await this.load();
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  private deleteOpp(id: string): void {
    this.pendingDeleteId = id;
    this.requestUpdate();
  }

  private async confirmDelete(): Promise<void> {
    const stored = loadStoredMemberSession();
    const id = this.pendingDeleteId;
    if (!stored || !id || this.busy) {
      this.pendingDeleteId = null;
      this.requestUpdate();
      return;
    }
    this.busy = true;
    this.requestUpdate();
    try {
      const result = await deleteOpportunity(id, stored.sessionToken, resolveAdminBotBaseUrl());
      this.notice = result.ok
        ? { kind: "success", text: "Removed." }
        : { kind: "error", text: result.message ?? "That could not be removed." };
      this.pendingDeleteId = null;
      await this.load();
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  private cancelDelete(): void {
    this.pendingDeleteId = null;
    this.requestUpdate();
  }

  /**
   * Approve or reject, for an admin.
   *
   * Rendered off the entry's own `status` rather than off a privilege flag this element does not
   * have: a pending row is only ever visible to its submitter or an admin, and the submitter's
   * attempt is refused by the service with a 403 that lands in `notice`.
   */
  /**
   * Accept or dismiss a date the refresh sweep read off this entry's own page.
   *
   * The sweep may only propose. This is where a swept date becomes a published one, and it is a
   * person doing it -- the board is planned against, and a page carrying last year's date is
   * indistinguishable from one carrying next year's until somebody reads it.
   */
  private async decideDeadline(id: string, accept: boolean): Promise<void> {
    const stored = loadStoredMemberSession();
    if (!stored || this.busy) {
      return;
    }
    this.busy = true;
    this.requestUpdate();
    try {
      const result = await decideOpportunityDeadline(
        id,
        accept,
        stored.sessionToken,
        resolveAdminBotBaseUrl(),
      );
      this.notice = result.ok
        ? { kind: "success", text: accept ? "Deadline updated." : "Proposal dismissed." }
        : { kind: "error", text: result.message ?? "That decision could not be recorded." };
      await this.load();
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  private async decide(id: string, decision: "approve" | "reject"): Promise<void> {
    const stored = loadStoredMemberSession();
    if (!stored || this.busy) {
      return;
    }
    this.busy = true;
    this.requestUpdate();
    try {
      const result = await decideOpportunity(
        id,
        decision,
        stored.sessionToken,
        resolveAdminBotBaseUrl(),
      );
      this.notice = result.ok
        ? { kind: "success", text: decision === "approve" ? "Approved." : "Rejected." }
        : { kind: "error", text: result.message ?? "That decision could not be recorded." };
      await this.load();
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  private editOpp(id: string): void {
    const opp = this.contributed.find((entry) => entry.id === id);
    if (!opp) {
      return;
    }
    this.editingId = id;
    this.form = {
      name: opp.name,
      category: opp.category,
      org: opp.org ?? "",
      deadline_aoe: opp.deadline_aoe,
      link: opp.link ?? "",
      eligibility: opp.eligibility ?? "",
      note: opp.note ?? "",
      application_window: opp.application_window ?? "",
    };
    this.deadlineTba = !opp.deadline_aoe;
    this.formOpen = true;
    this.requestUpdate();
  }

  private renderForm() {
    if (!this.formOpen) {
      return nothing;
    }
    return html`
      <div class="opp-form-backdrop" @click=${() => this.closeForm()}>
        <form
          class="opp-form"
          @click=${(e: Event) => e.stopPropagation()}
          @submit=${(e: SubmitEvent) => {
            e.preventDefault();
            void this.submitForm();
          }}
        >
          <h3 class="opp-form-title">${this.editingId ? "Edit" : "Add"} Opportunity</h3>

          <label class="opp-form-field">
            <span class="opp-form-label">Name *</span>
            <input
              class="opp-form-input"
              type="text"
              required
              placeholder="Research Internship"
              .value=${this.form.name}
              @input=${(e: Event) => this.updateField("name", (e.target as HTMLInputElement).value)}
            />
          </label>

          <label class="opp-form-field">
            <span class="opp-form-label">Category</span>
            <select
              class="opp-form-input"
              .value=${this.form.category}
              @change=${(e: Event) =>
                this.updateField(
                  "category",
                  (e.target as HTMLSelectElement).value as OpportunityCategory,
                )}
            >
              ${OPPORTUNITY_CATEGORIES.map(
                (cat) => html`<option value=${cat} ?selected=${cat === this.form.category}>
                  ${OPPORTUNITY_CATEGORY_LABELS[cat]}
                </option>`,
              )}
            </select>
          </label>

          <label class="opp-form-field">
            <span class="opp-form-label">Host / Organiser</span>
            <input
              class="opp-form-input"
              type="text"
              placeholder="e.g. MIT, Google"
              .value=${this.form.org ?? ""}
              @input=${(e: Event) => this.updateField("org", (e.target as HTMLInputElement).value)}
            />
          </label>

          <label class="opp-form-field">
            <span class="opp-form-label">Description</span>
            <textarea
              class="opp-form-input opp-form-textarea"
              rows="2"
              placeholder="Who is this for, what does it offer?"
              .value=${this.form.eligibility ?? ""}
              @input=${(e: Event) =>
                this.updateField("eligibility", (e.target as HTMLTextAreaElement).value)}
            ></textarea>
          </label>

          <label class="opp-form-field">
            <span class="opp-form-label">Application window</span>
            <input
              class="opp-form-input"
              type="text"
              placeholder="e.g. Sep 1 – Oct 15, 2026"
              .value=${this.form.application_window ?? ""}
              @input=${(e: Event) =>
                this.updateField("application_window", (e.target as HTMLInputElement).value)}
            />
          </label>

          <div class="opp-form-field">
            <span class="opp-form-label">Deadline (AoE)</span>
            <div class="opp-deadline-row">
              ${this.deadlineTba
                ? html`<span class="opp-tba-badge">TBA</span>`
                : html`
                    <input
                      class="opp-form-input opp-form-input--grow"
                      type="datetime-local"
                      .value=${this.form.deadline_aoe?.slice(0, 16) ?? ""}
                      @input=${(e: Event) => {
                        const v = (e.target as HTMLInputElement).value;
                        this.updateField("deadline_aoe", v ? `${v.replace("T", " ")}:00` : "");
                      }}
                    />
                  `}
              <button
                type="button"
                class=${`opp-tba-toggle ${this.deadlineTba ? "opp-tba-toggle--active" : ""}`}
                @click=${() => this.toggleDeadlineTba()}
                title=${this.deadlineTba ? "Set a date" : "Mark as TBA"}
              >
                TBA
              </button>
            </div>
          </div>

          <label class="opp-form-field">
            <span class="opp-form-label">Link</span>
            <input
              class="opp-form-input"
              type="url"
              placeholder="https://..."
              .value=${this.form.link ?? ""}
              @input=${(e: Event) => this.updateField("link", (e.target as HTMLInputElement).value)}
            />
          </label>

          <div class="opp-form-actions">
            <button type="button" class="opp-form-btn" @click=${() => this.closeForm()}>
              Cancel
            </button>
            <button type="submit" class="opp-form-btn opp-form-btn--primary">
              ${this.editingId ? "Confirm" : "Add"}
            </button>
          </div>
        </form>
      </div>
    `;
  }

  private renderDeleteConfirm() {
    if (!this.pendingDeleteId) {
      return nothing;
    }
    return html`
      <div class="opp-confirm-backdrop" @click=${() => this.cancelDelete()}>
        <div class="opp-confirm" @click=${(e: Event) => e.stopPropagation()}>
          <p class="opp-confirm-text">Remove this opportunity?</p>
          <div class="opp-confirm-actions">
            <button class="opp-form-btn" @click=${() => this.cancelDelete()}>Cancel</button>
            <button
              class="opp-form-btn opp-form-btn--danger"
              @click=${() => void this.confirmDelete()}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderTabs(entries: BoardEntry[] = this.entries()) {
    const tabs: Filter[] = ["all", ...OPPORTUNITY_CATEGORIES];
    return html`
      <div class="opp-tabs" role="tablist">
        ${tabs.map((tab) => {
          const count = categoryCount(tab, entries);
          const label = tab === "all" ? "All" : OPPORTUNITY_CATEGORY_LABELS[tab];
          const selected = this.filter === tab;
          return html`
            <button
              class=${`opp-tab ${selected ? "is-active" : ""}`}
              role="tab"
              aria-selected=${selected ? "true" : "false"}
              @click=${() => this.select(tab)}
            >
              ${label}
              <span class="opp-tab-count">${count}</span>
            </button>
          `;
        })}
      </div>
    `;
  }

  private renderRow({ item, instant }: Row, now: number) {
    const dated = Number.isFinite(instant);
    const contributed = isContributedOpportunity(item);
    const pending = contributed && item.status === "pending";
    // Only a member with a session gets controls at all, and only over the contributed half: a
    // bundled row has no server-side identity to edit. The service re-checks both.
    const mine = contributed && this.signedIn;
    return html`
      <div class="opp-row" style=${`--u:${urgencyColor(instant, now)}`}>
        <div class="opp-when">
          <span class="opp-date">
            ${dated ? `${aoeDateLabel(item.deadline_aoe)} AoE` : "Deadline TBA"}
          </span>
          ${dated ? html`<span class="opp-rel">${relativeLabel(instant, now)}</span>` : nothing}
          ${item.application_window
            ? html`<span class="opp-window">${item.application_window}</span>`
            : nothing}
        </div>
        <div class="opp-body">
          <div class="opp-name">
            ${item.name}
            ${item.link
              ? html`<a href=${item.link} target="_blank" rel="noopener" title="Open program page"
                  >↗</a
                >`
              : nothing}
            ${contributed
              ? html`<span class="opp-member-tag"
                  >${item.submitted_by_name
                    ? `suggested by ${item.submitted_by_name}`
                    : "member-contributed"}</span
                >`
              : nothing}
            ${pending
              ? html`<span class="opp-pending-tag" title="Waiting on an admin review"
                  >awaiting review</span
                >`
              : nothing}
          </div>
          ${item.org ? html`<div class="opp-org">${item.org}</div>` : nothing}
          ${item.eligibility ? html`<div class="opp-elig">${item.eligibility}</div>` : nothing}
          ${item.note ? html`<div class="opp-note">${item.note}</div>` : nothing}
        </div>
        <!-- Where it came from, when nobody submitted it. A candidate a sweep filed is a claim
             about somebody else's page, so the reviewer gets the line it was read out of and a
             link to check it -- the same bargain the deadline proposal below makes. -->
        ${mine && item.discovered
          ? html`<div class="opp-proposal" data-testid="opp-discovered">
              <div class="opp-proposal__head">
                <strong>Found by the weekly sweep — not submitted by a member</strong>
                <a href=${item.discovered.source_url} target="_blank" rel="noreferrer noopener"
                  >the page it came from</a
                >
              </div>
              <blockquote class="opp-proposal__evidence">${item.discovered.evidence}</blockquote>
            </div>`
          : nothing}
        ${mine && item.proposed_deadline
          ? html`<div class="opp-proposal" data-testid="opp-proposal">
              <div class="opp-proposal__head">
                <strong>${item.proposed_deadline.deadline_aoe.slice(0, 10)}</strong>
                <span
                  >read off
                  <a
                    href=${item.proposed_deadline.source_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    >the programme page</a
                  ></span
                >
              </div>
              <!-- The line the date was read out of. Without it this is a bare assertion and the
                   reviewer has to open the page anyway, which is the work the sweep removes. -->
              <blockquote class="opp-proposal__evidence">
                ${item.proposed_deadline.evidence}
              </blockquote>
              <div class="opp-proposal__actions">
                <button
                  class="opp-form-btn opp-form-btn--primary"
                  ?disabled=${this.busy}
                  data-testid="opp-proposal-accept"
                  @click=${() => void this.decideDeadline(item.id, true)}
                >
                  Use this date
                </button>
                <button
                  class="opp-form-btn"
                  ?disabled=${this.busy}
                  data-testid="opp-proposal-dismiss"
                  @click=${() => void this.decideDeadline(item.id, false)}
                >
                  Dismiss
                </button>
              </div>
            </div>`
          : nothing}
        ${mine
          ? html`<div class="opp-actions">
              ${pending
                ? html`
                    <button
                      class="opp-form-btn opp-form-btn--primary opp-decide"
                      ?disabled=${this.busy}
                      @click=${() => void this.decide(item.id, "approve")}
                    >
                      Approve
                    </button>
                    <button
                      class="opp-form-btn opp-decide"
                      ?disabled=${this.busy}
                      @click=${() => void this.decide(item.id, "reject")}
                    >
                      Reject
                    </button>
                  `
                : nothing}
              <button
                class="opp-edit"
                title="Edit"
                ?disabled=${this.busy}
                @click=${() => this.editOpp(item.id)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              </button>
              <button
                class="opp-delete"
                title="Remove"
                ?disabled=${this.busy}
                @click=${() => this.deleteOpp(item.id)}
              >
                &times;
              </button>
            </div>`
          : nothing}
      </div>
    `;
  }

  override render() {
    const now = Date.now();
    const entries = this.entries();
    const rows = opportunityRows(this.filter, entries);
    return html`
      <style>
        .opportunities-view {
          padding: 4px 2px 24px;
        }
        .opportunities-view .intro {
          color: var(--text-muted, #9fb0cc);
          font-size: 13.5px;
          margin: 0 0 14px;
        }
        .opp-tabs {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 14px;
        }
        .opp-tab {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border: 1px solid var(--border, #26324a);
          border-radius: 999px;
          background: var(--surface, #141b2b);
          color: var(--text, #d7e2f4);
          font-size: 13px;
          cursor: pointer;
        }
        .opp-tab.is-active {
          border-color: var(--accent, #4f8cff);
          color: var(--accent, #4f8cff);
        }
        .opp-tab-count {
          color: var(--text-muted, #66799a);
          font-size: 11.5px;
          font-variant-numeric: tabular-nums;
        }
        .opp-tab.is-active .opp-tab-count {
          color: inherit;
        }
        .opp-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .opp-row {
          display: grid;
          grid-template-columns: 160px 1fr auto;
          gap: 12px;
          padding: 11px 14px;
          border: 1px solid var(--border, #26324a);
          border-left: 4px solid var(--u);
          border-radius: 10px;
          background: var(--surface, #141b2b);
          align-items: start;
        }
        .opp-when {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .opp-date {
          font-variant-numeric: tabular-nums;
          font-size: 13px;
        }
        .opp-rel {
          color: var(--u);
          font-size: 11.5px;
          font-weight: 600;
        }
        .opp-window {
          color: var(--text-muted, #9fb0cc);
          font-size: 11px;
          margin-top: 2px;
        }
        .opp-name {
          font-size: 13.5px;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .opp-org {
          color: var(--text-muted, #9fb0cc);
          font-size: 12px;
          margin-top: 2px;
        }
        .opp-elig {
          color: var(--text-muted, #9fb0cc);
          font-size: 12px;
          margin-top: 4px;
        }
        .opp-note {
          color: var(--text-muted, #66799a);
          font-size: 11.5px;
          margin-top: 4px;
        }
        .opp-notice {
          margin: 0 0 12px;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 13px;
          border: 1px solid var(--border, #26324a);
        }
        .opp-notice--success {
          border-color: rgba(52, 199, 123, 0.4);
          color: #34c77b;
          background: rgba(52, 199, 123, 0.1);
        }
        .opp-notice--error {
          border-color: rgba(248, 113, 113, 0.4);
          color: #f87171;
          background: rgba(248, 113, 113, 0.1);
        }
        .opp-pending-tag {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: #f5a524;
          background: rgba(245, 165, 36, 0.14);
          padding: 1px 6px;
          border-radius: 4px;
          flex-shrink: 0;
        }
        .opp-decide {
          padding: 3px 10px;
          font-size: 12px;
        }
        /* The refresh sweep's finding, sitting under the entry it is about. Framed as a quote
           rather than as a value, because it is a reading of somebody else's page and the
           reviewer's job is to judge it. */
        .opp-proposal {
          margin-top: 8px;
          padding: 8px 10px;
          border: 1px solid rgba(96, 165, 250, 0.35);
          border-radius: 6px;
          background: rgba(96, 165, 250, 0.08);
          display: grid;
          gap: 6px;
        }
        .opp-proposal__head {
          display: flex;
          align-items: baseline;
          gap: 8px;
          flex-wrap: wrap;
          font-size: 13px;
        }
        .opp-proposal__evidence {
          margin: 0;
          padding-left: 10px;
          border-left: 2px solid rgba(148, 163, 184, 0.4);
          color: var(--muted, #94a3b8);
          font-size: 12px;
          line-height: 1.45;
          white-space: pre-wrap;
        }
        .opp-proposal__actions {
          display: flex;
          gap: 8px;
        }
        .opp-edit:disabled,
        .opp-delete:disabled,
        .opp-decide:disabled {
          opacity: 0.5;
          cursor: default;
        }
        .opp-member-tag {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--accent, #4f8cff);
          background: rgba(79, 140, 255, 0.12);
          padding: 1px 6px;
          border-radius: 4px;
          flex-shrink: 0;
        }
        .opp-delete {
          background: none;
          border: none;
          border-radius: 6px;
          color: #f87171;
          font-size: 18px;
          line-height: 1;
          cursor: pointer;
          padding: 2px 6px;
          align-self: start;
          transition: color 0.12s;
        }
        .opp-delete:hover {
          color: #ef4444;
        }
        .opp-actions {
          display: flex;
          gap: 4px;
          align-self: start;
        }
        .opp-edit {
          background: none;
          border: none;
          border-radius: 6px;
          color: var(--text-muted, #66799a);
          cursor: pointer;
          padding: 2px 6px;
          display: flex;
          align-items: center;
          transition: color 0.12s;
        }
        .opp-edit svg {
          width: 14px;
          height: 14px;
        }
        .opp-edit:hover {
          color: var(--accent, #4f8cff);
        }
        .opp-fab {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          border: 1px solid var(--border, #26324a);
          background: var(--surface, #141b2b);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 12px 0 0 auto;
          flex-shrink: 0;
          padding: 0;
          transition:
            background 0.12s,
            border-color 0.12s;
        }
        .opp-fab svg {
          width: 20px;
          height: 20px;
          stroke: var(--text, #d7e2f4);
          stroke-width: 2;
          fill: none;
          transition: stroke 0.12s;
        }
        .opp-fab:hover {
          background: rgba(79, 140, 255, 0.12);
          border-color: var(--accent, #4f8cff);
        }
        .opp-fab:hover svg {
          stroke: var(--accent, #4f8cff);
        }
        .opp-form-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 100;
        }
        .opp-confirm-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 100;
        }
        .opp-confirm {
          background: var(--surface, #141b2b);
          border: 1px solid var(--border, #26324a);
          border-radius: 12px;
          padding: 20px 24px;
          min-width: 260px;
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
        }
        .opp-confirm-text {
          margin: 0 0 16px;
          font-size: 14px;
          color: var(--text, #d7e2f4);
        }
        .opp-confirm-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }
        .opp-form {
          background: var(--surface, #141b2b);
          border: 1px solid var(--border, #26324a);
          border-radius: 12px;
          padding: 24px;
          width: min(420px, 90vw);
          max-height: 85vh;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 14px;
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
        }
        .opp-form-title {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
          color: var(--text, #d7e2f4);
        }
        .opp-form-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .opp-form-label {
          font-size: 12px;
          font-weight: 500;
          color: var(--text-muted, #9fb0cc);
        }
        .opp-form-input {
          padding: 8px 10px;
          border: 1px solid var(--border, #26324a);
          border-radius: 6px;
          background: #1e2a3a;
          color: var(--text, #d7e2f4);
          font-size: 13px;
          font-family: inherit;
          transition: border-color 0.12s;
        }
        .opp-form-input::placeholder {
          color: #5a6d84;
        }
        .opp-form-input:focus {
          outline: none;
          border-color: var(--accent, #4f8cff);
        }
        .opp-form-input--grow {
          flex: 1;
          min-width: 0;
        }
        .opp-form-textarea {
          resize: vertical;
          min-height: 48px;
        }
        .opp-form-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 4px;
        }
        .opp-form-btn {
          padding: 7px 16px;
          border: 1px solid var(--border, #26324a);
          border-radius: 6px;
          background: #1e2a3a;
          color: var(--text, #d7e2f4);
          font-size: 13px;
          cursor: pointer;
        }
        .opp-form-btn--primary {
          background: var(--accent, #4f8cff);
          border-color: var(--accent, #4f8cff);
          color: #fff;
        }
        .opp-form-btn--primary:hover {
          opacity: 0.9;
        }
        .opp-form-btn--danger {
          background: #ef4444;
          border-color: #ef4444;
          color: #fff;
        }
        .opp-form-btn--danger:hover {
          opacity: 0.9;
        }
        .opp-deadline-row {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .opp-tba-badge {
          padding: 8px 12px;
          border: 1px solid var(--border, #26324a);
          border-radius: 6px;
          background: #1e2a3a;
          color: var(--text-muted, #9fb0cc);
          font-size: 13px;
          font-style: italic;
        }
        .opp-tba-toggle {
          padding: 7px 12px;
          border: 1px solid var(--border, #26324a);
          border-radius: 6px;
          background: #1e2a3a;
          color: var(--text-muted, #9fb0cc);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
          flex-shrink: 0;
        }
        .opp-tba-toggle--active {
          border-color: var(--accent, #4f8cff);
          color: var(--accent, #4f8cff);
          background: #e8f0fe;
        }
        .opp-tba-toggle:hover {
          border-color: var(--accent, #4f8cff);
        }
        @media (max-width: 640px) {
          .opp-row {
            grid-template-columns: 1fr;
          }
        }
      </style>
      <section class="opportunities-view">
        <p class="intro">
          Programs the lab wants you to know about. Eligibility is quoted from each program so you
          can judge your own fit &mdash; nothing here is filtered by who you are.
        </p>
        ${this.notice
          ? html`<p class=${`opp-notice opp-notice--${this.notice.kind}`}>${this.notice.text}</p>`
          : nothing}
        ${this.renderTabs(entries)}
        <div class="opp-list">
          ${rows.length === 0
            ? html`<p class="intro">Nothing listed here yet.</p>`
            : rows.map((row) => this.renderRow(row, now))}
        </div>
        ${this.signedIn
          ? html`<button
              class="opp-fab"
              type="button"
              title="Add opportunity"
              @click=${() => this.openForm()}
            >
              <svg viewBox="0 0 24 24">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>`
          : nothing}
        ${this.renderForm()} ${this.renderDeleteConfirm()}
      </section>
    `;
  }
}

if (!customElements.get("adminbot-opportunities-view")) {
  customElements.define("adminbot-opportunities-view", AdminbotOpportunitiesView);
}

export function renderOpportunities() {
  return html`<adminbot-opportunities-view></adminbot-opportunities-view>`;
}
