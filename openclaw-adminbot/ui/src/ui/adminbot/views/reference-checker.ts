import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

type ScanResult = {
  citation_count?: number;
  uncertain_count?: number;
  findings: {
    citation: string;
    status: string;
    explanation: string;
    source?: string;
    title?: string;
    url?: string;
  }[];
};

export class ReferenceChecker extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private checker = "references-validation";
  @state() private file: File | null = null;
  @state() private busy = false;
  @state() private total = 0;
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
      overflow-wrap: anywhere;
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
    select {
      font: inherit;
      padding: 10px;
      margin-left: 12px;
      max-width: 100%;
      color: var(--text, inherit);
      background: var(--bg, transparent);
      border: 1px solid var(--border, #8885);
      border-radius: 8px;
    }
    .browse {
      display: inline-block;
      margin-top: 16px;
      text-decoration: underline;
    }
    a {
      color: var(--accent, #5875e8);
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
      --finding-color: var(--muted, #888);
      border: 1px solid color-mix(in srgb, var(--finding-color) 25%, transparent);
      border-left: 3px solid color-mix(in srgb, var(--finding-color) 65%, transparent);
      background: color-mix(in srgb, var(--finding-color) 7%, transparent);
      border-radius: 12px;
      padding: 18px 20px;
      margin-top: 12px;
      overflow-wrap: anywhere;
    }
    article[data-status="matched"] {
      --finding-color: #29966b;
    }
    article[data-status="not_found"],
    article[data-status="fake"] {
      --finding-color: #d96068;
    }
    article[data-status="review"],
    article[data-status="exist_with_issues"] {
      --finding-color: #b78a32;
    }
    article p {
      margin: 10px 0;
    }
    article strong {
      display: inline-block;
      padding: 4px 9px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--finding-color) 12%, transparent);
      font-size: 12px;
      letter-spacing: 0.02em;
    }
    .result-action {
      display: inline-block;
      padding: 8px 12px;
      margin: 8px 0 0;
      font-size: 13px;
      font-weight: 600;
      color: inherit;
      border: 1px solid var(--border, #8885);
      border-radius: 8px;
      text-decoration: none;
    }
    .result-action:hover {
      background: color-mix(in srgb, var(--finding-color) 14%, transparent);
      border-color: var(--finding-color);
    }
    .result-action:focus-visible {
      outline: 2px solid var(--accent, #5875e8);
      outline-offset: 3px;
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
    const consent = this.checker === "gptzero" ? "upload-to-gptzero" : "query-reference-databases";
    const generation = this.generation;
    this.busy = true;
    this.total = 0;
    this.error = "";
    this.result = null;
    this.controller = new AbortController();
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/u, "")}/reference-check/pdf?checker=${this.checker}&consent=${consent}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.sessionToken}`,
            "Content-Type": "application/pdf",
            Accept: "application/x-ndjson",
          },
          body: this.file,
          signal: this.controller.signal,
        },
      );
      if (
        !response.ok ||
        !response.headers?.get("content-type")?.includes("application/x-ndjson")
      ) {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error?.message || "The check could not be completed.");
        }
        if (generation === this.generation) {
          this.result = body as ScanResult;
        }
      } else {
        if (!response.body) {
          throw new Error("The check returned no results.");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        let complete = false;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (generation !== this.generation) {
              return;
            }
            pending += decoder.decode(value, { stream: !done });
            const lines = pending.split("\n");
            pending = lines.pop()!;
            for (const line of lines) {
              if (!line.trim()) {
                continue;
              }
              const event = JSON.parse(line);
              if (event.type === "error") {
                throw new Error(event.error?.message || "The check could not be completed.");
              }
              if (event.type === "progress") {
                this.total = event.total;
                this.result = {
                  findings: [
                    // Widened on purpose: `result` was set to null above, and TypeScript keeps that
                    // narrowing through the loop even though each progress event reassigns it.
                    ...((this.result as ScanResult | null)?.findings ?? []),
                    ...(event.finding ? [event.finding] : []),
                  ],
                };
              } else if (event.type === "complete") {
                this.result = event.result as ScanResult;
                complete = true;
              }
            }
            if (done) {
              break;
            }
          }
          if (!complete) {
            throw new Error(
              "Connection ended before all references were checked. Results shown so far are partial.",
            );
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
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
        >Checker
        <select
          aria-label="Checker"
          .value=${this.checker}
          ?disabled=${this.busy}
          @change=${(event: Event) => {
            if (this.busy) {
              return;
            }
            this.checker = (event.target as HTMLSelectElement).value;
            this.result = null;
            this.error = "";
          }}
        >
          <option value="references-validation">CheckIfExist</option>
          <option value="gptzero">GPTZero</option>
        </select>
      </label>
      ${this.checker === "gptzero"
        ? html`<p class="hint">
            GPTZero is currently not working with our account (403 access denied). You can retry if
            API access has been restored.
          </p>`
        : nothing}
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
        ${this.checker === "gptzero"
          ? html`PDF only · Up to 20 MB. Submit uploads the full PDF to GPTZero and may incur a
            charge. A GPTZero API key with bibliography access must be configured on the server.`
          : html`PDF only · Up to 20 MB, 200 pages and 100 references. The PDF is read on the
            AdminBot server. Submit sends extracted citations to Crossref, Semantic Scholar,
            OpenAlex, DBLP and arXiv. No API key is needed.`}
        AdminBot does not save the PDF or results. Every submission runs a new check.
      </p>
      <button
        ?disabled=${!this.file || this.busy || !this.sessionToken}
        @click=${() => void this.submit()}
      >
        ${this.busy ? "Checking…" : "Submit"}
      </button>
      ${this.busy
        ? html`<p role="status">
            ${this.total
              ? `${this.result?.findings.length ?? 0} of ${this.total} references checked.`
              : "Reading PDF and checking references…"}
          </p>`
        : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.result
        ? html`<div class="results" aria-live="polite">
            <h3>Results</h3>
            <p>
              ${this.checker === "gptzero"
                ? html`${this.result.citation_count ?? 0} citations assessed ·
                  ${this.result.findings.length} flagged · ${this.result.uncertain_count ?? 0}
                  uncertain`
                : html`${this.total || this.result.findings.length} extracted references ·
                  ${this.result.findings.filter((f) => f.status === "matched").length} matched ·
                  ${this.result.findings.filter((f) => f.status !== "matched").length} need review`}
            </p>
            ${this.result.findings.length === 0 && !this.busy && !this.error
              ? html`<p>
                  ${this.checker === "gptzero" && this.result.citation_count
                    ? "No citations were flagged. Review any uncertain citations separately."
                    : "No references were extracted. This PDF could not be assessed."}
                </p>`
              : nothing}
            ${this.result.findings.map(
              (finding) => html`<article data-status=${finding.status}>
                <strong
                  >${(
                    {
                      fake: "Potentially fabricated",
                      exist_with_issues: "Check metadata",
                      matched: "Matching record found",
                      review: "Check metadata",
                      not_found: "Not found",
                      unavailable: "Could not check",
                    } as Record<string, string>
                  )[finding.status] ?? "Needs review"}</strong
                >
                <p>${finding.citation}</p>
                <p>${finding.explanation}</p>
                ${finding.source
                  ? html`<p>Best match (${finding.source}): ${finding.title}</p>`
                  : nothing}
                ${finding.status !== "not_found" && finding.url && /^https?:\/\//i.test(finding.url)
                  ? html`<a
                      class="result-action database"
                      href=${finding.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      >View database record</a
                    >`
                  : nothing}
                ${finding.status === "not_found"
                  ? html`<a
                      class="result-action scholar"
                      href=${"https://scholar.google.com/scholar?q=" +
                      encodeURIComponent(finding.citation)}
                      target="_blank"
                      rel="noopener noreferrer"
                      >Search Google Scholar</a
                    >`
                  : nothing}
              </article>`,
            )}
            <p class="hint">
              ${this.checker === "gptzero" ? "Powered by GPTZero." : "Powered by CheckIfExist."}
              Automated checks can be wrong. Review flagged citations; a missing match is not proof
              of fabrication.
            </p>
          </div>`
        : nothing}
    </section>`;
  }
}

if (!customElements.get("adminbot-reference-checker")) {
  customElements.define("adminbot-reference-checker", ReferenceChecker);
}
