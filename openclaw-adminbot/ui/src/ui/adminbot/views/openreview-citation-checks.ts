import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

type Finding = { citation: string; status: string; explanation: string };

type Check = {
  submission_id: string;
  pdf_path: string;
  title: string;
  venue_id: string;
  status: "completed" | "unreadable" | "failed";
  checked_at: string;
  attempts: number;
  findings?: Finding[];
  error?: string;
  notification_proposal_id?: string;
};

type Sweep = { started_at: string; checked: number; flagged: number; failed: number };

type Listing = {
  enabled: boolean;
  running: boolean;
  last_sweep?: Sweep;
  current_sweep?: Sweep;
  checks: Check[];
};

const flagged = (finding: Finding) => finding.status === "not_found" || finding.status === "review";

/**
 * The automatic OpenReview citation checks, one row per submission at its latest checked version.
 * Read-only: sweeps run on the service's schedule, and emailing about findings goes through
 * Pending Actions. The route is admin-only server-side; a refused read renders nothing.
 */
export class OpenReviewCitationChecks extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private listing: Listing | null = null;
  @state() private error = "";
  private generation = 0;

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
    a {
      color: var(--accent, #5875e8);
    }
    [role="alert"] {
      color: var(--danger, #dc5353);
    }
    article {
      --finding-color: #29966b;
      border: 1px solid color-mix(in srgb, var(--finding-color) 40%, transparent);
      background: color-mix(in srgb, var(--finding-color) 6%, transparent);
      border-radius: 12px;
      padding: 14px 18px;
      margin-top: 12px;
      overflow-wrap: anywhere;
    }
    article[data-state="flagged"] {
      --finding-color: #d96068;
    }
    article[data-state="unchecked"] {
      --finding-color: #b78a32;
    }
    article h3 {
      margin: 0 0 4px;
      font-size: 16px;
    }
    article p {
      margin: 6px 0;
    }
    li {
      margin: 8px 0;
    }
    summary {
      cursor: pointer;
    }
  `;

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.listing = null;
      this.error = "";
      void this.load();
    }
  }

  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }

  private async load() {
    const generation = ++this.generation;
    if (!this.sessionToken) {
      return;
    }
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/u, "")}/openreview/citation-checks`,
        { headers: { Authorization: `Bearer ${this.sessionToken}` } },
      );
      if (generation !== this.generation) {
        return;
      }
      if (response.status === 401 || response.status === 403) {
        return;
      }
      if (!response.ok) {
        throw new Error();
      }
      this.listing = (await response.json()) as Listing;
    } catch {
      if (generation === this.generation) {
        this.error = "Automatic OpenReview checks could not be loaded.";
      }
    }
  }

  override render() {
    if (this.error) {
      return html`<section><p role="alert">${this.error}</p></section>`;
    }
    const listing = this.listing;
    if (!listing) {
      return nothing;
    }
    // Newest check first from the server, so the first row seen per paper is its latest version.
    const latest = new Map<string, Check>();
    const versions = new Map<string, number>();
    for (const check of listing.checks) {
      if (!latest.has(check.submission_id)) {
        latest.set(check.submission_id, check);
      }
      versions.set(check.submission_id, (versions.get(check.submission_id) ?? 0) + 1);
    }
    const rows = [...latest.values()].toSorted(
      (a, b) =>
        Number(this.needsAttention(b)) - Number(this.needsAttention(a)) ||
        b.checked_at.localeCompare(a.checked_at),
    );
    const sweep = listing.current_sweep ?? listing.last_sweep;
    return html`<section>
      <h2>OpenReview submissions</h2>
      <p>
        Every paper the lab's OpenReview account is an author of is checked automatically each time
        a new PDF is uploaded.
      </p>
      <p class="hint">
        ${!listing.enabled
          ? "Automatic checks are off on this deployment."
          : listing.running
            ? `A check is running${sweep ? ` · ${sweep.checked} checked so far` : ""}.`
            : sweep
              ? `Last sweep ${new Date(sweep.started_at).toLocaleString()}: ${sweep.checked} checked, ${sweep.flagged} flagged, ${sweep.failed} could not be checked.`
              : "Waiting for the first scheduled sweep."}
      </p>
      ${rows.length === 0 && listing.enabled
        ? html`<p>No submissions have been checked yet.</p>`
        : nothing}
      ${rows.map((check) => this.renderCheck(check, versions.get(check.submission_id) ?? 1))}
      ${rows.length
        ? html`<p class="hint">
            Automated checks can be wrong. A missing match is not proof of fabrication.
          </p>`
        : nothing}
    </section>`;
  }

  private needsAttention(check: Check) {
    return check.status !== "completed" || (check.findings ?? []).some(flagged);
  }

  private renderCheck(check: Check, versionCount: number) {
    const findings = check.findings ?? [];
    const issues = findings.filter(flagged);
    const notFound = issues.filter((finding) => finding.status === "not_found").length;
    const tone = check.status !== "completed" ? "unchecked" : issues.length ? "flagged" : "clean";
    return html`<article data-state=${tone}>
      <h3>
        <a
          href=${`https://openreview.net/forum?id=${encodeURIComponent(check.submission_id)}`}
          target="_blank"
          rel="noopener noreferrer"
          >${check.title}</a
        >
      </h3>
      <p class="hint">
        ${check.venue_id} · checked ${new Date(check.checked_at).toLocaleString()}
        ${versionCount > 1 ? ` · ${versionCount} versions checked` : ""}
      </p>
      <p>
        ${check.status === "completed"
          ? issues.length
            ? `${notFound} not found · ${issues.length - notFound} to check · ${findings.length} references`
            : `All ${findings.length} references matched a record.`
          : check.status === "unreadable"
            ? `Could not be checked: ${check.error ?? "the PDF could not be read."}`
            : `Check failed (attempt ${check.attempts}): ${check.error ?? "unknown error."}`}
        ${check.notification_proposal_id ? " An email is waiting in Pending Actions." : ""}
      </p>
      ${issues.length
        ? html`<details>
            <summary>Show ${issues.length} flagged reference(s)</summary>
            <ul>
              ${issues.map(
                (finding) => html`<li>
                  <strong>${finding.status === "not_found" ? "Not found" : "Check details"}</strong>
                  — ${finding.citation}
                  <br /><span class="hint">${finding.explanation}</span>
                  ${finding.status === "not_found"
                    ? html`<br /><a
                          href=${"https://scholar.google.com/scholar?q=" +
                          encodeURIComponent(finding.citation)}
                          target="_blank"
                          rel="noopener noreferrer"
                          >Search Google Scholar</a
                        >`
                    : nothing}
                </li>`,
              )}
            </ul>
          </details>`
        : nothing}
    </article>`;
  }
}

if (!customElements.get("adminbot-openreview-citation-checks")) {
  customElements.define("adminbot-openreview-citation-checks", OpenReviewCitationChecks);
}
