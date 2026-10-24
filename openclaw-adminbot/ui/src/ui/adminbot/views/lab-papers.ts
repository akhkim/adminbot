// The Jinesis half of Find Interesting Papers: our own papers, ranked against a topic or a whole
// proposal.
//
// The sibling panel to conference-papers.ts and deliberately a different shape, because it answers
// a different question. That one asks "what should I read", over a published programme where every
// paper arrives with an abstract and its authors' keywords. This asks "what have we already done
// about this", over ~100 records that mostly carry a title and nothing else -- so the two things
// worth showing on a row are which part of the query it answers and how much text that judgement
// was made from. See workflows/papers/lab-relevance.ts.
//
// Strength is relative to the best match in this search, not absolute. The underlying number is a
// cosine margin in the 0.04-0.32 range; printing it would invite a precision the measurement does
// not have, and comparing two searches by it is exactly the mistake it cannot support.

import { html, nothing } from "lit";
import type { AdminBotLabPaperHit, AdminBotLabPapersState } from "../controllers/admin.ts";

export type LabPapersProps = {
  state: AdminBotLabPapersState;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  onToggleSections: (paperId: string) => void;
};

/** What each band means in words, since the band is the honest part of the answer. */
const BAND_LABELS: Record<string, string> = {
  core: "Core",
  related: "Related",
  peripheral: "Peripheral",
  off_topic: "Off topic",
};

/**
 * How thin the record behind a placement was.
 *
 * On screen rather than in a tooltip because it is the single most important caveat here: most
 * paper records carry a title and nothing else, and a confident-looking band read off eight words
 * is not the same claim as one read off an abstract.
 */
const EVIDENCE_NOTES: Record<string, string> = {
  rich: "",
  thin: "from title and notes",
  title_only: "from the title alone",
};

export function renderLabPapers(props: LabPapersProps) {
  const { state } = props;
  const canSearch = state.query.trim().length > 0;
  return html`
    <div class="card adminbot-card adminbot-card--wide">
      <div class="card-title">What have we already done about this?</div>
      <div class="card-sub">
        Ranks the lab's own papers against a topic, a list of them, or a whole research proposal
        pasted in. A proposal is split on its own headings, so each paper is placed against the
        section it actually answers — and the sections nothing covers are listed too.
      </div>
      <div class="adminbot-form">
        <label class="adminbot-form__field conference-papers__interests">
          <span>Topic, keywords, or a whole proposal</span>
          <textarea
            rows="4"
            data-testid="lab-papers-query"
            placeholder="causality — or paste a proposal, headings and all"
            .value=${state.query}
            @input=${(event: Event) =>
              props.onQueryChange((event.target as HTMLTextAreaElement).value)}
          ></textarea>
        </label>
      </div>
      <div class="conference-papers__actions">
        <span class="muted">
          Suggestions, not placements anyone has confirmed — check a row before citing it.
        </span>
        <button
          class="btn primary"
          type="button"
          data-testid="lab-papers-search"
          ?disabled=${!canSearch || state.searching}
          @click=${props.onSearch}
        >
          ${state.searching ? "Ranking…" : "Rank our papers"}
        </button>
      </div>
    </div>
    ${state.error
      ? html`<div
          class="card adminbot-card adminbot-card--wide adminbot-notice adminbot-notice--error"
          data-testid="lab-papers-error"
        >
          ${state.error}
        </div>`
      : nothing}
    ${renderReport(props)}
  `;
}

