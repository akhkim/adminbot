// The Conference Papers tab: which accepted papers at a conference are worth this member's time.
//
// One question, asked with two controls. Everything else on screen is the answer, because the
// interesting part of this tool is the ranking and the ranking is invisible -- a member has no way
// to check it except by reading the papers it picked. So each row carries its own evidence: how
// strongly it matched relative to everything else in the conference, which of their own interests
// its keywords echo, and the abstract itself one click away.
//
// Relative match strength rather than the raw similarity, and a bar rather than a number. The
// underlying cosine is not comparable between two searches -- a short interest string scores lower
// against everything than a long one -- so a bare "0.42" would invite exactly the comparison it
// cannot support. "Strongest thing here for you" is what the number actually means.

import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../../format.ts";
import type { AdminBotVenuePaperHit, AdminBotVenuePapersState } from "../controllers/admin.ts";

export type ConferencePapersProps = {
  state: AdminBotVenuePapersState;
  onVenueChange: (venueId: string) => void;
  onInterestsChange: (interests: string) => void;
  onSearch: () => void;
  onToggleAbstract: (paperId: string) => void;
};

export function renderConferencePapers(props: ConferencePapersProps) {
  const { state } = props;
  const canSearch = Boolean(state.venueId) && state.interests.trim().length > 0;
  return html`
    <section class="adminbot-shell conference-papers" data-testid="adminbot-conference-papers">
      <div class="card adminbot-card adminbot-card--wide">
        <div class="card-title">Conference papers for you</div>
        <div class="card-sub">
          Ranks everything accepted at a conference against what you work on, and shows the closest
          matches. Nothing here is filtered by keyword — a paper can match because it is about the
          same thing in different words.
        </div>
        ${renderControls(props, canSearch)}
      </div>
      ${state.error
        ? html`<div
            class="card adminbot-card adminbot-card--wide adminbot-notice adminbot-notice--error"
            data-testid="conference-papers-error"
          >
            ${state.error}
          </div>`
        : nothing}
      ${renderResults(props)}
    </section>
  `;
}

function renderControls(props: ConferencePapersProps, canSearch: boolean) {
  const { state } = props;
  const chosen = state.sources.find((source) => source.venue_id === state.venueId);
  return html`
    <div class="adminbot-form conference-papers__controls">
      <label class="adminbot-form__field">
        <span>Conference</span>
        <select
          data-testid="conference-papers-venue"
          ?disabled=${state.loadingSources || state.sources.length === 0}
          @change=${(event: Event) =>
            props.onVenueChange((event.target as HTMLSelectElement).value)}
        >
          ${state.sources.map(
            (source) => html`
              <option value=${source.venue_id} ?selected=${source.venue_id === state.venueId}>
                ${source.label}
              </option>
            `,
          )}
        </select>
      </label>

      <label class="adminbot-form__field conference-papers__interests">
        <span>What you work on</span>
        <textarea
          rows="2"
          data-testid="conference-papers-interests"
          placeholder="AI safety, mechanistic interpretability, reasoning"
          .value=${state.interests}
          @input=${(event: Event) =>
            props.onInterestsChange((event.target as HTMLTextAreaElement).value)}
        ></textarea>
        <!-- Says where the text came from, so a member who never filled in their profile knows
             why the box started empty and where to change it for good. -->
        <small class="muted">
          ${state.interestsTouched
            ? "Edited for this search — your profile is unchanged."
            : "From your profile's research topics. Edit it here for a one-off search."}
        </small>
      </label>
    </div>

    <div class="conference-papers__actions">
      ${renderIndexNote(state, chosen)}
      <button
        class="btn primary"
        type="button"
        data-testid="conference-papers-search"
        ?disabled=${!canSearch || state.searching}
        @click=${props.onSearch}
      >
        ${state.searching ? "Searching…" : "Find papers"}
      </button>
    </div>
  `;
}

/**
 * What is actually being searched, in one line.
 *
 * A member has no other way to tell a conference with nothing for them from one whose index was
 * never built, and those need different reactions: one is an answer, the other is an admin task.
 */
