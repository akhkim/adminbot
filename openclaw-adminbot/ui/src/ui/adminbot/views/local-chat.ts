import DOMPurify from "dompurify";
import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import MarkdownIt from "markdown-it";
import { copyToClipboard } from "../../chat/clipboard.ts";
import { icons } from "../../icons.ts";
import { loadSettings } from "../../storage.ts";
import { sendLocalChat } from "../api/assistant.ts";
import {
  fetchMemberResource,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";

type Message = { role: "user" | "assistant"; content: string };
type Conversation = { id: string; messages: Message[]; draft: string };
const newConversation = (): Conversation => ({ id: crypto.randomUUID(), messages: [], draft: "" });
// The shared chat renderer caches text globally and loads images. Private chats do neither.
const markdown = new MarkdownIt({ html: false, linkify: false });
markdown.renderer.rules.image = () => "[Image omitted]";
markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index]!.attrSet("rel", "noreferrer noopener");
  tokens[index]!.attrSet("target", "_blank");
  return renderer.renderToken(tokens, index, options);
};

/** Session-only chat workspace; no gateway tools or persisted transcripts. */
export class LocalChat extends LitElement {
  @property({ type: String }) sessionToken = "";
  @state() private available = false;
  @state() private model = "";
  @state() private conversations: Conversation[] = [newConversation()];
  @state() private activeId = this.conversations[0]!.id;
  @state() private busy = false;
  @state() private error = "";
  @state() private search = "";
  @state() private sidebarOpen = false;
  @state() private expanded = false;
  @state() private copied = "";
  private generation = 0;
  private pending?: AbortController;
  private scrollNext = false;
  private focusNext = false;
  private get conversation() {
    return this.conversations.find((row) => row.id === this.activeId)!;
  }
  private get messages() {
    return this.conversation.messages;
  }
  private get draft() {
    return this.conversation.draft;
  }
  private set draft(value: string) {
    this.updateConversation({ draft: value });
  }
  private updateConversation(value: Partial<Conversation>) {
    this.conversations = this.conversations.map((row) =>
      row.id === this.activeId ? { ...row, ...value } : row,
    );
  }
  private conversationTitle(row: Conversation) {
    return (
      row.messages[0]?.content.replace(/\s+/g, " ").slice(0, 64) ||
      row.draft.trim().slice(0, 64) ||
      "New conversation"
    );
  }
  protected override createRenderRoot() {
    return this;
  }
  protected override updated(changed: Map<string, unknown>) {
    if (changed.has("sessionToken")) {
      this.clear();
      this.available = false;
      void this.checkAccess();
    }
    if (changed.has("expanded")) {
      const dialog = this.querySelector<HTMLDialogElement>("dialog");
      if (this.expanded && dialog && !dialog.open) {
        dialog.showModal();
        this.focusNext = true;
      } else if (!this.expanded && dialog?.open) dialog.close();
    }
    if (this.focusNext) {
      this.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      this.focusNext = false;
    }
    if (this.scrollNext) {
      const thread = this.querySelector<HTMLElement>(".lc-thread");
      if (thread) thread.scrollTop = thread.scrollHeight;
      this.scrollNext = false;
    }
  }
  override disconnectedCallback() {
    this.clear();
    this.available = false;
    super.disconnectedCallback();
  }
  private stop() {
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
    this.busy = false;
  }
  private clear() {
    this.stop();
    this.conversations = [newConversation()];
    this.activeId = this.conversations[0]!.id;
    this.search = "";
    this.error = "";
    this.copied = "";
    this.expanded = false;
    this.sidebarOpen = false;
  }
  private clearCurrent() {
    this.stop();
    this.focusNext = true;
    this.updateConversation({ messages: [], draft: "" });
    this.error = "";
    this.copied = "";
  }
  private newChat() {
    if (this.conversations.length >= 12) {
      this.error = "Session limit reached. Clear all chats to start a new session.";
      return;
    }
    this.stop();
    const next = newConversation();
    this.conversations = [next, ...this.conversations];
    this.activeId = next.id;
    this.focusNext = true;
    this.error = "";
    this.search = "";
    this.sidebarOpen = false;
  }
  private select(id: string) {
    this.stop();
    this.activeId = id;
    this.focusNext = true;
    this.error = "";
    this.copied = "";
    this.sidebarOpen = false;
    this.scrollNext = true;
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
    this.scrollNext = true;
    const pending = new AbortController();
    this.pending = pending;
    try {
      const result = await sendLocalChat(
        next,
        token,
        resolveAdminBotBaseUrl(loadSettings()),
        pending.signal,
      );
      if (!this.current(token, generation)) return;
      if (!result.ok) {
        this.error = "Local chat could not answer. No external model was used. Retry shortly.";
        return;
      }
      if (result.value.model !== this.model) {
        this.error = "The local model changed. Clear the chat and reopen My Desk.";
        return;
      }
      this.updateConversation({
        messages: [...next, { role: "assistant", content: result.value.output }],
        draft: "",
      });
      this.scrollNext = true;
    } finally {
      if (this.current(token, generation)) {
        this.busy = false;
        this.pending = undefined;
      }
    }
  }
  private async copy(content: string, key: string) {
    const generation = this.generation;
    const result = await copyToClipboard(content);
    if (generation === this.generation) this.copied = result ? key : "";
    if (!result && generation === this.generation)
      this.error = "Copy failed. Select the text to copy it.";
  }
  private message(row: Message, index: number) {
    return html`<article
      class="lc-message lc-message--${row.role}"
      aria-label=${row.role === "user" ? "Your message" : "Local model response"}
    >
      ${row.role === "assistant"
        ? html`<div class="lc-avatar" aria-hidden="true">${icons.zap}</div>`
        : nothing}
      <div class="lc-message-content">
        <div class="lc-message-author">${row.role === "user" ? "You" : "Local model · Aurora"}</div>
        <div class="lc-message-body">
          ${row.role === "user"
            ? html`<span class="lc-user-text">${row.content}</span>`
            : unsafeHTML(
                DOMPurify.sanitize(markdown.render(row.content), {
                  FORBID_TAGS: ["img", "iframe", "video", "audio", "style", "input", "form"],
                  FORBID_ATTR: ["src", "style"],
                  ADD_ATTR: ["target"],
                }),
              )}
        </div>
        <button
          class="lc-copy"
          type="button"
          aria-label=${`Copy ${row.role === "user" ? "your message" : "response"} ${index + 1}`}
          @click=${() => void this.copy(row.content, `${this.activeId}:${index}`)}
        >
          ${icons.copy} ${this.copied === `${this.activeId}:${index}` ? "Copied" : "Copy"}
        </button>
      </div>
    </article>`;
  }
  private workspace() {
    const shown = this.conversations.filter((row) =>
      this.conversationTitle(row).toLowerCase().includes(this.search.toLowerCase().trim()),
    );
    return html`<section class="lc-workspace" aria-label="Local chat">
      ${this.sidebarOpen
        ? html`<button
            class="lc-sidebar-backdrop"
            aria-label="Close conversations"
            @click=${() => (this.sidebarOpen = false)}
          ></button>`
        : nothing}
      <aside class="lc-sidebar ${this.sidebarOpen ? "is-open" : ""}" aria-label="Conversations">
        <div class="lc-brand">
          ${icons.lock}<span>Local chat<small>Aurora workspace</small></span>
          <button
            class="lc-icon lc-mobile-history"
            type="button"
            aria-label="Close conversation drawer"
            @click=${() => (this.sidebarOpen = false)}
          >
            ${icons.x}
          </button>
        </div>
        <button class="lc-new" type="button" @click=${() => this.newChat()}>
          ${icons.plus} New chat
        </button>
        <label class="lc-search"
          >${icons.search}<input
            type="search"
            aria-label="Search conversations"
            placeholder="Search conversations"
            .value=${this.search}
            @input=${(event: Event) => (this.search = (event.target as HTMLInputElement).value)}
        /></label>
        <div class="lc-sidebar-label">This session</div>
        <nav class="lc-conversations" aria-label="Conversation list">
          ${shown.map(
            (row) =>
              html`<button
                class="lc-conversation ${row.id === this.activeId ? "is-active" : ""}"
                type="button"
                aria-current=${row.id === this.activeId ? "true" : "false"}
                @click=${() => this.select(row.id)}
                title=${this.conversationTitle(row)}
              >
                ${icons.messageSquare}<span>${this.conversationTitle(row)}</span>
              </button>`,
          )}
          ${shown.length ? nothing : html`<p class="lc-empty-search">No conversations found.</p>`}
        </nav>
        <div class="lc-sidebar-footer">
          <span>${icons.lock} Session-only history</span>
          <p>
            Chats disappear when you leave My Desk or sign out. Nothing is saved to your account.
          </p>
          <button type="button" class="lc-clear-all" @click=${() => this.clear()}>
            ${icons.trash} Clear all chats
          </button>
        </div>
      </aside>
      <div class="lc-main">
        <header class="lc-header">
          <button
            class="lc-icon lc-mobile-history"
            type="button"
            aria-label="Show conversations"
            aria-expanded=${this.sidebarOpen}
            @click=${() => (this.sidebarOpen = !this.sidebarOpen)}
          >
            ${icons.panelLeftOpen}
          </button>
          <div class="lc-model" title=${this.model}>
            <strong>${this.model.replace(/^nvidia\//, "")}</strong
            ><span><i></i> Local only · Aurora</span>
          </div>
          <div class="lc-header-actions">
            <button
              class="lc-icon"
              type="button"
              aria-label="Clear chat"
              title="Clear this chat"
              @click=${() => this.clearCurrent()}
            >
              ${icons.trash}
            </button>
            ${this.expanded
              ? html`<button
                  class="lc-icon"
                  type="button"
                  aria-label="Exit full screen"
                  title="Exit full screen"
                  @click=${() => this.querySelector<HTMLDialogElement>("dialog")?.close()}
                >
                  ${icons.x}
                </button>`
              : html`<button
                  class="lc-icon"
                  type="button"
                  aria-label="Expand chat"
                  title="Expand chat"
                  @click=${() => (this.expanded = true)}
                >
                  ${icons.maximize}
                </button>`}
          </div>
        </header>
        <div class="lc-thread" role="log" aria-label="Conversation" aria-live="polite" tabindex="0">
          ${this.messages.length || this.busy
            ? html`<div class="lc-messages">
                ${this.messages.map((row, index) => this.message(row, index))}${this.busy
                  ? html`${this.message(
                        { role: "user", content: this.draft.trim() },
                        this.messages.length,
                      )}
                      <div class="lc-waiting" role="status">
                        <span class="lc-pulse"></span> Waiting for local model…
                        <span>No external fallback</span>
                      </div>`
                  : nothing}
              </div>`
            : html`<div class="lc-welcome">
                <div class="lc-welcome-mark" aria-hidden="true">${icons.zap}</div>
                <h2>What would you like to explore?</h2>
                <p>A private space to think, write, and work with Qwen on Aurora.</p>
                <div class="lc-suggestions">
                  ${[
                    "Help me refine a research idea",
                    "Explain a difficult concept",
                    "Review a draft I paste here",
                  ].map(
                    (prompt) =>
                      html`<button
                        type="button"
                        @click=${() => {
                          this.draft = prompt;
                          this.querySelector<HTMLTextAreaElement>("textarea")?.focus();
                        }}
                      >
                        ${icons.messageSquare}<span>${prompt}</span>
                      </button>`,
                  )}
                </div>
              </div>`}
        </div>
        <div class="lc-composer-area">
          ${this.error ? html`<p class="lc-error" role="alert">${this.error}</p>` : nothing}
          <form class="lc-composer" @submit=${(event: Event) => void this.send(event)}>
            <textarea
              aria-label="Message to the local model"
              placeholder="Message Qwen…"
              rows="2"
              maxlength="8000"
              required
              .value=${this.draft}
              ?disabled=${this.busy}
              @input=${(event: Event) => (this.draft = (event.target as HTMLTextAreaElement).value)}
              @keydown=${(event: KeyboardEvent) => {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing)
                  void this.send(event);
              }}
            ></textarea>
            <div class="lc-composer-controls">
              <span>${icons.lock} Private · No tools or web access</span>${this.busy
                ? html`<button
                    class="lc-send"
                    type="button"
                    aria-label="Stop generation"
                    @click=${() => this.stop()}
                  >
                    ${icons.stop}
                  </button>`
                : html`<button
                    class="lc-send"
                    type="submit"
                    aria-label="Send locally"
                    title="Send (Enter)"
                    ?disabled=${!this.draft.trim()}
                  >
                    ${icons.send}
                  </button>`}
            </div>
          </form>
          <div class="lc-footnote">
            <span>Qwen can make mistakes. Enter to send · Shift+Enter for a new line.</span>
            <details>
              <summary>Privacy & limits</summary>
              <p>
                No external providers, lab records, saved transcripts, or automatically loaded
                images. Other AdminBot chats have separate routing. Up to 12 session-only chats, 23
                messages per request, and 32,000 characters of context.
              </p>
            </details>
          </div>
        </div>
      </div>
    </section>`;
  }
  override render() {
    if (!this.available) return nothing;
    return html`${this.expanded ? nothing : this.workspace()}
      <dialog
        class="lc-dialog"
        aria-label="Local chat full screen"
        @close=${() => (this.expanded = false)}
      >
        ${this.expanded ? this.workspace() : nothing}
      </dialog>`;
  }
}
if (!customElements.get("adminbot-local-chat"))
  customElements.define("adminbot-local-chat", LocalChat);
