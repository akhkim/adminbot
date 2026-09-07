import { html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

type SharedStatus = {
  availability: string;
  message: string;
  updated_at: string;
  expires_at: string;
};
export class LabSharingStatus extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private status: SharedStatus | null = null;
  @state() private busy = false;
  @state() private error = "";
  private generation = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.reset();
      if (this.sessionToken) void this.refresh();
    }
  }
  override disconnectedCallback() {
    this.reset();
    super.disconnectedCallback();
  }
  private reset() {
    this.generation++;
    clearTimeout(this.expiryTimer);
    this.status = null;
    this.busy = false;
    this.error = "";
  }
  private expire() {
    clearTimeout(this.expiryTimer);
    if (!this.status) return;
    const remaining = Date.parse(this.status.expires_at) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.status = null;
      return;
    }
    this.expiryTimer = setTimeout(() => this.expire(), Math.min(remaining, 2_147_483_647));
  }
  private async refresh() {
    const generation = ++this.generation;
    this.busy = true;
    this.error = "";
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}/lab-sharing/status`, {
        headers: { Authorization: `Bearer ${this.sessionToken}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Could not load status.");
      if (generation !== this.generation) return;
      this.status = data.status;
      this.expire();
    } catch (error) {
      if (generation === this.generation) {
        this.status = null;
        this.error = error instanceof Error ? error.message : "Could not load status.";
      }
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  override render() {
    if (!this.sessionToken) return nothing;
    const current =
      this.status && Date.parse(this.status.expires_at) > Date.now() ? this.status : null;
    return html`<section class="lab-sharing lab-sharing-directory" aria-label="Director status">
      <h2 class="lab-sharing-seek__title">Director status</h2>
      <button class="btn" ?disabled=${this.busy} @click=${() => this.refresh()}>
        Refresh status
      </button>
      ${this.busy ? html`<p role="status">Loading status…</p>` : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${current
        ? html`<article class="lab-sharing-request">
            <h3 class="lab-sharing-request__project">${current.availability}</h3>
            <p>${current.message}</p>
            <p class="muted">Updated ${new Date(current.updated_at).toLocaleString()}</p>
            <p class="muted">Expires ${new Date(current.expires_at).toLocaleString()}</p>
          </article>`
        : !this.busy && !this.error
          ? html`<p>No current status shared.</p>`
          : nothing}
    </section>`;
  }
}
if (!customElements.get("lab-sharing-status"))
  customElements.define("lab-sharing-status", LabSharingStatus);
