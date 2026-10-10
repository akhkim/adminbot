import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { loadSettings } from "../../storage.ts";
import {
  fetchMemberResource,
  loadStoredMemberSession,
  queueMemberOnboardingGuide,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";

// Statuses the service reports once the guide has reached the person. Sending again from one of
// these is a deliberate resend, which the service only accepts when asked for by name.
const REACHED = new Set(["sent", "executed"]);
// Statuses with nothing to send from here: a copy is already waiting for an approver, or the
// Member Type's onboarding is not a mail at all.
const NOTHING_TO_SEND = new Set(["", "unknown", "pending", "approved", "not_applicable"]);

export class MemberGuideStatus extends LitElement {
  @property({ type: String }) memberId = "";
  @state() private detail = "Open this panel to check the onboarding email.";
  @state() private status = "";
  @state() private busy = false;
  @state() private confirming = false;
  @state() private sendResult: { kind: "ok" | "error"; text: string } | null = null;
  private requestId = 0;
  protected override updated(changed: Map<string, unknown>) {
    if (changed.has("memberId") && changed.get("memberId") !== undefined) {
      this.confirming = false;
      this.sendResult = null;
      void this.refresh();
    }
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
  // The service decides what this click does: the full-member guide goes out on this admin's
  // approval, every other template lands in Pending Actions. Its sentence says which happened.
  private async send() {
    const session = loadStoredMemberSession();
    if (!session || !this.memberId) {
      this.sendResult = { kind: "error", text: "An admin sign-in is required to send this." };
      return;
    }
    const memberId = this.memberId;
    const resend = REACHED.has(this.status);
    this.confirming = false;
    this.sendResult = null;
    this.busy = true;
    try {
      const result = await queueMemberOnboardingGuide(
        memberId,
        session.sessionToken,
        resolveAdminBotBaseUrl(loadSettings()),
        undefined,
        { resend },
      );
      if (!this.isConnected || this.memberId !== memberId) return;
      this.sendResult = result.ok
        ? {
            kind: "ok",
            text:
              result.value.detail ??
              (result.value.status === "done" ? "Sent." : "Queued for approval."),
          }
        : {
            kind: "error",
            text:
              result.message ??
              (result.kind === "forbidden"
                ? "Your session no longer has admin access — sign in again and retry."
                : "Couldn't send the onboarding email. Try again."),
          };
    } finally {
      this.busy = false;
    }
    await this.refresh();
  }
  private renderSend() {
    if (NOTHING_TO_SEND.has(this.status)) return nothing;
    const label = REACHED.has(this.status) ? "Resend onboarding email" : "Send onboarding email";
    if (!this.confirming)
      return html`<button
        class="btn btn--sm"
        type="button"
        ?disabled=${this.busy}
        @click=${() => {
          this.confirming = true;
        }}
      >
        ${label}
      </button>`;
    return html`<span role="group" aria-label="Confirm onboarding email">
      ${REACHED.has(this.status)
        ? "This mails the guide to them again. Their DCS account request is not filed a second time."
        : "This mails the onboarding guide to them."}
      <button
        class="btn btn--sm primary"
        type="button"
        ?disabled=${this.busy}
        @click=${() => void this.send()}
      >
        Confirm
      </button>
      <button
        class="btn btn--sm"
        type="button"
        ?disabled=${this.busy}
        @click=${() => {
          this.confirming = false;
        }}
      >
        Cancel
      </button>
    </span>`;
  }
  override render() {
    return html`<section class="callout" aria-label="Onboarding email status">
      <strong
        >Onboarding email${this.status ? ` — ${this.status.replaceAll("_", " ")}` : ""}</strong
      >
      <p role="status">${this.busy ? "Checking the send audit…" : this.detail}</p>
      ${this.sendResult
        ? html`<p role=${this.sendResult.kind === "error" ? "alert" : "status"}>
            ${this.sendResult.text}
          </p>`
        : nothing}
      <button
        class="btn btn--sm"
        type="button"
        ?disabled=${this.busy}
        @click=${() => void this.refresh()}
      >
        Refresh status
      </button>
      ${this.renderSend()}
      ${this.status === "pending" || this.status === "approved"
        ? html`<a href="/pending-actions">Review in Pending Actions</a>`
        : nothing}
    </section>`;
  }
}

if (!customElements.get("adminbot-member-guide-status"))
  customElements.define("adminbot-member-guide-status", MemberGuideStatus);