function renderReport(props: LabPapersProps) {
  const { result } = props.state;
  if (!result) {
    return nothing;
  }
  if (result.nothing_relevant) {
    return html`
      <div class="card adminbot-card adminbot-card--wide" data-testid="lab-papers-none">
        <div class="card-title">Nothing of ours is about this</div>
        <div class="card-sub">
          None of the ${result.scored.toLocaleString()} papers on record came close. That is a real
          answer about the lab rather than a failed search — it is a gap, if you expected one.
        </div>
      </div>
    `;
  }
  // The strongest margin in this search is the yardstick. Nothing is comparable across searches.
  const best = result.matches[0]?.margin ?? 1;
  return html`
    <div class="card adminbot-card adminbot-card--wide">
      <div class="card-title">
        ${result.matches.length} of ${result.scored.toLocaleString()} papers
      </div>
      <div class="card-sub">
        Closest first.
        ${result.query_kind === "proposal"
          ? `Placed against ${result.segment_count} sections of what you pasted.`
          : "Ranked against what you typed."}
      </div>
      <ol class="conference-papers__list" data-testid="lab-papers-results">
        ${result.matches.map((hit) => renderHit(hit, best, props))}
      </ol>
    </div>
    ${renderGaps(result.uncovered_segments, result.query_kind)}
  `;
}

/**
 * The sections nothing covers.
 *
 * The half of this that is hard to get any other way. "What have we published" can be answered by
 * reading the list; "which parts of this proposal have no track record behind them" cannot, and it
 * is the question that decides what still has to be written before an application goes out.
 */
function renderGaps(segments: Array<{ id: string; label: string }>, kind: "keywords" | "proposal") {
  if (kind !== "proposal" || !segments.length) {
    return nothing;
  }
  return html`
    <div class="card adminbot-card adminbot-card--wide" data-testid="lab-papers-gaps">
      <div class="card-title">${segments.length} sections nothing covers</div>
      <div class="card-sub">
        No paper on record is more than peripherally about these. Worth answering before this goes
        out.
      </div>
      <ul class="lab-papers__gaps">
        ${segments.map((segment) => html`<li>${segment.label}</li>`)}
      </ul>
    </div>
  `;
}

function renderHit(hit: AdminBotLabPaperHit, best: number, props: LabPapersProps) {
  const open = props.state.expanded.includes(hit.paper_id);
  // Relative to the best match here, floored so the weakest row still renders a visible sliver.
  const percent = Math.max(4, Math.round((hit.margin / (best || 1)) * 100));
  const evidence = EVIDENCE_NOTES[hit.evidence] ?? "";
  return html`
    <li class="conference-papers__hit" data-testid=${`lab-paper-${hit.paper_id}`}>
      <div class="conference-papers__match" title="Match strength relative to the best match here">
        <span class="conference-papers__match-bar" style=${`--match: ${percent}%`}></span>
        <span class="conference-papers__match-value">${BAND_LABELS[hit.band] ?? hit.band}</span>
      </div>
      <div class="conference-papers__body">
        <div class="conference-papers__title">${hit.title}</div>
        <div class="conference-papers__meta muted">
          ${hit.best_segment ? html`Answers <strong>${hit.best_segment.label}</strong>` : nothing}
          ${evidence ? html` · ${evidence}` : nothing}
        </div>
        ${hit.matched_terms.length
          ? html`<div class="conference-papers__keywords">
              ${hit.matched_terms.map(
                (term) =>
                  html`<span
                    class="chip conference-papers__keyword conference-papers__keyword--matched"
                    >${term}</span
                  >`,
              )}
            </div>`
          : nothing}
        ${hit.segments.length > 1
          ? html`
              <button
                class="conference-papers__abstract-toggle"
                type="button"
                aria-expanded=${String(open)}
                data-testid=${`lab-paper-sections-${hit.paper_id}`}
                @click=${() => props.onToggleSections(hit.paper_id)}
              >
                ${open ? "Hide sections" : `All ${hit.segments.length} sections`}
              </button>
              ${open
                ? html`<ul class="lab-papers__sections">
                    ${hit.segments.map(
                      (segment) =>
                        html`<li>
                          ${segment.label}
                          <span class="muted">${BAND_LABELS[segment.band] ?? segment.band}</span>
                        </li>`,
                    )}
                  </ul>`
                : nothing}
            `
          : nothing}
      </div>
    </li>
  `;
}
