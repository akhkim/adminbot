// Control UI view for the Grant Report tab: the lab's papers on two maps, and the track-record
// blocks the proposal needs.
//
// Reads the live paper store, so the report tracks the database rather than a file somebody has to
// remember to edit -- a paper added to AdminBot shows up here on the next render. What it cannot
// read is where a paper belongs on the safety taxonomy, which is a judgment call; resolve.ts places
// what it can and marks the rest, and every surface below distinguishes a curated placement from a
// guess. A guess that reaches a funder looking like a considered claim is the failure mode this
// whole screen is arranged to prevent.
//
// Three panels, because compiling a grant report is three different questions: what kind of safety
// work do we do (Areas), what have we already done for each thing we are asking money for
// (Track record), and what did neither map catch, plus what still needs a human (Coverage).
import { html, nothing, LitElement } from "lit";
import { property } from "lit/decorators.js";
import type { AdminBotPaperRecord } from "../controllers/admin.ts";
import {
  SAFETY_AREAS,
  SAFETY_AREA_BY_ID,
  SOURCE,
  TAXONOMY_FRAMING,
  type SafetyAreaId,
} from "../grant-report/areas.ts";
import {
  areaCounts,
  areaMapMarkdown,
  areaMixForSection,
  fullReportMarkdown,
  papersForArea,
  papersForSection,
  pipelinePapers,
  sectionMarkdown,
  unclassifiedPapers,
  unmappedPapers,
} from "../grant-report/linkage.ts";
import { needsReview, resolvePapers, type ClassifiedPaper } from "../grant-report/resolve.ts";
import {
  GRANT_SECTIONS,
  GRANT_SECTION_BY_ID,
  type GrantSection,
} from "../grant-report/sections.ts";

type Panel = "areas" | "track" | "coverage";

const PANEL_LABELS: Record<Panel, string> = {
  areas: "Area map",
  track: "Track record",
  coverage: "Coverage",
};

// One hue per area, in the order the review lists them. Deliberately not the urgency ramp the
// deadlines and opportunities boards use -- nothing here is more urgent than anything else, so the
// colors are identity, not severity.
const AREA_COLORS: Record<SafetyAreaId, string> = {
  alignment: "#e2725b",
  control: "#e0a458",
  whiteBox: "#5fb6d4",
  evals: "#7d9de0",
  construction: "#9b8ad4",
  aiSolve: "#5fc9a0",
};

function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text);
}

class AdminbotGrantReportView extends LitElement {
  /** The live store's papers. Empty until the AdminBot load lands, which is a real render state. */
  @property({ attribute: false }) records: readonly AdminBotPaperRecord[] = [];

  private panel: Panel = "areas";
  private areaFilter: SafetyAreaId | null = null;
  private openSections = new Set<string>();
  private copied: string | null = null;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  private select(panel: Panel): void {
    this.panel = panel;
    this.requestUpdate();
  }

  private toggleArea(area: SafetyAreaId): void {
    this.areaFilter = this.areaFilter === area ? null : area;
    this.requestUpdate();
  }

  private toggleSection(id: string): void {
    if (this.openSections.has(id)) {
      this.openSections.delete(id);
    } else {
      this.openSections.add(id);
    }
    this.requestUpdate();
  }

  // The confirmation is per-button rather than global: with a copy button on every section, one
  // shared "Copied" flag would light up the wrong row.
  private copy(key: string, text: string): void {
    copyToClipboard(text);
    this.copied = key;
    this.requestUpdate();
    setTimeout(() => {
      if (this.copied === key) {
        this.copied = null;
        this.requestUpdate();
      }
    }, 1600);
  }

  private renderCopyButton(key: string, text: string, label = "Copy markdown") {
    return html`
      <button class="gr-copy" @click=${() => this.copy(key, text)}>
        ${this.copied === key ? "Copied" : label}
      </button>
    `;
  }

  private renderAreaChips(paper: ClassifiedPaper) {
    if (paper.areas.length === 0) {
      return html`<span class="gr-chip gr-chip-none">no area</span>`;
    }
    return paper.areas.map(
      (id) => html`
        <span class="gr-chip" style=${`--c:${AREA_COLORS[id]}`}>${SAFETY_AREA_BY_ID[id].name}</span>
      `,
    );
  }

