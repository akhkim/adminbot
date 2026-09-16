import { html, LitElement, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { taskFetch } from "../task-request.ts";

/**
 * The member's standing answer to "the lab's model is busy".
 *
 * The service has honoured `inference_always_wait` since the gate was added, but nothing ever
 * offered it: it could only be set with a PUT by hand. It appears in two places, deliberately.
 * Inline on a saved task, where the member has just learnt what waiting costs and the setting
 * removes a choice they have in front of them. And on the profile, where someone who turned it on
 * months ago can find it again -- a preference you cannot locate is worse than one you never set.
 *
 * Phrased as the outcome rather than as a setting: "always wait" reads like policy, and what the
 * member is deciding is whether to be asked again.
 *
 * Visitors have no account to hold this, so the element renders nothing for them; the service
 * resolves the preference from the authenticated principal.
 */
export class AdminBotWaitPreference extends LitElement {
  @property() baseUrl = "";
  @property() sessionContext = "";
  /** Standalone on the profile; inline it sits under the buttons it removes. */
  @property({ type: Boolean }) standalone = false;
  /** undefined until the service answers, so the box is never drawn with a guessed value. */
  @state() private value?: boolean;
  @state() private failed = false;

  /**
   * Light DOM. Both hosts style their own children -- the profile card and the task callout are
   * page CSS, not this element's -- and a shadow root would have left the control unstyled in
   * each. It also lets the host's tests read this control the way they read the rest of the view.
   */
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  /** taskFetch does not add this; every authenticated caller supplies it, as task-history does. */
  private auth(): Record<string, string> {
    return this.sessionContext && this.sessionContext !== "visitor"
      ? { Authorization: `Bearer ${this.sessionContext}` }
      : {};
  }
  private endpoint() {
    return `${this.baseUrl.replace(/\/$/u, "")}/inference/preferences`;
  }
  private usable() {
    return (
      Boolean(this.baseUrl) && Boolean(this.sessionContext) && this.sessionContext !== "visitor"
    );
  }
  private async load() {
    if (!this.usable()) {
      return;
    }
    try {
      const response = await taskFetch(this.endpoint(), {
        headers: { Accept: "application/json", ...this.auth() },
      });
      if (!response.ok) {
        return;
      }
      const body = (await response.json()) as { inference_always_wait?: boolean };
      this.value = Boolean(body.inference_always_wait);
    } catch {
      // A preference that cannot be read is simply not offered. Nothing else depends on it.
    }
  }
  private async save(next: boolean) {
    const previous = this.value;
    this.value = next;
    this.failed = false;
    try {
      const response = await taskFetch(this.endpoint(), {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...this.auth() },
        body: JSON.stringify({ inference_always_wait: next }),
      });
      if (!response.ok) {
        throw new Error(String(response.status));
      }
    } catch {
      // Say so rather than leaving a box that silently disagrees with the server.
      this.value = previous;
      this.failed = true;
    }
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("baseUrl") || changed.has("sessionContext")) {
      this.value = undefined;
      void this.load();
    }
  }
  private control() {
    return html`
      <label class="adminbot-form__field adminbot-form__field--check">
        <input
          type="checkbox"
          data-testid="wait-preference-toggle"
          .checked=${this.value ?? false}
          @change=${(event: Event) => void this.save((event.target as HTMLInputElement).checked)}
        />
        <span>
          ${this.standalone
            ? "Queue my requests when the assistant is busy, instead of asking me each time"
            : "Don't ask me again — queue my requests when the model is busy"}
        </span>
      </label>
      ${this.failed ? html`<p role="alert">That preference could not be saved. Try again.</p>` : ""}
    `;
  }
  override render() {
    if (!this.usable() || this.value === undefined) {
      return html``;
    }
    // On the profile it is a card among the other cards, titled the way they are. The label
    // carries the whole explanation rather than a subtitle: how much capacity the lab has is a
    // fact that changes, and copy that states it goes quietly wrong when it does.
    // Inline on a task it is one more line inside a callout that has already said why it matters.
    return this.standalone
      ? html`<section class="profile__section" data-testid="profile-wait-preference">
          <h2 class="profile__section-title">Assistant requests</h2>
          ${this.control()}
        </section>`
      : html`<div class="adminbot-wait-preference">${this.control()}</div>`;
  }
}
if (!customElements.get("adminbot-wait-preference")) {
  customElements.define("adminbot-wait-preference", AdminBotWaitPreference);
}
