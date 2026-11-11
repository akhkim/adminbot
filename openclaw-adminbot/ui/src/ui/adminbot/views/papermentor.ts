// The PaperMentor tab: upload an Overleaf source zip, and download it back reviewed -- with every
// reference it cites checked, if the member asks.
//
// The review runs on the AdminBot host (papermentor-pdf) and takes a few minutes; the list below
// the form polls while anything is waiting. The service decides who may upload and whose reviews
// are listed -- this element only draws what it is sent.
//
// The PDF Reference Checker used to be a tab of its own. Its check is now a step of the review,
// and its PDF-only form sits below the reviews for a member who has a PDF and no source.
import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { memberAuthHeaders } from "../api/device-clock.ts";
import {
  referenceFindingStyles,
  renderReferenceFindings,
  type ReferenceCheckerId,
  type ReferenceFindingView,
} from "./reference-checker.ts";

export type PaperMentorReviewFile =
  | "commented_zip"
  | "reviewed_pdf"
  | "report"
  | "edits_diff"
  | "references";

export type PaperMentorReferenceSummary = {
  status: "checked" | "failed" | "skipped";
  source?: "bib" | "pdf";
  total?: number;
  matched?: number;
  needs_review?: number;
  not_found?: number;
  unavailable?: number;
  skipped_entries?: number;
  message?: string;
};

export type PaperMentorReview = {
  id: string;
  label: string;
  venue: string;
  status: "queued" | "running" | "reviewed" | "rejected" | "failed";
  phase?: "review" | "references";
  check_references?: boolean;
  references?: PaperMentorReferenceSummary;
  created_at: string;
  finished_at?: string;
  message?: string;
  comments?: number;
  by_severity?: Record<string, number>;
  pdf?: boolean;
  files: PaperMentorReviewFile[];
  downloads: Array<{ kind: PaperMentorReviewFile; filename: string }>;
};

export type PaperMentorOverview = {
  enabled: boolean;
  model_provider: string | null;
  venues: string[];
  max_zip_bytes: number | null;
  checks_references: boolean;
  reference_checkers: ReferenceCheckerId[];
  reviews: PaperMentorReview[];
};

const DEFAULT_MAX_ZIP_BYTES = 40 * 1024 * 1024;
const POLL_MS = 10_000;
export const PAPERMENTOR_CONSENT = "send-draft-to-model-provider";
export const REFERENCE_CHECK_CONSENT = "query-reference-databases";

const FILE_LABELS: Record<PaperMentorReviewFile, string> = {
  commented_zip: "Download reviewed zip",
  reviewed_pdf: "Annotated PDF",
  report: "Report (review.md)",
  edits_diff: "Suggested edits (.diff)",
  references: "Reference check (.json)",
};

const STATUS_LABELS: Record<PaperMentorReview["status"], string> = {
  queued: "Waiting",
  running: "Reviewing…",
  reviewed: "Done",
  rejected: "Could not review",
  failed: "Failed",
};