  private renderPaperRow(paper: ClassifiedPaper) {
    return html`
      <div class=${`gr-paper ${paper.origin === "curated" ? "" : "is-unconfirmed"}`}>
        <div class="gr-paper-head">
          <span class="gr-paper-title">
            ${paper.link
              ? html`<a href=${paper.link} target="_blank" rel="noopener">${paper.title}</a>`
              : paper.title}
          </span>
          ${paper.origin === "inferred"
            ? html`<span
                class="gr-chip gr-chip-warn"
                title="Placed by keyword rule, not by a person"
                >inferred — confirm</span
              >`
            : nothing}
          ${paper.origin === "unclassified"
            ? html`<span class="gr-chip gr-chip-warn">needs placing</span>`
            : nothing}
          ${paper.fromSnapshot && !paper.published
            ? html`<span class="gr-chip gr-chip-quiet" title="On the sheet, no PaperPublish record"
                >sheet only</span
              >`
            : nothing}
          ${paper.published ? html`<span class="gr-chip gr-chip-quiet">published</span>` : nothing}
        </div>
        <div class="gr-paper-meta">
          ${paper.venue ? html`<span>${paper.venue}</span>` : nothing}
          ${paper.authors ? html`<span class="gr-authors">${paper.authors}</span>` : nothing}
        </div>
        <div class="gr-chips">
          ${this.renderAreaChips(paper)}
          ${paper.sections.map(
            (id) =>
              html`<span class="gr-chip gr-chip-sec" title=${GRANT_SECTION_BY_ID[id]?.title ?? id}
                >${GRANT_SECTION_BY_ID[id]?.number ?? id}</span
              >`,
          )}
        </div>
        ${paper.alsoListedAs
          ? html`<div class="gr-note">Also on the sheet as: ${paper.alsoListedAs}</div>`
          : nothing}
      </div>
    `;
  }

  private renderReviewBanner(papers: readonly ClassifiedPaper[]) {
    const pending = needsReview(papers);
    if (pending.length === 0) {
      return nothing;
    }
    return html`
      <div class="gr-banner">
        <strong>${pending.length}</strong> of ${papers.length} papers are placed by keyword rule
        rather than by a person. They carry a guess everywhere they appear, including in the
        exported markdown &mdash; confirm them in
        <code>ui/src/ui/adminbot/grant-report/papers.ts</code> before this goes to a funder.
        <button class="gr-copy" @click=${() => this.select("coverage")}>Review them</button>
      </div>
    `;
  }

  private renderAreas(papers: readonly ClassifiedPaper[]) {
    const counts = areaCounts(papers);
    const byId = new Map(counts.map((row) => [row.area, row.count]));
    const shown = this.areaFilter ? papersForArea(papers, this.areaFilter) : papers;
    return html`
      <p class="gr-intro">${TAXONOMY_FRAMING}</p>
      ${this.renderReviewBanner(papers)}
      <div class="gr-area-grid">
        ${SAFETY_AREAS.map((area) => {
          const active = this.areaFilter === area.id;
          return html`
            <button
              class=${`gr-area ${active ? "is-active" : ""}`}
              style=${`--c:${AREA_COLORS[area.id]}`}
              aria-pressed=${active ? "true" : "false"}
              @click=${() => this.toggleArea(area.id)}
            >
              <div class="gr-area-head">
                <span class="gr-area-name">${area.name}</span>
                <span class="gr-area-count">${byId.get(area.id) ?? 0}</span>
              </div>
              <div class="gr-area-gloss">${area.gloss}</div>
              <div class="gr-area-tech">${area.techniques.join(" · ")}</div>
            </button>
          `;
        })}
      </div>
      <div class="gr-listhead">
        <span>
          ${this.areaFilter
            ? `${shown.length} in ${SAFETY_AREA_BY_ID[this.areaFilter].name}`
            : `All ${shown.length} papers`}
        </span>
        <span class="gr-listhead-right">
          ${this.areaFilter
            ? html`<button class="gr-copy" @click=${() => this.toggleArea(this.areaFilter!)}>
                Clear filter
              </button>`
            : nothing}
          ${this.renderCopyButton("area-map", areaMapMarkdown(papers), "Copy table")}
        </span>
      </div>
      <div class="gr-papers">${shown.map((paper) => this.renderPaperRow(paper))}</div>
    `;
  }

