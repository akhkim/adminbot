import "../../../styles/acquaintance-welcome.css";
import { html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { loadSettings } from "../../storage.ts";
import { memberAuthHeaders } from "../api/device-clock.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";

type WelcomePreview = {
  resend?: boolean;
  email: string;
  subject: string;
  body: string;
  preview_hash: string;
};

/** Preview and queue only: sending remains a separate immutable-payload approval. */
export class AcquaintanceWelcome extends LitElement {
  @property() memberId = "";
  @property() sessionToken = "";
  @state() private custom = false;
  @state() private resend = false;
  @state() private subject = "";
  @state() private body = "";
  @state() private preview: WelcomePreview | null = null;
  @state() private notice = "";
  @state() private busy = false;
  private generation = 0;
  private previewToken = "";
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("memberId") || changed.has("sessionToken")) {
      this.generation++;
      this.preview = null;
      this.subject = this.body = this.notice = this.previewToken = "";
      this.custom = false;
      this.resend = false;
      this.busy = false;
    }
  }
  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }
  private invalidate(event: Event) {
    event.stopPropagation();
    this.preview = null;
    this.generation++;
  }
  private async run(queue = false) {
    const session = loadStoredMemberSession();
    if (!session || session.sessionToken !== this.sessionToken || this.busy || !this.memberId) {
      return;
    }
    if (queue && (!this.preview || this.previewToken !== session.sessionToken)) {
      this.preview = null;
      this.notice = "Preview again in the current admin session.";
      return;
    }
    const generation = this.generation;
    const memberId = this.memberId;
    this.busy = true;
    this.notice = "";
    try {
      const response = await fetch(
        `${resolveAdminBotBaseUrl(loadSettings()).replace(/\/$/u, "")}/lab/members/${encodeURIComponent(memberId)}/onboarding/welcome/${queue ? "queue" : "preview"}`,
        {
          method: "POST",
          headers: {
            ...memberAuthHeaders(session.sessionToken),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            resend: this.resend,
            ...(this.custom
              ? { ...(this.subject.trim() ? { subject: this.subject } : {}), body: this.body }
              : {}),
            ...(queue ? { preview_hash: this.preview!.preview_hash } : {}),
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const data = await response.json();
      if (
        generation !== this.generation ||
        memberId !== this.memberId ||
        loadStoredMemberSession()?.sessionToken !== session.sessionToken ||
        !this.isConnected
      ) {
        return;
      }
      if (!response.ok) {
        throw new Error(data.error?.message ?? "Welcome request failed.");
      }
      if (queue) {
        this.notice = data.detail;
        this.preview = null;
      } else {
        this.preview = data;
        this.previewToken = session.sessionToken;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.notice = error instanceof Error ? error.message : "Welcome request failed.";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }
  override render() {
    return html`<section
      class="callout"
      aria-label="Acquaintance welcome email"
      @change=${(event: Event) => event.stopPropagation()}
    >
      <strong>Welcome email</strong>
      <p>
        Use the standard welcome or write a custom email. The correspondence address is separate
        from the Slack invitation address. Previewing and queueing send nothing.
      </p>
      <label
        ><input
          type="checkbox"
          .checked=${this.custom}
          ?disabled=${this.busy}
          @change=${(event: Event) => {
            this.invalidate(event);
            this.custom = (event.target as HTMLInputElement).checked;
          }}
        />Use a custom email</label
      >
      ${this.custom
        ? html`<label
              >Subject (leave blank for the standard subject)<input
                .value=${this.subject}
                maxlength="200"
                ?disabled=${this.busy}
                @input=${(event: Event) => {
                  this.invalidate(event);
                  this.subject = (event.target as HTMLInputElement).value;
                }} /></label
            ><label
              >Custom email body<textarea
                .value=${this.body}
                maxlength="20000"
                ?disabled=${this.busy}
                @input=${(event: Event) => {
                  this.invalidate(event);
                  this.body = (event.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
            </label>`
        : nothing}
      <label
        ><input
          type="checkbox"
          .checked=${this.resend}
          ?disabled=${this.busy}
          @change=${(event: Event) => {
            this.invalidate(event);
            this.resend = (event.target as HTMLInputElement).checked;
          }}
        />This is a deliberate resend of a previously delivered welcome</label
      >
      <button
        class="btn btn--sm"
        type="button"
        ?disabled=${this.busy || (this.custom && !this.body.trim())}
        @click=${() => this.run()}
      >
        Preview welcome email
      </button>
      ${this.preview
        ? html`<section aria-label="Exact welcome email preview">
            <p>Correspondence recipient: ${this.preview.email}</p>
            <p>Subject: ${this.preview.subject}</p>
            <pre style="white-space:pre-wrap;overflow-wrap:anywhere">${this.preview.body}</pre>
            <button
              class="btn btn--sm primary"
              type="button"
              ?disabled=${this.busy}
              @click=${() => this.run(true)}
            >
              Queue this exact email for approval
            </button>
          </section>`
        : nothing}
      <p role="status">${this.notice}</p>
      <a href="/pending-actions">Review queued emails in Pending actions</a>
    </section>`;
  }
}
if (!customElements.get("adminbot-acquaintance-welcome")) {
  customElements.define("adminbot-acquaintance-welcome", AcquaintanceWelcome);
}
