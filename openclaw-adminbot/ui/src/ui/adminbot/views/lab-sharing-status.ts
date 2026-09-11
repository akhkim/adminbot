import { html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

type SharedStatus = {
  id?: string;
  availability: string;
  message: string;
  updated_at: string;
  expires_at: string;
  retracted_at?: string;
};
const availabilityLabels: Record<string, string> = {
  unknown: "Unknown",
  available: "Available",
  busy: "Busy",
  away: "Away",
};

export class LabSharingStatus extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private status: SharedStatus | null = null;
  /** Every broadcast, newest first. The archive the lab reads back; the service caps the length. */
  @state() private history: SharedStatus[] = [];
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
    this.history = [];
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
      if (generation !== this.generation) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          this.canManage = false;
          this.draft = { availability: "unknown", message: "", expiry: "" };
        }
        throw new Error(data.error?.message ?? "Could not load status.");
      }
      this.status = data.status;
      this.history = Array.isArray(data.history) ? data.history : [];
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
        this.history = [];
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
    // Everything but the live one. The current broadcast is rendered in full above, so repeating it
    // in the archive would make the same message look like it was said twice.
    const past = this.history.filter((entry) => entry !== current);
    return html`<section class="lab-sharing lab-sharing-directory" aria-label="Zhijing’s updates">
      <h2 class="lab-sharing-seek__title">Zhijing’s updates</h2>
      <p class="lab-sharing-seek__sub">The latest broadcast to the lab, and everything said before it. This is a manual update, not live calendar availability.</p>
      <button class="btn" ?disabled=${this.busy} @click=${() => this.refresh()}>
        Refresh status
      </button>
      ${this.busy ? html`<p role="status">Loading status…</p>` : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${current
        ? html`<article class="lab-sharing-request">
            <h3 class="lab-sharing-request__project">
              ${availabilityLabels[current.availability] ?? "Unknown"}
            </h3>
            <p>${current.message}</p>
            <p class="lab-sharing-request__time">
              Updated ${new Date(current.updated_at).toLocaleString()}
            </p>
            <p class="lab-sharing-request__time">
              Expires ${new Date(current.expires_at).toLocaleString()}
            </p>
          </article>`
        : !this.busy && !this.error
          ? html`<p>No current update shared.</p>`
          : nothing}
      ${past.length
        ? html`<div class="lab-sharing-status__history" data-testid="lab-sharing-status-history">
            <h3 class="lab-sharing-seek__title">Earlier updates</h3>
            <ol class="lab-sharing-status__history-list">
              ${past.map(
                (entry) => html`<li
                  class="lab-sharing-status__history-item"
                  data-testid="lab-sharing-status-history-item"
                >
                  <p class="lab-sharing-status__history-body">${entry.message}</p>
                  <p class="lab-sharing-request__time">
                    ${new Date(entry.updated_at).toLocaleDateString()}
                    ${entry.retracted_at
                      ? html`· <span class="lab-sharing-status__retracted">withdrawn</span>`
                      : nothing}
                  </p>
                </li>`,
              )}
            </ol>
          </div>`
        : nothing}
      ${this.canManage
        ? html`<form
            class="lab-sharing-directory__form"
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
                  (value) => html`<option value=${value} ?selected=${value === this.draft.availability}>${availabilityLabels[value]}</option>`,
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
            <div class="lab-sharing-directory__actions">
              <button class="btn primary" type="submit" ?disabled=${this.busy}>
                Publish status
              </button>
              <button
                class="btn"
                type="button"
                ?disabled=${this.busy || !current}
                @click=${() => this.publish(true)}
              >
                Clear status
              </button>
            </div>
          </form>`
        : nothing}
    </section>`;
  }
}
if (!customElements.get("lab-sharing-status"))
  customElements.define("lab-sharing-status", LabSharingStatus);