  private renderSection(papers: readonly ClassifiedPaper[], section: GrantSection) {
    const open = this.openSections.has(section.id);
    const inSection = papersForSection(papers, section.id);
    const mix = areaMixForSection(papers, section.id);
    return html`
      <div class=${`gr-section gr-depth-${section.depth}`}>
        <button class="gr-section-head" @click=${() => this.toggleSection(section.id)}>
          <span class="gr-caret">${open ? "▾" : "▸"}</span>
          <span class="gr-section-number">${section.number}</span>
          <span class="gr-section-title">${section.title}</span>
          <span class="gr-section-count">${inSection.length}</span>
        </button>
        ${open
          ? html`
              <div class="gr-section-body">
                <p class="gr-summary">${section.summary}</p>
                <div class="gr-mix">
                  ${mix.map(
                    (row) => html`
                      <span class="gr-chip" style=${`--c:${AREA_COLORS[row.area]}`}>
                        ${row.name} ${row.count}
                      </span>
                    `,
                  )}
                </div>
                <div class="gr-tr">
                  <div class="gr-tr-head">
                    <h4>Track record</h4>
                    ${this.renderCopyButton(`sec-${section.id}`, sectionMarkdown(section))}
                  </div>
                  <p class="gr-tr-lede">${section.trackRecord.lede}</p>
                  <ul class="gr-tr-list">
                    ${section.trackRecord.bullets.map(
                      (bullet) => html`
                        <li>
                          <strong>${bullet.label}</strong>${bullet.links?.length
                            ? html` (${bullet.links.map(
                                (link, index) =>
                                  html`${index > 0 ? ", " : ""}<a
                                      href=${link.href}
                                      target="_blank"
                                      rel="noopener"
                                      >${link.text}</a
                                    >`,
                              )})`
                            : nothing}:
                          ${bullet.detail}
                        </li>
                      `,
                    )}
                  </ul>
                </div>
                <details class="gr-evidence">
                  <summary>${inSection.length} papers assigned here</summary>
                  <div class="gr-papers">
                    ${inSection.map((paper) => this.renderPaperRow(paper))}
                  </div>
                </details>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private renderTrack(papers: readonly ClassifiedPaper[]) {
    return html`
      <div class="gr-listhead">
        <span>
          One track-record block per section of Part 1, in the shape Part 2.3 already uses. The
          prose is written by hand; the paper counts beside it are live.
        </span>
        <span class="gr-listhead-right">
          <button
            class="gr-copy"
            @click=${() => {
              const allOpen = this.openSections.size === GRANT_SECTIONS.length;
              this.openSections = allOpen
                ? new Set()
                : new Set(GRANT_SECTIONS.map((section) => section.id));
              this.requestUpdate();
            }}
          >
            ${this.openSections.size === GRANT_SECTIONS.length ? "Collapse all" : "Expand all"}
          </button>
          ${this.renderCopyButton("full", fullReportMarkdown(papers), "Copy full report")}
        </span>
      </div>
      <div class="gr-sections">
        ${GRANT_SECTIONS.map((section) => this.renderSection(papers, section))}
      </div>
    `;
  }

  private renderCoverage(papers: readonly ClassifiedPaper[]) {
    const pipeline = pipelinePapers(papers);
    const pending = needsReview(papers);
    const unmapped = unmappedPapers(papers);
    const unclassified = unclassifiedPapers(papers);
    const live = papers.filter((paper) => !paper.fromSnapshot);
    const stats = [
      { label: "Papers in the report", value: pipeline.length },
      { label: "From the live store", value: live.length },
      { label: "Awaiting confirmation", value: pending.length },
      { label: "Unclaimed by the agenda", value: unmapped.length },
    ];
    const maxCount = Math.max(
      1,
      ...GRANT_SECTIONS.filter((s) => s.depth > 2).map(
        (s) => papersForSection(papers, s.id).length,
      ),
    );
    return html`
      <div class="gr-stats">
        ${stats.map(
          (stat) => html`
            <div class="gr-stat">
              <div class="gr-stat-value">${stat.value}</div>
              <div class="gr-stat-label">${stat.label}</div>
            </div>
          `,
        )}
      </div>
      ${pending.length > 0
        ? html`
            <h4 class="gr-h4">Awaiting confirmation</h4>
            <p class="gr-intro">
              Papers the live store carries that no one has placed by hand. The keyword rules made a
              guess where they could; everything here is unconfirmed, and it is marked as such in
              the export too. Confirm a paper by giving it an entry in
              <code>grant-report/papers.ts</code>.
            </p>
            <div class="gr-papers">${pending.map((paper) => this.renderPaperRow(paper))}</div>
          `
        : nothing}
      <h4 class="gr-h4">Papers per proposal section</h4>
      <div class="gr-bars">
        ${GRANT_SECTIONS.filter((section) => section.depth > 2).map((section) => {
          const count = papersForSection(papers, section.id).length;
          return html`
            <div class="gr-bar-row">
              <span class="gr-bar-label">${section.number} ${section.title}</span>
              <span class="gr-bar-track">
                <span class="gr-bar-fill" style=${`width:${(count / maxCount) * 100}%`}></span>
              </span>
              <span class="gr-bar-value">${count}</span>
            </div>
          `;
        })}
      </div>
      <h4 class="gr-h4">Lab output the technical agenda does not claim</h4>
      <p class="gr-intro">
        Not a gap to close by force. These are real papers that Part 1 does not ask money for, and
        the honest report says so rather than stretching a section to cover them.
      </p>
      <div class="gr-papers">${unmapped.map((paper) => this.renderPaperRow(paper))}</div>
      ${unclassified.length > 0
        ? html`
            <h4 class="gr-h4">Outside the six-area taxonomy</h4>
            <p class="gr-intro">
              The review covers technical AGI safety only, so misuse, capability and applied-domain
              work has no area by construction.
            </p>
            <div class="gr-papers">${unclassified.map((paper) => this.renderPaperRow(paper))}</div>
          `
        : nothing}
    `;
  }

  override render() {
    const papers = resolvePapers(this.records);
    return html`
      <style>
        .grant-report-view {
          padding: 4px 2px 24px;
        }
        .grant-report-view .gr-intro {
          color: var(--text-muted, #9fb0cc);
          font-size: 13px;
          margin: 0 0 14px;
          max-width: 76ch;
        }
        .gr-prov {
          color: var(--text-muted, #66799a);
          font-size: 11.5px;
          margin: 0 0 14px;
          max-width: 90ch;
          line-height: 1.6;
        }
        .gr-prov a {
          color: inherit;
        }
        .gr-banner {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 10px 13px;
          margin-bottom: 16px;
          border: 1px solid #e0a458;
          border-radius: 10px;
          background: color-mix(in srgb, #e0a458 8%, transparent);
          color: var(--text, #d7e2f4);
          font-size: 12.5px;
          line-height: 1.6;
        }
        .gr-panels {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-bottom: 16px;
        }
        .gr-panel-tab {
          padding: 6px 12px;
          border: 1px solid var(--border, #26324a);
          border-radius: 999px;
          background: var(--surface, #141b2b);
          color: var(--text, #d7e2f4);
          font-size: 13px;
          cursor: pointer;
        }
        .gr-panel-tab.is-active {
          border-color: var(--accent, #4f8cff);
          color: var(--accent, #4f8cff);
        }
        .gr-area-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 10px;
          margin-bottom: 18px;
        }
        /* The area's color lives in its heading and its chips, not in a border down the side: six
           cards each wearing a colored edge reads as decoration, and the selected one then has no
           stronger state left to move to. Selection is what the border is for here. */
        .gr-area {
          text-align: left;
          padding: 12px 14px;
          border: 1px solid var(--border, #26324a);
          border-radius: 10px;
          background: var(--surface, #141b2b);
          color: var(--text, #d7e2f4);
          cursor: pointer;
        }
        .gr-area:hover {
          border-color: var(--text-muted, #66799a);
        }
        .gr-area.is-active {
          border-color: var(--c);
          box-shadow: inset 0 0 0 1px var(--c);
        }
        .gr-area-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 8px;
        }
        .gr-area-name {
          color: var(--c);
          font-weight: 600;
          font-size: 14px;
        }
        .gr-area-count {
          font-variant-numeric: tabular-nums;
          font-size: 13px;
          color: var(--text-muted, #9fb0cc);
        }
        .gr-area-gloss {
          color: var(--text-muted, #9fb0cc);
          font-size: 12px;
          font-style: italic;
          margin: 2px 0 6px;
        }
        .gr-area-tech {
          color: var(--text-muted, #66799a);
          font-size: 11.5px;
          line-height: 1.55;
        }
        .gr-listhead {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 10px;
          color: var(--text-muted, #9fb0cc);
          font-size: 12.5px;
        }
        .gr-listhead-right {
          display: inline-flex;
          gap: 6px;
        }
        .gr-copy {
          padding: 4px 10px;
          border: 1px solid var(--border, #26324a);
          border-radius: 999px;
          background: transparent;
          color: var(--text-muted, #9fb0cc);
          font-size: 11.5px;
          cursor: pointer;
          white-space: nowrap;
        }
        .gr-copy:hover {
          color: var(--accent, #4f8cff);
          border-color: var(--accent, #4f8cff);
        }
        .gr-papers {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .gr-paper {
          padding: 9px 12px;
          border: 1px solid var(--border, #26324a);
          border-radius: 8px;
          background: var(--surface, #141b2b);
        }
        .gr-paper.is-unconfirmed {
          border-style: dashed;
        }
        .gr-paper-head {
          display: flex;
          align-items: baseline;
          gap: 8px;
          flex-wrap: wrap;
        }
        .gr-paper-title {
          font-size: 13.5px;
        }
        .gr-paper-title a {
          color: inherit;
        }
        .gr-paper-meta {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          color: var(--text-muted, #9fb0cc);
          font-size: 11.5px;
          margin-top: 3px;
        }
        .gr-authors {
          color: var(--text-muted, #66799a);
        }
        .gr-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-top: 6px;
        }
        .gr-chip {
          padding: 1px 8px;
          border-radius: 999px;
          border: 1px solid var(--c, #26324a);
          color: var(--c, #9fb0cc);
          font-size: 10.5px;
          white-space: nowrap;
        }
        .gr-chip-sec {
          --c: #66799a;
          font-variant-numeric: tabular-nums;
        }
        .gr-chip-none,
        .gr-chip-quiet {
          --c: #66799a;
        }
        .gr-chip-warn {
          --c: #e0a458;
        }
        .gr-note {
          color: var(--text-muted, #66799a);
          font-size: 11px;
          margin-top: 5px;
        }
        .gr-sections {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .gr-section {
          border: 1px solid var(--border, #26324a);
          border-radius: 10px;
          background: var(--surface, #141b2b);
        }
        .gr-depth-3 {
          margin-left: 14px;
        }
        .gr-depth-4 {
          margin-left: 28px;
        }
        .gr-section-head {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 10px 13px;
          border: 0;
          background: transparent;
          color: var(--text, #d7e2f4);
          font-size: 13.5px;
          text-align: left;
          cursor: pointer;
        }
        .gr-caret {
          color: var(--text-muted, #66799a);
          font-size: 11px;
        }
        .gr-section-number {
          color: var(--accent, #4f8cff);
          font-size: 12px;
          white-space: nowrap;
        }
        .gr-section-title {
          flex: 1;
        }
        .gr-section-count {
          color: var(--text-muted, #66799a);
          font-size: 12px;
          font-variant-numeric: tabular-nums;
        }
        .gr-section-body {
          padding: 0 13px 13px 32px;
        }
        .gr-summary {
          color: var(--text-muted, #9fb0cc);
          font-size: 12.5px;
          margin: 0 0 8px;
          max-width: 80ch;
        }
        .gr-mix {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-bottom: 12px;
        }
        .gr-tr {
          border-left: 2px solid var(--accent, #4f8cff);
          padding-left: 12px;
          margin-bottom: 10px;
        }
        .gr-tr-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .gr-tr-head h4 {
          margin: 0;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--accent, #4f8cff);
        }
        .gr-tr-lede {
          font-size: 13px;
          margin: 8px 0;
          max-width: 82ch;
        }
        .gr-tr-list {
          margin: 0;
          padding-left: 18px;
          display: flex;
          flex-direction: column;
          gap: 7px;
        }
        .gr-tr-list li {
          font-size: 12.5px;
          line-height: 1.6;
          max-width: 84ch;
        }
        .gr-tr-list a {
          color: var(--accent, #4f8cff);
        }
        .gr-evidence summary {
          color: var(--text-muted, #66799a);
          font-size: 12px;
          cursor: pointer;
          margin-bottom: 8px;
        }
        .gr-stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 10px;
          margin-bottom: 20px;
        }
        .gr-stat {
          padding: 12px 14px;
          border: 1px solid var(--border, #26324a);
          border-radius: 10px;
          background: var(--surface, #141b2b);
        }
        .gr-stat-value {
          font-size: 24px;
          font-variant-numeric: tabular-nums;
        }
        .gr-stat-label {
          color: var(--text-muted, #9fb0cc);
          font-size: 11.5px;
          margin-top: 2px;
        }
        .gr-h4 {
          font-size: 13px;
          margin: 22px 0 8px;
        }
        .gr-bars {
          display: flex;
          flex-direction: column;
          gap: 5px;
          margin-bottom: 8px;
        }
        .gr-bar-row {
          display: grid;
          grid-template-columns: minmax(120px, 320px) 1fr 32px;
          align-items: center;
          gap: 10px;
          font-size: 12px;
        }
        .gr-bar-label {
          color: var(--text-muted, #9fb0cc);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .gr-bar-track {
          height: 8px;
          border-radius: 999px;
          background: var(--border, #26324a);
          overflow: hidden;
        }
        .gr-bar-fill {
          display: block;
          height: 100%;
          background: var(--accent, #4f8cff);
        }
        .gr-bar-value {
          text-align: right;
          font-variant-numeric: tabular-nums;
          color: var(--text-muted, #66799a);
        }
        @media (max-width: 640px) {
          .gr-depth-3,
          .gr-depth-4 {
            margin-left: 0;
          }
          .gr-section-body {
            padding-left: 13px;
          }
          .gr-bar-row {
            grid-template-columns: 1fr 60px;
          }
          .gr-bar-track {
            display: none;
          }
        }
      </style>
      <section class="grant-report-view">
        <p class="gr-prov">
          Papers are read live from the AdminBot store and unioned with the
          <code>${SOURCE.sheet.tab}</code> tab of
          <a href=${SOURCE.sheet.url} target="_blank" rel="noopener">${SOURCE.sheet.title}</a>
          as of ${SOURCE.compiledOn}, so a paper on the sheet but not yet in AdminBot still counts.
          Sections follow
          <a href=${SOURCE.proposal.url} target="_blank" rel="noopener">${SOURCE.proposal.title}</a
          >; areas follow
          <a href=${SOURCE.taxonomy.url} target="_blank" rel="noopener">${SOURCE.taxonomy.title}</a>
          (${SOURCE.taxonomy.attribution}). Where a paper sits is a human judgment; anything the
          rules guessed is labelled.
        </p>
        <div class="gr-panels" role="tablist">
          ${(Object.keys(PANEL_LABELS) as Panel[]).map((panel) => {
            const selected = this.panel === panel;
            return html`
              <button
                class=${`gr-panel-tab ${selected ? "is-active" : ""}`}
                role="tab"
                aria-selected=${selected ? "true" : "false"}
                @click=${() => this.select(panel)}
              >
                ${PANEL_LABELS[panel]}
              </button>
            `;
          })}
        </div>
        ${this.panel === "areas" ? this.renderAreas(papers) : nothing}
        ${this.panel === "track" ? this.renderTrack(papers) : nothing}
        ${this.panel === "coverage" ? this.renderCoverage(papers) : nothing}
      </section>
    `;
  }
}

if (!customElements.get("adminbot-grant-report-view")) {
  customElements.define("adminbot-grant-report-view", AdminbotGrantReportView);
}

export function renderGrantReport(props: { papers: readonly AdminBotPaperRecord[] }) {
  return html`<adminbot-grant-report-view .records=${props.papers}></adminbot-grant-report-view>`;
}
