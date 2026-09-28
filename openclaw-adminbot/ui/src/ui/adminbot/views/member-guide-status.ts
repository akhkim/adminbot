import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { loadSettings } from "../../storage.ts";
import {
  fetchMemberResource,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";

export class MemberGuideStatus extends LitElement {
  @property({ type: String }) memberId = "";
  @state() private detail = "Open this panel to check the onboarding email.";
  @state() private status = "";
  @state() private busy = false;
  private requestId = 0;
  protected override updated(changed: Map<string, unknown>) {
    if (changed.has("memberId") && changed.get("memberId") !== undefined) void this.refresh();
  }
  protected override createRenderRoot() {
    return this;
  }
  override connectedCallback() {
    super.connectedCallback();
    void this.refresh();
  }
  private async refresh() {
    this.status = "";
    const session = loadStoredMemberSession();
    if (!session || !this.memberId) {
      this.detail = "An admin sign-in is required to check onboarding email status.";
      return;
    }
    const memberId = this.memberId;
    const requestId = ++this.requestId;
    this.status = "";
    this.busy = true;
    try {
      const result = await fetchMemberResource(
        `/lab/members/${encodeURIComponent(memberId)}/onboarding/guide`,
        session.sessionToken,
        resolveAdminBotBaseUrl(loadSettings()),
      );
      if (
        loadStoredMemberSession()?.sessionToken !== session.sessionToken ||
        !this.isConnected ||
        this.memberId !== memberId ||
        requestId !== this.requestId
      )
        return;
      if (!result.ok) {
        this.status = "";
        this.detail = "Could not verify the email status. Retry with an admin session.";
        return;
      }
      const value = result.value as { status?: string; detail?: string; recorded_at?: string };
      this.status = value.status ?? "unknown";
      this.detail = `${value.detail ?? "No send confirmation is available."}${value.recorded_at ? ` Recorded ${new Date(value.recorded_at).toLocaleString()}.` : ""}`;
    } finally {
      if (requestId === this.requestId) this.busy = false;
    }
  }
  override render() {
    return html`<section class="callout" aria-label="Onboarding email status">
      <strong
        >Onboarding email${this.status ? ` — ${this.status.replaceAll("_", " ")}` : ""}</strong
      >
      <p role="status">${this.busy ? "Checking the send audit…" : this.detail}</p>
      <button
        class="btn btn--sm"
        type="button"
        ?disabled=${this.busy}
        @click=${() => void this.refresh()}
      >
        Refresh status
      </button>
      ${this.status === "pending" || this.status === "approved"
        ? html`<a href="/pending-actions">Review in Pending Actions</a>`
        : nothing}
    </section>`;
  }
}

if (!customElements.get("adminbot-member-guide-status"))
  customElements.define("adminbot-member-guide-status", MemberGuideStatus);
