import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

type DraftResult = {
  announcements: { venue: string; text: string; paper_count: number }[];
  images: { name: string; data: string }[];
  warnings: string[];
};

export class NotificationDrafts extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private file: File | null = null;
  @state() private uploadInvalid = false;
  @state() private date = "";
  @state() private conference = "";
  @state() private template = "";
  @state() private images = true;
  @state() private busy = false;
  @state() private error = "";
  @state() private notice = "";
  @state() private result: DraftResult | null = null;
  private controller?: AbortController;
  private generation = 0;

  static override styles = css`
    :host {
      display: block;
      max-width: 960px;
      margin: 24px auto;
      color: var(--text);
    }
    section {
      border: 1px solid var(--border, #8885);
      border-radius: 16px;
      padding: 28px;
    }
    h2 {
      margin-top: 0;
    }
    p {
      line-height: 1.6;
    }
    .hint {
      color: var(--muted);
      font-size: 13px;
    }
    .drop {
      display: block;
      text-align: center;
      padding: 28px 16px;
      margin: 22px 0;
      border: 2px dashed var(--border, #8885);
      border-radius: 12px;
      overflow-wrap: anywhere;
      cursor: pointer;
    }
    .drop input {
      display: block;
      max-width: 100%;
      margin: 14px auto 0;
    }
    .fields {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
    }
    .fields label {
      display: grid;
      gap: 8px;
      font-size: 14px;
    }
    input,
    select,
    textarea {
      box-sizing: border-box;
      font: inherit;
      color: inherit;
      background: var(--bg, transparent);
      border: 1px solid var(--border, #8885);
      border-radius: 8px;
      padding: 10px;
      min-width: 0;
    }
    textarea {
      width: 100%;
      min-height: 200px;
      resize: vertical;
      line-height: 1.6;
    }
    .check {
      display: block;
      margin: 20px 0;
    }
    button,
    .download {
      display: inline-block;
      font: inherit;
      cursor: pointer;
      border: 1px solid var(--border, #8885);
      border-radius: 8px;
      padding: 9px 14px;
      color: inherit;
      background: transparent;
      text-decoration: none;
    }
    .primary {
      background: var(--accent, #486bdf);
      color: var(--accent-foreground, white);
      border: 0;
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    :focus-visible {
      outline: 2px solid var(--accent, #486bdf);
      outline-offset: 3px;
    }
    article {
      margin-top: 24px;
      border-top: 1px solid var(--border, #8885);
      padding-top: 16px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .previews {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 20px;
    }
    figure {
      margin: 16px 0;
    }
    img {
      width: 100%;
      border-radius: 10px;
      border: 1px solid var(--border, #8885);
    }
    figcaption {
      margin-top: 10px;
      overflow-wrap: anywhere;
    }
    [role="alert"] {
      color: var(--danger, #d45b65);
    }
    @media (max-width: 600px) {
      section {
        padding: 18px;
      }
      .fields,
      .previews {
        grid-template-columns: 1fr;
      }
    }
  `;

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.generation++;
      this.controller?.abort();
      this.file = null;
      this.result = null;
      this.error = "";
      this.notice = "";
      this.busy = false;
    }
  }
  override disconnectedCallback() {
    this.generation++;
    this.controller?.abort();
    super.disconnectedCallback();
  }
  private choose(files: FileList | File[]) {
    if (this.busy) {
      return;
    }
    this.result = null;
    this.error = "";
    this.file = null;
    this.uploadInvalid = true;
    if (
      files.length !== 1 ||
      !/\.(json|csv)$/i.test(files[0].name) ||
      !files[0].size ||
      files[0].size > 25 * 1024 * 1024
    ) {
      this.error = "Choose one non-empty notifications JSON or CSV file, up to 25 MB.";
      return;
    }
    this.file = files[0];
    this.uploadInvalid = false;
  }
  private async generate() {
    if (
      this.uploadInvalid ||
      !this.date ||
      !this.conference.trim() ||
      this.busy ||
      !this.sessionToken
    ) {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    this.error = "";
    this.notice = "";
    this.result = null;
    this.controller = new AbortController();
    try {
      const text = this.file ? (await this.file.text()).replace(/^\uFEFF/, "") : "";
      const csv = this.file?.name.toLowerCase().endsWith(".csv");
      const notifications: unknown = !this.file || csv ? undefined : JSON.parse(text);
      if (this.file && !csv && !Array.isArray(notifications)) {
        throw new Error("The JSON must contain an array of notifications.");
      }
      if (generation !== this.generation) {
        return;
      }
      const response = await fetch(this.baseUrl.replace(/\/$/, "") + "/tools/notification-drafts", {
        method: "POST",
        signal: this.controller.signal,
        headers: {
          Authorization: `Bearer ${this.sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          notifications_csv: csv ? text : undefined,
          notifications,
          min_date: this.date,
          conference: this.conference.trim(),
          template: this.template ? Number(this.template) : null,
          images: this.images,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error?.message || "Could not generate drafts.");
      }
      if (generation === this.generation) {
        this.result = body as DraftResult;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error = error instanceof Error ? error.message : "Could not generate drafts.";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }
  private async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.notice = "Draft copied.";
    } catch {
      this.notice = "Select the draft text and copy it manually.";
    }
  }
  override render() {
    return html`<section>
      <h2>OpenReview To Tweet</h2>
      <p>Turn acceptance notifications into tweet drafts and paper-list images.</p>
      <p class="hint">
        Author IDs are read from OpenReview and matched to member profiles to add saved X handles.
        Nothing is posted or saved to the database. Review titles, tracks, and mentions before
        sharing.
      </p>
      <label
        class="drop"
        @dragover=${(e: DragEvent) => e.preventDefault()}
        @drop=${(e: DragEvent) => {
          e.preventDefault();
          if (e.dataTransfer) {
            this.choose(e.dataTransfer.files);
          }
        }}
      >
        ${this.file?.name || "Optional: drop a notifications JSON or CSV to override Google Drive"}
        <input
          aria-label="Notifications JSON or CSV"
          type="file"
          accept=".json,.csv,application/json,text/csv"
          ?disabled=${this.busy}
          @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            if (input.files) {
              this.choose(input.files);
            }
            input.value = "";
          }}
        />
      </label>
      <p class="hint">Without an upload, Generate drafts loads the latest CSV from Google Drive.</p>
      ${this.file || this.uploadInvalid
        ? html`<button
            ?disabled=${this.busy}
            @click=${() => {
              this.file = null;
              this.uploadInvalid = false;
              this.result = null;
              this.error = "";
            }}
          >
            Use Google Drive instead
          </button>`
        : nothing}
      <div class="fields">
        <label
          >Notifications after<input
            aria-label="Notifications after"
            type="date"
            .value=${this.date}
            ?disabled=${this.busy}
            @input=${(e: Event) => {
              this.date = (e.target as HTMLInputElement).value;
              this.result = null;
            }}
        /></label>
        <label
          >Conference<input
            aria-label="Conference"
            placeholder="e.g. NeurIPS"
            .value=${this.conference}
            ?disabled=${this.busy}
            @input=${(e: Event) => {
              this.conference = (e.target as HTMLInputElement).value;
              this.result = null;
            }}
        /></label>
        <label
          >Writing style<select
            aria-label="Writing style"
            .value=${this.template}
            ?disabled=${this.busy}
            @change=${(e: Event) => {
              this.template = (e.target as HTMLSelectElement).value;
              this.result = null;
            }}
          >
            <option value="">Random template</option>
            ${Array.from(
              { length: 10 },
              (_, i) => html`<option value=${i + 1}>Template ${i + 1}</option>`,
            )}
          </select></label
        >
      </div>
      <p class="hint">
        The cutoff is exclusive, at midnight UTC, using the notification creation date.
      </p>
      <label class="check"
        ><input
          type="checkbox"
          .checked=${this.images}
          ?disabled=${this.busy}
          @change=${(e: Event) => {
            this.images = (e.target as HTMLInputElement).checked;
            this.result = null;
          }}
        />
        Include downloadable PNG images</label
      >
      <button
        class="primary"
        ?disabled=${this.busy ||
        this.uploadInvalid ||
        !this.date ||
        !this.conference.trim() ||
        !this.sessionToken}
        @click=${() => void this.generate()}
      >
        ${this.busy ? "Generating…" : "Generate drafts"}
      </button>
      ${this.busy
        ? html`<p role="status">Looking up authors and creating your drafts and images…</p>`
        : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.notice ? html`<p role="status">${this.notice}</p>` : nothing}
      ${this.result
        ? html`
            ${this.result.announcements.length
              ? nothing
              : html`<p role="status">No accepted papers matched this date and conference.</p>`}
            ${this.result.warnings.map((warning) => html`<p class="hint">${warning}</p>`)}
            ${this.result.announcements.map(
              (draft, i) => html`<article>
                <h3>${draft.venue} · ${draft.paper_count} papers</h3>
                <textarea
                  aria-label=${"Tweet draft " + (i + 1)}
                  .value=${draft.text}
                  @input=${(e: Event) => {
                    draft.text = (e.target as HTMLTextAreaElement).value;
                    this.requestUpdate();
                  }}
                ></textarea>
                <p class="hint">
                  ${draft.text.length} characters. Long announcements may need splitting before
                  posting. Editing the draft does not change the paper-list images.
                </p>
                <div class="actions">
                  <button @click=${() => void this.copy(draft.text)}>Copy draft</button>
                </div>
              </article>`,
            )}
            <div class="previews">
              ${this.result.images.map(
                (image) => html`<figure>
                  <img
                    src=${"data:image/png;base64," + image.data}
                    alt=${"Accepted paper list: " + image.name}
                  />
                  <figcaption>
                    <a
                      class="download"
                      download=${image.name}
                      href=${"data:image/png;base64," + image.data}
                      >Download PNG</a
                    >
                  </figcaption>
                </figure>`,
              )}
            </div>
          `
        : nothing}
    </section>`;
  }
}
if (!customElements.get("adminbot-notification-drafts")) {
  customElements.define("adminbot-notification-drafts", NotificationDrafts);
}

export function renderNotificationDrafts(baseUrl: string, sessionToken: string) {
  return html`<adminbot-notification-drafts
    .baseUrl=${baseUrl}
    .sessionToken=${sessionToken}
  ></adminbot-notification-drafts>`;
}
