import type { Registration, RegistrationDecisionInput } from "@adminbot/api-contracts";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import {
  AdminBotApiError,
  RegistrationReviewApiClient,
  type RegistrationReviewClient,
} from "./api-client.js";
import { identityStyles } from "./identity-styles.js";

type ReviewState = Registration["state"] | "all";

export class AdminBotRegistrationReviewApp extends LitElement {
  static override properties = {
    registrations: { state: true },
    loading: { state: true },
    filter: { state: true },
    errorMessage: { state: true },
    decidingId: { state: true },
  };

  static override styles = identityStyles;

  client: RegistrationReviewClient = new RegistrationReviewApiClient({
    serviceOrigin: import.meta.env.VITE_ADMINBOT_API_ORIGIN || window.location.origin,
  });

  declare private registrations: readonly Registration[];
  declare private loading: boolean;
  declare private filter: ReviewState;
  declare private errorMessage: string;
  declare private decidingId: string;

  constructor() {
    super();
    this.registrations = [];
    this.loading = true;
    this.filter = "submitted";
    this.errorMessage = "";
    this.decidingId = "";
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  override render(): TemplateResult {
    return html`
      <section class="identity-layout">
        <div class="intro">
          <p class="eyebrow">Administration</p>
          <h1>Registration review.</h1>
          <p class="lede">
            Inspect roster claims and collaborator applications. Approvals activate an account;
            new applicants receive the least-privileged external collaborator role.
          </p>
        </div>
        <div class="card">
          <div class="queue-toolbar">
            <div><h2>Requests</h2><span class="meta">${this.registrations.length} shown</span></div>
            <select aria-label="Registration state" .value=${this.filter} @change=${this.changeFilter}>
              <option value="submitted">Pending</option>
              <option value="all">All states</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
          ${this.errorMessage ? html`<p class="error" role="alert">${this.errorMessage}</p>` : nothing}
          ${this.renderQueue()}
        </div>
      </section>
    `;
  }

  private renderQueue(): TemplateResult {
    if (this.loading) return html`<p class="empty">Loading registration requests…</p>`;
    if (this.registrations.length === 0) {
      return html`<p class="empty">No registration requests match this view.</p>`;
    }
    return html`<div class="queue">${this.registrations.map((item) => this.renderItem(item))}</div>`;
  }

  private renderItem(item: Registration): TemplateResult {
    const pending = item.state === "submitted" || item.state === "under_review";
    return html`
      <article class="registration">
        <div class="registration-head">
          <div>
            <h3>${item.requestedDisplayName}</h3>
            <span class="meta">${item.requestedLoginHandle} · ${formatDate(item.createdAt)}</span>
          </div>
          <span class="tag">${item.kind} · ${item.state.replace("_", " ")}</span>
        </div>
        ${item.profile === undefined
          ? nothing
          : html`<p class="note">${profileSummary(item.profile)}</p>`}
        ${pending
          ? html`<div class="registration-actions">
              <textarea name=${`reason-${item.id}`} aria-label="Decision reason" placeholder="Optional review note"></textarea>
              <button class="secondary" type="button" ?disabled=${this.decidingId !== ""} @click=${() => this.decide(item, "approve")}>Approve</button>
              <button class="danger" type="button" ?disabled=${this.decidingId !== ""} @click=${() => this.decide(item, "reject")}>Reject</button>
            </div>`
          : nothing}
      </article>
    `;
  }

  private readonly changeFilter = (event: Event): void => {
    this.filter = (event.currentTarget as HTMLSelectElement).value as ReviewState;
    void this.load();
  };

  private async load(): Promise<void> {
    this.loading = true;
    this.errorMessage = "";
    try {
      this.registrations = await this.client.list(this.filter === "all" ? undefined : this.filter);
    } catch (error) {
      this.errorMessage = reviewError(error);
      this.registrations = [];
    } finally {
      this.loading = false;
    }
  }

  private async decide(item: Registration, decision: RegistrationDecisionInput["decision"]): Promise<void> {
    if (this.decidingId !== "") return;
    const reason = this.shadowRoot
      ?.querySelector<HTMLTextAreaElement>(`[name="reason-${item.id}"]`)
      ?.value.trim();
    this.decidingId = item.id;
    this.errorMessage = "";
    try {
      await this.client.decide(item.id, {
        decision,
        ...(reason === undefined || reason === "" ? {} : { reason }),
      });
      await this.load();
    } catch (error) {
      this.errorMessage = reviewError(error);
    } finally {
      this.decidingId = "";
    }
  }
}
function profileSummary(profile: NonNullable<Registration["profile"]>): string {
  return [profile.role, profile.affiliation, profile.researchBranch].filter(Boolean).join(" · ") ||
    "No optional profile summary supplied.";
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "date unavailable" : parsed.toLocaleString();
}

function reviewError(error: unknown): string {
  if (error instanceof AdminBotApiError && error.status === 403) {
    return error.message.includes("reauthentication")
      ? "Please sign out and sign in again before deciding a request."
      : "Administrator access is required.";
  }
  if (error instanceof AdminBotApiError && error.status === 409) {
    return "This request was already decided. Refreshing will show its current state.";
  }
  return "AdminBot could not load or update registration requests.";
}
