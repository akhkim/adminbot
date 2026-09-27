import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { loadSettings } from "../../storage.ts";
import {
  fetchMemberResource,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  sendLocalChat,
} from "../auth/session.ts";

type Message = { role: "user" | "assistant"; content: string };

/** Text-only local chat, isolated from gateway tools and persistent chat transcripts. */
export class LocalChat extends LitElement {
  @property({ type: String }) sessionToken = "";
  @state() private available = false;
  @state() private model = "";
  @state() private messages: Message[] = [];
  @state() private draft = "";
  @state() private busy = false;
  @state() private error = "";
  private generation = 0;
  protected override createRenderRoot() {
    return this;
  }
  protected override updated(changed: Map<string, unknown>) {
    if (changed.has("sessionToken")) {
      this.clear();
      this.available = false;
      void this.checkAccess();
    }
  }
  override disconnectedCallback() {
    this.clear();
    this.available = false;
    super.disconnectedCallback();
  }
  private clear() {
    this.generation++;
    this.messages = [];
    this.draft = "";
    this.error = "";
    this.busy = false;
  }
  private current(token: string, generation: number) {
    const session = loadStoredMemberSession();
    return (
      this.isConnected &&
      this.sessionToken === token &&
      session?.sessionToken === token &&
      !session.impersonator &&
      generation === this.generation
    );
  }
  private async checkAccess() {
    const token = this.sessionToken;
    const generation = this.generation;
    if (!token || !this.current(token, generation)) return;
    const result = await fetchMemberResource(
      "/local-chat",
      token,
      resolveAdminBotBaseUrl(loadSettings()),
    );
    if (!this.current(token, generation) || !result.ok) return;
    const value = result.value as { model?: unknown; route?: unknown } | null;
    if (value?.route === "local" && typeof value.model === "string") {
      this.model = value.model;
      this.available = true;
    }
  }
  private async send(event: Event) {
    event.preventDefault();
    const token = this.sessionToken;
    const generation = this.generation;
    if (this.busy || !this.available || !this.draft.trim() || !this.current(token, generation))
      return;
    const next: Message[] = [...this.messages, { role: "user", content: this.draft.trim() }];
    if (next.length > 23 || next.reduce((sum, row) => sum + row.content.length, 0) > 32000) {
      this.error = "Conversation limit reached. Clear the chat to start again.";
      return;
    }
    this.busy = true;
    this.error = "";
    try {
      const result = await sendLocalChat(next, token, resolveAdminBotBaseUrl(loadSettings()));
      if (!this.current(token, generation)) return;
      if (!result.ok) {
        this.error = "Local chat could not answer. No external model was used. Retry shortly.";
        return;
      }
      if (result.value.model !== this.model) {
        this.error = "The local model changed. Clear the chat and reopen My Desk.";
        return;
      }
      this.messages = [...next, { role: "assistant", content: result.value.output }];
      this.draft = "";
    } finally {
      if (this.current(token, generation)) this.busy = false;
    }
  }
  override render() {
    if (!this.available) return nothing;
    return html`<section class="card" aria-label="Local chat">
      <div class="card-title">Local chat</div>
      <p class="muted">Aurora only · Configured model: ${this.model}</p>
      <p>
        No external providers, tools, or lab-record access. This conversation is not saved by
        AdminBot; clear it when finished. Other AdminBot chat and tools have separate routing.
      </p>
      <div aria-live="polite">
        ${this.messages.map(
          (row) =>
            html`<p style="overflow-wrap: anywhere">
              <strong>${row.role === "user" ? "You" : "Local model"}</strong><br /><span
                style="white-space: pre-wrap"
                >${row.content}</span
              >
            </p>`,
        )}
      </div>
      <form @submit=${(event: Event) => void this.send(event)}>
        <label class="adminbot-form__field"
          ><span>Message to the local model</span>
          <textarea
            rows="4"
            maxlength="8000"
            required
            .value=${this.draft}
            ?disabled=${this.busy}
            @input=${(event: Event) => {
              this.draft = (event.target as HTMLTextAreaElement).value;
            }}
          ></textarea>
        </label>
        <div class="adminbot-form__actions">
          <button class="btn primary" type="submit" ?disabled=${this.busy || !this.draft.trim()}>
            ${this.busy ? "Waiting for local model…" : "Send locally"}
          </button>
          <button class="btn" type="button" @click=${() => this.clear()}>Clear chat</button>
        </div>
      </form>
      ${this.busy
        ? html`<p role="status">
            Waiting for Aurora. An unavailable local model will not trigger an external fallback.
          </p>`
        : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
    </section>`;
  }
}
if (!customElements.get("adminbot-local-chat"))
  customElements.define("adminbot-local-chat", LocalChat);
