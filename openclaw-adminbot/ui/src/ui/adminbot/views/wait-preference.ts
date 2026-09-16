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
        headers: { Accept: "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
  override render() {
    if (!this.usable() || this.value === undefined) {
      return html``;
    }
    return html`<div style=${this.standalone ? "margin:0.75rem 0" : "margin-top:0.5rem"}>
      <label>
        <input
          type="checkbox"
          .checked=${this.value}
          @change=${(event: Event) => void this.save((event.target as HTMLInputElement).checked)}
        />
        ${this.standalone
          ? "Queue my requests when the lab's model is busy, without asking"
          : "Don't ask me again — queue my requests when the model is busy"}
      </label>
      ${this.standalone
        ? html`<p class="muted">
            One model serves the whole lab. With this off, a request that arrives while it is busy
            waits for you to choose; with it on, it joins the queue and runs when a slot frees.
          </p>`
        : ""}
      ${this.failed ? html`<p role="alert">That preference could not be saved. Try again.</p>` : ""}
    </div>`;
  }
}
if (!customElements.get("adminbot-wait-preference")) {
  customElements.define("adminbot-wait-preference", AdminBotWaitPreference);
}
