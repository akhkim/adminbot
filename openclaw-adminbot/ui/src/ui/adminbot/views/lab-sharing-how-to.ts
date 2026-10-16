import { html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

export class LabSharingHowTo extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private question = "";
  @state() private answer = "";
  @state() private sources: string[] = [];
  @state() private error = "";
  @state() private busy = false;
  private generation = 0;
  private request?: AbortController;
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.reset();
    }
  }
  override disconnectedCallback() {
    this.reset();
    super.disconnectedCallback();
  }
  private reset() {
    this.generation++;
    this.request?.abort();
    this.question = this.answer = this.error = "";
    this.sources = [];
    this.busy = false;
  }
  private async ask() {
    if (this.busy || !this.sessionToken || !this.question.trim()) {
      return;
    }
    const generation = ++this.generation;
    const request = new AbortController();
    this.request = request;
    const timeout = setTimeout(() => request.abort(), 35_000);
    this.busy = true;
    this.answer = this.error = "";
    this.sources = [];
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}/lab-sharing/ask`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: this.question.trim() }),
        signal: this.request.signal,
      });
      const data = await response.json();
      if (generation !== this.generation) {
        return;
      }
      if (!response.ok || !data.answered) {
        throw new Error("unavailable");
      }
      this.answer = typeof data.answer === "string" ? data.answer : "";
      this.sources = Array.isArray(data.sources)
        ? data.sources.filter((item: unknown) => typeof item === "string")
        : [];
    } catch {
      if (generation === this.generation) {
        this.error = "The guidebook could not answer. Try again or use the resource links below.";
      }
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }
  override render() {
    if (!this.sessionToken) {
      return nothing;
    }
    return html`<section
      class="card adminbot-card adminbot-card--wide lab-sharing-howto"
      aria-label="Lab how-to"
    >
      <h2 class="card-title">Lab how-to</h2>
      <p class="card-sub">
        Ask where to find something or how a lab process works. Answers use the member guidebook.
        Check the cited sections before acting.
      </p>
      <form
        class="adminbot-form lab-sharing-howto__form"
        @submit=${(event: Event) => {
          event.preventDefault();
          void this.ask();
        }}
      >
        <label class="adminbot-form__field"
          ><span>Your question</span
          ><textarea
            class="lab-sharing-howto__input"
            required
            maxlength="1000"
            .value=${this.question}
            ?disabled=${this.busy}
            @input=${(event: Event) => {
              this.question = (event.target as HTMLTextAreaElement).value;
            }}
          ></textarea>
        </label>
        <div class="lab-sharing-howto__actions">
          <button class="btn primary" ?disabled=${this.busy} type="submit">
            ${this.busy ? "Looking up…" : "Ask guidebook"}
          </button>
        </div>
      </form>
      ${this.busy
        ? html`<p class="muted lab-sharing-howto__status" role="status">
            Looking up the member guidebook…
          </p>`
        : nothing}
      ${this.error
        ? html`<div class="callout danger lab-sharing-howto__error" role="alert">${this.error}</div>`
        : nothing}
      ${this.answer
        ? html`<article class="lab-sharing-howto__answer">
            <h3 class="lab-sharing-howto__answer-title">Guidebook answer</h3>
            <p class="lab-sharing-howto__answer-body">${this.answer}</p>
            ${this.sources.length
              ? html`<h4 class="lab-sharing-howto__sources-title">Source sections</h4>
                  <ul class="lab-sharing-howto__sources">
                    ${this.sources.map((source) => html`<li>${source}</li>`)}
                  </ul>`
              : nothing}
          </article>`
        : nothing}
    </section>`;
  }
}
if (!customElements.get("lab-sharing-how-to")) {
  customElements.define("lab-sharing-how-to", LabSharingHowTo);
}
