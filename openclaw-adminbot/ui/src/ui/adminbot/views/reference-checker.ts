import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

type ScanResult = {
  citation_count: number;
  uncertain_count: number;
  findings: { citation: string; status: string; explanation: string }[];
};

export class ReferenceChecker extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private file: File | null = null;
  @state() private busy = false;
  @state() private error = "";
  @state() private result: ScanResult | null = null;
  private generation = 0;
  private controller?: AbortController;

  static override styles = css`
    :host {
      display: block;
      max-width: 760px;
      margin: 24px auto;
    }
    section {
      padding: 28px;
      border: 1px solid var(--border, #8885);
      border-radius: 14px;
    }
    h2 {
      margin-top: 0;
    }
    p {
      line-height: 1.5;
    }
    .hint {
      color: var(--muted, #888);
      font-size: 14px;
    }
    .drop {
      display: block;
      padding: 36px 20px;
      border: 2px dashed var(--border, #8885);
      border-radius: 10px;
      text-align: center;
      cursor: pointer;
      margin: 24px 0 16px;
    }
    .drop:focus-within {
      outline: 2px solid var(--accent, #5875e8);
    }
    input {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
    }
    .browse {
      display: inline-block;
      margin-top: 16px;
      text-decoration: underline;
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
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    [role="alert"] {
      color: var(--danger, #dc5353);
    }
    article {
      border-top: 1px solid var(--border, #8885);
      padding-top: 12px;
      margin-top: 16px;
      overflow-wrap: anywhere;
    }
    .results {
      margin-top: 24px;
    }
  `;

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.generation++;
      this.controller?.abort();
      this.file = null;
      this.result = null;
      this.error = "";
      this.busy = false;
    }
  }

  override disconnectedCallback() {
    this.generation++;
    this.controller?.abort();
    super.disconnectedCallback();
  }

  private select(files: FileList | File[]) {
    if (this.busy) {
      return;
    }
    this.result = null;
    this.error = "";
    this.file = null;
    const file = files[0];
    if (
      files.length !== 1 ||
      !file?.name.toLowerCase().endsWith(".pdf") ||
      (file.type && file.type !== "application/pdf")
    ) {
      this.error = "Choose one PDF file.";
    } else if (!file.size || file.size > 20 * 1024 * 1024) {
      this.error = "Choose a non-empty PDF of 20 MB or smaller.";
    } else {
      this.file = file;
    }
  }

  private async submit() {
    if (!this.file || this.busy || !this.sessionToken) {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    this.error = "";
    this.result = null;
    this.controller = new AbortController();
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/u, "")}/reference-check/pdf?consent=send-to-gptzero`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.sessionToken}`,
            "Content-Type": "application/pdf",
          },
          body: this.file,
          signal: this.controller.signal,
        },
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error?.message || "The check could not be completed.");
      }
      if (generation === this.generation) {
        this.result = body as ScanResult;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error = error instanceof Error ? error.message : "The check could not be completed.";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }

  override render() {
    return html`<section>
      <h2>PDF Reference Checker</h2>
      <p>Check a paper’s references for potentially fabricated or incorrect citations.</p>
      <label
        class="drop"
        @dragover=${(event: DragEvent) => event.preventDefault()}
        @drop=${(event: DragEvent) => {
          event.preventDefault();
          if (event.dataTransfer) {
            this.select(event.dataTransfer.files);
          }
        }}
      >
        ${this.file ? this.file.name : "Drop a PDF here, or choose a file"}
        <br /><span class="browse">Choose file</span>
        <input
          type="file"
          accept=".pdf,application/pdf"
          aria-label="Choose PDF"
          ?disabled=${this.busy}
          @change=${(event: Event) => {
            const input = event.target as HTMLInputElement;
            if (input.files) {
              this.select(input.files);
            }
            input.value = "";
          }}
        />
      </label>
      <p class="hint">
        PDF only · Up to 20 MB. Submit sends this PDF to GPTZero using the lab’s API account.
        AdminBot does not save the PDF or results. Every submission runs a new check.
      </p>
      <button
        ?disabled=${!this.file || this.busy || !this.sessionToken}
        @click=${() => void this.submit()}
      >
        ${this.busy ? "Checking…" : "Submit"}
      </button>
      ${this.busy
        ? html`<p role="status">Checking references. This can take a few minutes.</p>`
        : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.result
        ? html`<div class="results" aria-live="polite">
            <h3>Results</h3>
            <p>
              ${this.result.citation_count} citations · ${this.result.findings.length} flagged ·
              ${this.result.uncertain_count} uncertain
            </p>
            ${this.result.citation_count === 0
              ? html`<p>No citations were found. This PDF’s references could not be assessed.</p>`
              : this.result.findings.length === 0
                ? html`<p>No citations were flagged. Uncertain citations remain unverified.</p>`
                : nothing}
            ${this.result.findings.map(
              (finding) => html`<article>
                <strong
                  >${finding.status === "fake"
                    ? "Potentially fabricated citation"
                    : "Citation with issues"}</strong
                >
                <p>${finding.citation}</p>
                <p>${finding.explanation}</p>
              </article>`,
            )}
            <p class="hint">
              GPTZero checks references, not every claim in the paper. Review flagged citations
              before drawing conclusions.
            </p>
          </div>`
        : nothing}
    </section>`;
  }
}

if (!customElements.get("adminbot-reference-checker")) {
  customElements.define("adminbot-reference-checker", ReferenceChecker);
}