export class PaperMentorView extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private overview: PaperMentorOverview | null = null;
  @state() private file: File | null = null;
  @state() private venue = "";
  @state() private consent = false;
  /** On by default: checking the references is part of the review unless the member opts out. */
  @state() private checkReferences = true;
  /** Reference findings by review id, fetched when the member opens them. */
  @state() private findings: Record<string, ReferenceFindingView[] | "loading"> = {};
  @state() private busy = false;
  @state() private error = "";
  @state() private notice = "";
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;

  static override styles = [
    referenceFindingStyles,
    css`
      :host {
        display: block;
        max-width: 860px;
      }
      section {
        padding: 28px;
        border: 1px solid var(--border, #8885);
        border-radius: 14px;
        margin-bottom: 20px;
      }
      h3 {
        margin-top: 0;
      }
      p {
        line-height: 1.5;
      }
      .hint {
        color: var(--muted, #888);
        font-size: 14px;
      }
      label.field {
        display: block;
        margin: 12px 0;
      }
      select {
        font: inherit;
        padding: 10px;
        width: 100%;
        box-sizing: border-box;
        color: var(--text, inherit);
        background: var(--bg, transparent);
        border: 1px solid var(--border, #8885);
        border-radius: 8px;
        margin-top: 6px;
      }
      .drop {
        overflow-wrap: anywhere;
        display: block;
        position: relative;
        padding: 28px 20px;
        border: 2px dashed var(--border, #8885);
        border-radius: 10px;
        text-align: center;
        cursor: pointer;
        margin: 12px 0;
      }
      .drop:focus-within {
        outline: 2px solid var(--accent, #5875e8);
      }
      .drop input {
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
      }
      button {
        padding: 10px 20px;
        border: 0;
        border-radius: 8px;
        cursor: pointer;
        background: var(--accent, #5875e8);
        color: var(--accent-foreground, white);
        font: inherit;
      }
      button.secondary {
        padding: 6px 12px;
        font-size: 13px;
        background: transparent;
        color: inherit;
        border: 1px solid var(--border, #8885);
        margin: 6px 8px 0 0;
      }
      button.secondary.primary {
        background: var(--accent, #5875e8);
        color: var(--accent-foreground, white);
        border-color: transparent;
      }
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      [role="alert"] {
        color: var(--danger, #dc5353);
      }
      .review {
        border: 1px solid var(--border, #8885);
        border-radius: 12px;
        padding: 14px 18px;
        margin-top: 12px;
        overflow-wrap: anywhere;
      }
      .review header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .status {
        font-size: 12px;
        padding: 3px 9px;
        border-radius: 6px;
        border: 1px solid var(--border, #8885);
        white-space: nowrap;
      }
      .status[data-status="reviewed"] {
        color: #29966b;
        border-color: #29966b;
      }
      .status[data-status="failed"],
      .status[data-status="rejected"] {
        color: var(--danger, #dc5353);
        border-color: var(--danger, #dc5353);
      }
      .findings {
        margin-top: 8px;
      }
      h3.pdf-only {
        margin: 32px 0 6px;
      }
    `,
  ];

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.generation++;
      this.overview = null;
      this.findings = {};
      this.error = "";
      this.notice = "";
      void this.load();
    }
  }

  override disconnectedCallback() {
    this.generation++;
    clearTimeout(this.timer);
    super.disconnectedCallback();
  }

  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/u, "")}${path}`;
  }

  private get maxZipBytes() {
    return this.overview?.max_zip_bytes ?? DEFAULT_MAX_ZIP_BYTES;
  }

  private async load() {
    clearTimeout(this.timer);
    if (!this.sessionToken) {
      return;
    }
    const generation = this.generation;
    try {
      const response = await fetch(this.url("/papermentor/reviews"), {
        headers: memberAuthHeaders(this.sessionToken),
      });
      const body = await response.json();
      if (generation !== this.generation) {
        return;
      }
      if (!response.ok) {
        throw new Error(body.error?.message || "PaperMentor reviews could not be loaded.");
      }
      this.overview = body as PaperMentorOverview;
      if (this.overview.reviews.some((r) => r.status === "queued" || r.status === "running")) {
        this.timer = setTimeout(() => void this.load(), POLL_MS);
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error = error instanceof Error ? error.message : "PaperMentor could not be reached.";
      }
    }
  }

  private selectFile(files: FileList | File[]) {
    this.error = "";
    this.file = null;
    const file = files[0];
    const megabytes = Math.floor(this.maxZipBytes / (1024 * 1024));
    if (files.length !== 1 || !file?.name.toLowerCase().endsWith(".zip")) {
      this.error = "Choose one .zip file (Overleaf: Menu → Download → Source).";
    } else if (!file.size || file.size > this.maxZipBytes) {
      this.error = `Choose a non-empty zip of ${megabytes} MB or smaller.`;
    } else {
      this.file = file;
    }
  }

  private ready(): boolean {
    return Boolean(this.file && this.consent && !this.busy && this.overview?.enabled);
  }

  private async submit() {
    if (!this.ready() || !this.file) {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    this.error = "";
    this.notice = "";
    try {
      const params = new URLSearchParams({
        consent: PAPERMENTOR_CONSENT,
        filename: this.file.name.replace(/\.zip$/iu, ""),
        ...(this.venue ? { venue: this.venue } : {}),
        // Ticking the box is the member's agreement to the database lookups.
        ...(this.checkReferences && this.overview?.checks_references
          ? { check_references: "1", references_consent: REFERENCE_CHECK_CONSENT }
          : {}),
      });
      const response = await fetch(this.url(`/papermentor/reviews?${params.toString()}`), {
        method: "POST",
        headers: { ...memberAuthHeaders(this.sessionToken), "Content-Type": "application/zip" },
        body: this.file,
      });
      const answer = await response.json().catch(() => ({}));
      if (generation !== this.generation) {
        return;
      }
      if (!response.ok) {
        throw new Error(answer.error?.message || "The review could not be started.");
      }
      this.notice =
        "PaperMentor is on it. A review takes a few minutes; this list updates by itself, and you get a notification when it is ready.";
      this.file = null;
      await this.load();
    } catch (error) {
      if (generation === this.generation) {
        this.error = error instanceof Error ? error.message : "The review could not be started.";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }

  private async download(review: PaperMentorReview, kind: PaperMentorReviewFile) {
    this.error = "";
    try {
      const response = await fetch(this.url(`/papermentor/reviews/${review.id}/files/${kind}`), {
        headers: memberAuthHeaders(this.sessionToken),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error?.message || "The file could not be downloaded.");
      }
      const filename =
        review.downloads.find((entry) => entry.kind === kind)?.filename ?? `papermentor-${kind}`;
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      this.error = error instanceof Error ? error.message : "The file could not be downloaded.";
    }
  }

  private async toggleFindings(review: PaperMentorReview) {
    if (this.findings[review.id]) {
      const { [review.id]: _closed, ...rest } = this.findings;
      this.findings = rest;
      return;
    }
    this.findings = { ...this.findings, [review.id]: "loading" };
    try {
      const response = await fetch(this.url(`/papermentor/reviews/${review.id}/files/references`), {
        headers: memberAuthHeaders(this.sessionToken),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error?.message || "The reference check could not be loaded.");
      }
      this.findings = {
        ...this.findings,
        [review.id]: (body.findings ?? []) as ReferenceFindingView[],
      };
    } catch (error) {
      const { [review.id]: _failed, ...rest } = this.findings;
      this.findings = rest;
      this.error =
        error instanceof Error ? error.message : "The reference check could not be loaded.";
    }
  }

  private renderReferences(review: PaperMentorReview) {
    const references = review.references;
    if (!references) {
      return review.status === "running" && review.check_references
        ? html`<p class="hint">References are checked once the review is done.</p>`
        : nothing;
    }
    if (references.status !== "checked") {
      return html`<p class="hint">${references.message ?? "The references were not checked."}</p>`;
    }
    const opened = this.findings[review.id];
    // "pdf" only on a review from before the check stopped reading the built PDF.
    const from = references.source === "pdf" ? "the PDF" : "the paper's source";
    return html`<p>
        ${references.total ?? 0} references checked (from ${from}) · ${references.matched ?? 0}
        matched · ${references.not_found ?? 0} not found ·
        ${(references.needs_review ?? 0) + (references.unavailable ?? 0)} to look at
      </p>
      ${references.skipped_entries
        ? html`<p class="hint">
            ${references.skipped_entries} cited key(s) had no usable bibliography entry and were not
            checked.
          </p>`
        : nothing}
      <button class="secondary" @click=${() => void this.toggleFindings(review)}>
        ${opened ? "Hide reference check" : "Show reference check"}
      </button>
      ${opened === "loading"
        ? html`<p role="status">Loading…</p>`
        : opened
          ? html`<div class="findings">
              ${renderReferenceFindings(opened)}
              <p class="hint">
                Powered by CheckIfExist. Automated checks can be wrong. Review flagged citations; a
                missing match is not proof of fabrication.
              </p>
            </div>`
          : nothing}`;
  }

  private renderForm(overview: PaperMentorOverview) {
    const megabytes = Math.floor(this.maxZipBytes / (1024 * 1024));
    return html`<section>
      <h3>Review a paper</h3>
      <label
        class="drop"
        @dragover=${(event: DragEvent) => event.preventDefault()}
        @drop=${(event: DragEvent) => {
          event.preventDefault();
          if (event.dataTransfer && !this.busy) {
            this.selectFile(event.dataTransfer.files);
          }
        }}
      >
        ${this.file ? this.file.name : "Drop the Overleaf source zip here, or choose a file"}
        <input
          type="file"
          accept=".zip,application/zip"
          aria-label="Choose zip"
          ?disabled=${this.busy}
          @change=${(event: Event) => {
            const input = event.target as HTMLInputElement;
            if (input.files) {
              this.selectFile(input.files);
            }
            input.value = "";
          }}
        />
      </label>
      <p class="hint">In Overleaf: Menu → Download → Source. Up to ${megabytes} MB.</p>
      <label class="field"
        >Venue
        <select
          .value=${this.venue}
          ?disabled=${this.busy}
          @change=${(event: Event) => {
            this.venue = (event.target as HTMLSelectElement).value;
          }}
        >
          <option value="">arXiv (general)</option>
          ${overview.venues
            .filter((venue) => venue !== "arxiv")
            .map(
              (venue) =>
                html`<option value=${venue}>${venue.replaceAll("_", " ").toUpperCase()}</option>`,
            )}
        </select></label
      >
      <label class="field"
        ><input
          type="checkbox"
          .checked=${this.consent}
          ?disabled=${this.busy}
          @change=${(event: Event) => {
            this.consent = (event.target as HTMLInputElement).checked;
          }}
        />
        Send the draft's text to ${overview.model_provider ?? "the model provider"} for the
        review.</label
      >
      ${overview.checks_references
        ? html`<label class="field"
            ><input
              type="checkbox"
              name="check-references"
              .checked=${this.checkReferences}
              ?disabled=${this.busy}
              @change=${(event: Event) => {
                this.checkReferences = (event.target as HTMLInputElement).checked;
              }}
            />
            Also check every reference the paper cites against Crossref, Semantic Scholar, OpenAlex,
            DBLP and arXiv. Only the references are sent, read from the zip's .bib files (or its
            \\bibitem list).</label
          >`
        : nothing}
      <button ?disabled=${!this.ready()} @click=${() => void this.submit()}>
        ${this.busy ? "Uploading…" : "Run PaperMentor"}
      </button>
      ${this.notice ? html`<p role="status">${this.notice}</p>` : nothing}
      <p class="hint">
        You get the zip back with each comment as a <code>%PAPERMENTOR:</code> line above the text
        it is about, ready to upload to Overleaf as a new project (New Project → Upload Project),
        plus the PDF with every comment highlighted and a report. Only you can see your reviews, and
        they are deleted after two weeks.
      </p>
    </section>`;
  }

  private renderReview(review: PaperMentorReview) {
    const severity = review.by_severity ?? {};
    const counts =
      review.status === "reviewed"
        ? `${review.comments ?? 0} comments` +
          (severity.critical ? ` · ${severity.critical} critical` : "") +
          (severity.warning ? ` · ${severity.warning} warnings` : "") +
          (severity.suggestion ? ` · ${severity.suggestion} suggestions` : "")
        : "";
    return html`<div class="review">
      <header>
        <strong>${review.label}</strong>
        <span class="status" data-status=${review.status}
          >${review.status === "running" && review.phase === "references"
            ? "Checking references…"
            : STATUS_LABELS[review.status]}</span
        >
      </header>
      <p class="hint">${review.venue} · ${new Date(review.created_at).toLocaleString()}</p>
      ${counts ? html`<p>${counts}</p>` : nothing}
      ${review.status === "reviewed" && !review.pdf
        ? html`<p class="hint">
            The PDF could not be built on the server; the comments are in the zip's .tex files and
            the report.
          </p>`
        : nothing}
      ${review.message ? html`<p>${review.message}</p>` : nothing} ${this.renderReferences(review)}
      <div>
        ${review.downloads
          // The reference check is read in place, above; its JSON is not something to download.
          .filter(({ kind }) => kind !== "references")
          .map(
            ({ kind }) =>
              html`<button
                class="secondary ${kind === "commented_zip" ? "primary" : ""}"
                @click=${() => void this.download(review, kind)}
              >
                ${FILE_LABELS[kind]}
              </button>`,
          )}
      </div>
    </div>`;
  }

  override render() {
    const overview = this.overview;
    return html`${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
    ${!overview
      ? this.error
        ? nothing
        : html`<p role="status">Loading…</p>`
      : html`${overview.enabled
            ? this.renderForm(overview)
            : html`<section>
                <p>PaperMentor is not set up on this AdminBot host yet. Ask an admin.</p>
              </section>`}
          <section aria-live="polite">
            <h3>Your reviews</h3>
            ${overview.reviews.length
              ? overview.reviews.map((review) => this.renderReview(review))
              : html`<p class="hint">No reviews yet.</p>`}
          </section>
          <h3 class="pdf-only">Only have a PDF? Check its references</h3>
          <p class="hint">
            For a paper without its LaTeX source -- a camera-ready, or a submission you are
            reviewing. Nothing is kept.
          </p>
          <adminbot-reference-checker
            .baseUrl=${this.baseUrl}
            .sessionToken=${this.sessionToken}
            .checkers=${overview.reference_checkers}
          ></adminbot-reference-checker>`}`;
  }
}

if (!customElements.get("adminbot-papermentor")) {
  customElements.define("adminbot-papermentor", PaperMentorView);
}
