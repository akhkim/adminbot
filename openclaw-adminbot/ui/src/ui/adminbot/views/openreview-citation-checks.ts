import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { authedJson, peekAuthedRead } from "../auth/session.ts";

type Finding = { citation: string; status: string; explanation: string };

type Check = {
  submission_id: string;
  pdf_path: string;
  title: string;
  venue_id: string;
  status: "completed" | "unreadable" | "failed";
  checked_at: string;
  attempts: number;
  // The summary view sends counts only; the flagged references are read when a row is opened.
  // A service that predates the counts sends the references inline instead.
  findings?: Finding[];
  finding_count?: number;
  flagged_count?: number;
  not_found_count?: number;
  version_count?: number;
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
  /** Flagged references per submission, read the first time its row is opened. */
  @state() private opened = new Map<string, Finding[] | "loading" | "error">();
  private generation = 0;

  static override styles = css`
    :host {
      display: block;
      max-width: 860px;
      /* Left-aligned with PaperMentor above it, not centred in the page. */
      margin: var(--space-6, 24px) 0;
    }
    /* Follows PaperMentor on the same page: a hairline and space, not a box (ui/DESIGN.md). */
    section {
      padding-top: var(--space-6, 24px);
      border-top: 1px solid var(--border, #8885);
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
    a {
      color: var(--accent, #5875e8);
    }
    [role="alert"] {
      color: var(--danger, #dc5353);
    }
    article {
      --finding-color: var(--ok, #29966b);
      border-top: 1px solid var(--border, #8885);
      padding: var(--space-4, 16px) 0;
      overflow-wrap: anywhere;
    }
    article[data-state="flagged"] {
      --finding-color: var(--danger, #d96068);
    }
    article[data-state="unchecked"] {
      --finding-color: var(--warn, #b78a32);
    }
    article h3 {
      margin: 0 0 var(--space-1, 4px);
      font-size: 16px;
    }
    /* The row is unboxed, so a dot before the title carries the check's state. */
    article h3::before {
      content: "";
      display: inline-block;
      width: 8px;
      height: 8px;
      margin-right: var(--space-2, 8px);
      border-radius: 50%;
      background: var(--finding-color);
      vertical-align: middle;
    }
    article p {
      margin: var(--space-2, 8px) 0;
    }
    li {
      margin: var(--space-2, 8px) 0;
    }
    summary {
      cursor: pointer;
    }
  `;

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.listing = null;
      this.error = "";
      this.opened = new Map();
      void this.load();
    }
  }

  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }

  private base() {
    return this.baseUrl.replace(/\/$/u, "");
  }

  private async load() {
    const generation = ++this.generation;
    if (!this.sessionToken) {
      return;
    }
    const path = "/openreview/citation-checks?view=summary";
    // A revisit draws what this session last read while the request revalidates it.
    const seen = peekAuthedRead(this.base(), path, this.sessionToken) as Listing | undefined;
    if (seen && Array.isArray(seen.checks)) {
      this.listing = seen;
    }
    try {
      const result = await authedJson(this.base(), path, "GET", this.sessionToken);
      if (generation !== this.generation) {
        return;
      }
      if ("unreachable" in result) {
        throw new Error();
      }
      if (result.response.status === 401 || result.response.status === 403) {
        return;
      }
      if (!result.response.ok) {
        throw new Error();
      }
      this.listing = result.body as Listing;
    } catch {
      if (generation === this.generation && !this.listing) {
        this.error = "Automatic OpenReview checks could not be loaded.";
      }
    }
  }

  private async openFindings(submissionId: string) {
    const held = this.opened.get(submissionId);
    // A failed read is asked again the next time the row is opened.
    if (held !== undefined && held !== "error") {
      return;
    }
    const generation = this.generation;
    const set = (value: Finding[] | "loading" | "error") => {
      this.opened = new Map(this.opened).set(submissionId, value);
    };
    set("loading");
    try {
      const result = await authedJson(
        this.base(),
        `/openreview/citation-checks?view=findings&submission_id=${encodeURIComponent(submissionId)}`,
        "GET",
        this.sessionToken,
      );
      if (generation !== this.generation) {
        return;
      }
      if ("unreachable" in result || !result.response.ok) {
        throw new Error();
      }
      const findings = (result.body as { findings?: Finding[] }).findings;
      set(Array.isArray(findings) ? findings : []);
    } catch {
      if (generation === this.generation) {
        set("error");
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
      <h3>OpenReview submissions</h3>
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
      ${rows.map((check) =>
        this.renderCheck(check, check.version_count ?? versions.get(check.submission_id) ?? 1),
      )}
      ${rows.length
        ? html`<p class="hint">
            Automated checks can be wrong. A missing match is not proof of fabrication.
          </p>`
        : nothing}
    </section>`;
  }

  private needsAttention(check: Check) {
    return check.status !== "completed" || this.flaggedCount(check) > 0;
  }

  private flaggedCount(check: Check) {
    return check.flagged_count ?? (check.findings ?? []).filter(flagged).length;
  }

  private renderCheck(check: Check, versionCount: number) {
    const inline = check.findings?.filter(flagged);
    const flaggedCount = this.flaggedCount(check);
    const referenceCount = check.finding_count ?? check.findings?.length ?? 0;
    const notFound =
      check.not_found_count ??
      (inline ?? []).filter((finding) => finding.status === "not_found").length;
    const tone = check.status !== "completed" ? "unchecked" : flaggedCount ? "flagged" : "clean";
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
          ? flaggedCount
            ? `${notFound} not found · ${flaggedCount - notFound} to check · ${referenceCount} references`
            : `All ${referenceCount} references matched a record.`
          : check.status === "unreadable"
            ? `Not fully checked: ${check.error ?? "the PDF could not be read."}${
                flaggedCount
                  ? ` ${flaggedCount} of the entries that were checked need review.`
                  : ""
              }`
            : `Check failed (attempt ${check.attempts}): ${check.error ?? "unknown error."}`}
        ${check.notification_proposal_id ? " An email is waiting in Pending Actions." : ""}
      </p>
      ${flaggedCount
        ? html`<details
            @toggle=${(event: Event) => {
              if ((event.currentTarget as HTMLDetailsElement).open && !inline) {
                void this.openFindings(check.submission_id);
              }
            }}
          >
            <summary>Show ${flaggedCount} flagged reference(s)</summary>
            ${this.renderFindings(inline ?? this.opened.get(check.submission_id))}
          </details>`
        : nothing}
    </article>`;
  }

  private renderFindings(findings: Finding[] | "loading" | "error" | undefined) {
    if (findings === undefined || findings === "loading") {
      return html`<p class="hint">Loading references…</p>`;
    }
    if (findings === "error") {
      return html`<p role="alert">The flagged references could not be loaded.</p>`;
    }
    return html`<ul>
      ${findings.map(
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
    </ul>`;
  }
}

if (!customElements.get("adminbot-openreview-citation-checks")) {
  customElements.define("adminbot-openreview-citation-checks", OpenReviewCitationChecks);
}
