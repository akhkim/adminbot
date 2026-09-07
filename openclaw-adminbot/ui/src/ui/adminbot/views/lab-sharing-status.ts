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
  @state() private canManage = false;
  @state() private draft = { availability: "unknown", message: "", expiry: "" };
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
    this.canManage = false;
    this.draft = { availability: "unknown", message: "", expiry: "" };
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
  private async publish(clear = false) {
    if (!this.canManage || this.busy) return;
    let body: unknown;
    if (!clear) {
      const expiry = new Date(this.draft.expiry);
      if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
        this.error = "Choose an expiry in the future.";
        return;
      }
      body = {
        availability: this.draft.availability,
        message: this.draft.message,
        expires_at: expiry.toISOString(),
      };
    }
    await this.refresh(clear ? "POST" : "PUT", body);
  }
  private async refresh(method = "GET", body?: unknown) {
    const generation = ++this.generation;
    this.busy = true;
    this.error = "";
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/u, "")}/lab-sharing/status${method === "POST" ? "/clear" : ""}`,
        {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: {
            Authorization: `Bearer ${this.sessionToken}`,
            "Content-Type": "application/json",
          },
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "Could not load status.");
      if (generation !== this.generation) return;
      this.status = data.status;
      this.canManage = data.can_manage === true;
      const date = data.status ? new Date(data.status.expires_at) : null;
      this.draft = {
        availability: data.status?.availability ?? "unknown",
        message: data.status?.message ?? "",
        expiry: date
          ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
          : "",
      };
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
      ${this.canManage
        ? html`<form
            @submit=${(event: Event) => {
              event.preventDefault();
              void this.publish();
            }}
          >
            <p>
              This status is visible to all signed-in lab members. Times use your device's timezone.
            </p>
            <label class="lab-sharing-ask__field"
              ><span>Availability</span
              ><select
                class="lab-sharing-ask__input"
                .value=${this.draft.availability}
                @change=${(event: Event) => {
                  this.draft = {
                    ...this.draft,
                    availability: (event.target as HTMLSelectElement).value,
                  };
                }}
              >
                ${["unknown", "available", "busy", "away"].map(
                  (value) => html`<option value=${value}>${value}</option>`,
                )}
              </select></label
            >
            <label class="lab-sharing-ask__field"
              ><span>Status message</span
              ><textarea
                class="lab-sharing-ask__input"
                required
                maxlength="500"
                .value=${this.draft.message}
                @input=${(event: Event) => {
                  this.draft = {
                    ...this.draft,
                    message: (event.target as HTMLTextAreaElement).value,
                  };
                }}
              ></textarea>
            </label>
            <label class="lab-sharing-ask__field"
              ><span>Expires at (local time)</span
              ><input
                class="lab-sharing-ask__input"
                type="datetime-local"
                required
                .value=${this.draft.expiry}
                @input=${(event: Event) => {
                  this.draft = { ...this.draft, expiry: (event.target as HTMLInputElement).value };
                }}
            /></label>
            <button class="btn primary" type="submit" ?disabled=${this.busy}>Publish status</button>
            <button
              class="btn"
              type="button"
              ?disabled=${this.busy || !current}
              @click=${() => this.publish(true)}
            >
              Clear status
            </button>
          </form>`
        : nothing}
    </section>`;
  }
}
if (!customElements.get("lab-sharing-status"))
  customElements.define("lab-sharing-status", LabSharingStatus);