function renderIndexNote(
  state: AdminBotVenuePapersState,
  chosen: AdminBotVenuePapersState["sources"][number] | undefined,
) {
  if (state.loadingSources) {
    return html`<span class="muted">Loading conferences…</span>`;
  }
  if (!state.sources.length) {
    return html`<span class="muted" data-testid="conference-papers-empty-sources"
      >No conferences have been added yet — an admin sets these up in Settings.</span
    >`;
  }
  if (!chosen) {
    return nothing;
  }
  if (!chosen.paper_count) {
    return html`<span class="muted" data-testid="conference-papers-unindexed"
      >Not indexed yet — an admin can build it from the Cron tab.</span
    >`;
  }
  return html`<span class="muted"
    >${chosen.paper_count.toLocaleString()} accepted
    papers${chosen.indexed_at
      ? html` · indexed ${formatRelativeTimestamp(Date.parse(chosen.indexed_at))}`
      : nothing}</span
  >`;
}

function renderResults(props: ConferencePapersProps) {
  const { result } = props.state;
  if (!result) {
    return nothing;
  }
  if (result.nothing_relevant) {
    return html`
      <div class="card adminbot-card adminbot-card--wide" data-testid="conference-papers-none">
        <div class="card-title">Nothing close at ${result.label}</div>
        <div class="card-sub">
          None of the ${result.searched.toLocaleString()} accepted papers is near what you
          described. That is an answer about this conference, not about your interests — try another
          one, or widen what you typed.
        </div>
      </div>
    `;
  }
  if (!result.results.length) {
    return nothing;
  }
  return html`
    <div class="card adminbot-card adminbot-card--wide">
      <div class="card-title">
        ${result.results.length} of ${result.searched.toLocaleString()} papers at ${result.label}
      </div>
      <div class="card-sub">Closest first. Match strength is relative to this conference.</div>
      <ol class="conference-papers__list" data-testid="conference-papers-results">
        ${result.results.map((hit) => renderHit(hit, props))}
      </ol>
    </div>
  `;
}

function renderHit(hit: AdminBotVenuePaperHit, props: ConferencePapersProps) {
  const open = props.state.expanded.includes(hit.paper.id);
  const percent = Math.round(hit.relevance * 100);
  return html`
    <li class="conference-papers__hit" data-testid=${`conference-paper-${hit.paper.id}`}>
      <div
        class="conference-papers__match"
        title=${`Match strength ${percent}% within this conference`}
      >
        <span class="conference-papers__match-bar" style=${`--match: ${percent}%`}></span>
        <span class="conference-papers__match-value">${percent}%</span>
      </div>
      <div class="conference-papers__body">
        <a
          class="conference-papers__title"
          href=${hit.paper.forum_url}
          target="_blank"
          rel="noreferrer noopener"
          >${hit.paper.title}</a
        >
        <div class="conference-papers__meta muted">
          ${hit.paper.venue}
          ${hit.paper.pdf_url
            ? html` ·
                <a href=${hit.paper.pdf_url} target="_blank" rel="noreferrer noopener">PDF</a>`
            : nothing}
        </div>
        ${hit.paper.keywords.length
          ? html`<div class="conference-papers__keywords">
              ${hit.paper.keywords.map(
                (keyword) => html`<span
                  class=${`chip conference-papers__keyword ${
                    hit.matched_keywords.includes(keyword)
                      ? "conference-papers__keyword--matched"
                      : ""
                  }`}
                  >${keyword}</span
                >`,
              )}
            </div>`
          : nothing}
        ${hit.paper.abstract
          ? html`
              <button
                class="conference-papers__abstract-toggle"
                type="button"
                aria-expanded=${String(open)}
                data-testid=${`conference-paper-abstract-${hit.paper.id}`}
                @click=${() => props.onToggleAbstract(hit.paper.id)}
              >
                ${open ? "Hide abstract" : "Abstract"}
              </button>
              ${open
                ? html`<p class="conference-papers__abstract">${hit.paper.abstract}</p>`
                : nothing}
            `
          : nothing}
      </div>
    </li>
  `;
}
