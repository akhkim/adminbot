// "AdminBot checked your paper" — the moment a venue decision lands.
//
// Everything this writes already had a home: `venue_decision`, `accepted_venue`,
// `presentation_type` and the attendee list are all fields the paper card can edit today. What it
// did not have was a moment. A decision is the one event in a paper's life that starts four other
// things at once -- camera ready, telling the coauthors, deciding whether anyone travels, and (on
// a reject) choosing the next venue -- and expecting somebody to notice a dropdown changed from
// "Not heard yet" is how all four get missed.
//
// It sits inline under the pre-registration banner rather than as a modal. A modal was the first
// attempt and it was wrong twice over: it covered the whole screen for something that is news
// rather than an interruption, and it stole the page before the author had seen which paper it
// was about. Inline, it reads as one more thing on the page asking for an answer -- which is what
// it is -- and the papers stay visible behind it.
//
// It follows PaperFlow's branch 4 exactly. Accepted: AC -> CM and CA. Rejected: the RJ -> OV
// reset edge, which the chart labels "revise, new venue, same record" -- so the reject path ends
// by pointing at the next venue rather than by closing the paper.

import { html, nothing } from "lit";
import type {
  AdminBotLabMember,
  AdminBotPaperRecord,
  AdminBotPaperSaveInput,
} from "./controllers/admin.ts";
import type { AdminBotPaperStep } from "../../../../extensions/adminbot/src/contracts/actions.js";
import { PRE_REGISTRATION_VENUES } from "./venue-targets.ts";
import {
  ADMINBOT_BCC,
  buildCoauthorEmail,
  coauthorEmails,
  hasPlaceholders,
  unreachableAuthors,
} from "./coauthor-email.ts";


/** Set once the author has seen the popup for this decision, so it never reopens. */
const SEEN_KEY = "decision_seen";

export const PRESENTATION_TYPES = [
  "main",
  "findings",
  "poster",
  "spotlight",
  "oral",
  "award",
] as const;

/** The venue's answer, if it has given one. Independent of whether the author has replied. */
export function decisionOf(paper: AdminBotPaperRecord): "accept" | "reject" | null {
  const decision = paper.venue_decision;
  return decision === "accept" || decision === "reject" ? decision : null;
}

/** Whether the author has already recorded an answer to this particular decision. */
export function isDecisionAnswered(paper: AdminBotPaperRecord): boolean {
  const decision = decisionOf(paper);
  if (!decision) {
    return false;
  }
  const seen = (paper.artifacts as Record<string, string | undefined> | undefined)?.[SEEN_KEY];
  return seen === seenStamp(paper, decision);
}

/**
 * Has this paper had a decision the author has not been shown?
 *
 * Keyed on the decision itself rather than a bare boolean: a paper that is rejected, revised and
 * resubmitted gets a second decision, and the author should be told about that one too.
 */
export function pendingDecision(paper: AdminBotPaperRecord): "accept" | "reject" | null {
  const decision = paper.venue_decision;
  if (decision !== "accept" && decision !== "reject") {
    return null;
  }
  const seen = (paper.artifacts as Record<string, string | undefined> | undefined)?.[SEEN_KEY];
  const stamp = `${decision}:${paper.accepted_venue ?? paper.artifacts?.conference ?? ""}`;
  return seen === stamp ? null : decision;
}

function seenStamp(paper: AdminBotPaperRecord, decision: string): string {
  return `${decision}:${paper.accepted_venue ?? paper.artifacts?.conference ?? ""}`;
}


export type DecisionBannerProps = {
  paper: AdminBotPaperRecord;
  /**
   * The venue's answer, or null when nothing has been recorded.
   *
   * A null decision still draws, as one compact line offering the two answers. The banner used to
   * appear only once a decision was already in the record, which meant the surface built to carry
   * the news could not be used to enter it -- on a fresh deployment every paper was undecided and
   * so the feature was invisible.
   */
  decision: "accept" | "reject" | null;
  /** Records the venue's answer, which is what turns the prompt into the full banner. */
  onDecide: (decision: "accept" | "reject") => void;
  /** What the author has picked so far. Held by the caller so a re-render does not lose it. */
  draft: { presentation: string; attending: "yes" | "no" | ""; nextVenue: string };
  onDraft: (patch: Partial<DecisionBannerProps["draft"]>) => void;
  /** Puts every choice back to unselected. The write still needs Update. */
  onReset: () => void;
  /** The roster, for resolving coauthor addresses. */
  members: AdminBotLabMember[];
  /** True when the signed-in member is the first full member on this paper's author list. */
  isEmailOwner: boolean;
  /** The email task panel, open or shut, and the body as edited. */
  email: { open: boolean; body: string } | null;
  onToggleEmail: () => void;
  onEmailBody: (body: string) => void;
  onResetEmail: () => void;
  onSavePaper: (input: AdminBotPaperSaveInput) => void;
  /** "unknown" is a real answer here: it is what a cleared attendance means, and what the nudge
   *  sweep looks for. */
  onSetAttendance: (attending: "yes" | "no" | "unknown") => void;
  onPreRegister: () => void;
  /** Shrunk to a single line. Still unanswered -- only Save records it for good. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /**
   * Already recorded, and nothing changed since.
   *
   * The banner stays on screen either way. Making it disappear on save read as the page eating
   * the answer -- the author pressed a button and the thing they were answering vanished, with
   * no confirmation that anything landed. So it stays, and the button says so.
   */
  saved: boolean;
  /** Answered once, then edited. The button says "Update" rather than "Save" so the difference
   *  between recording a first answer and correcting one is visible before pressing it. */
  dirty: boolean;
};

export function renderDecisionBanner(props: DecisionBannerProps) {
  const { paper, decision, draft } = props;
  const venue = paper.accepted_venue?.trim() || paper.artifacts?.conference?.trim() || "the venue";

  if (!decision) {
    return html`
      <section
        class="decision-banner decision-banner--pending decision-banner--collapsed"
        data-testid=${`decision-banner-${paper.id}`}
      >
        <span class="decision-banner__verdict-line">
          No decision recorded ·
          <span class="decision-banner__paper">${paper.title}</span>
        </span>
        <span class="decision-banner__ask">
          <button
            type="button"
            class="decision__choice"
            data-testid=${`decision-set-accept-${paper.id}`}
            @click=${() => props.onDecide("accept")}
          >
            Accepted
          </button>
          <button
            type="button"
            class="decision__choice"
            data-testid=${`decision-set-reject-${paper.id}`}
            @click=${() => props.onDecide("reject")}
          >
            Not accepted
          </button>
        </span>
      </section>
    `;
  }

  const acknowledge = () => {
    const input: AdminBotPaperSaveInput = {
      id: paper.id,
      title: paper.title,
      authors: paper.authors ?? [],
      currentStep: paper.current_step as AdminBotPaperStep,
      decisionSeen: seenStamp(paper, decision),
    };
    if (decision === "accept") {
      // Always sent, empty included: what is on screen is what gets written, so clearing a
      // choice and pressing Update removes it rather than silently keeping the old one.
      input.presentationType = draft.presentation;
    }
    props.onSavePaper(input);
    if (decision === "accept") {
      // An unanswered attendance is "unknown" rather than absent -- that is the state the nudge
      // sweep chases, and it is the honest reading of somebody who cleared their answer.
      props.onSetAttendance(draft.attending || "unknown");
    }
    if (decision === "reject" && draft.nextVenue) {
      props.onPreRegister();
    }
  };

  const hasAnswer = Boolean(draft.presentation || draft.attending || draft.nextVenue);

  const choice = (label: string, on: boolean, pick: () => void) => html`
    <button type="button" class="decision__choice ${on ? "is-on" : ""}" @click=${pick}>
      ${label}
    </button>
  `;

  if (props.collapsed) {
    return html`
      <section
        class="decision-banner decision-banner--${decision} decision-banner--collapsed"
        data-testid=${`decision-banner-${paper.id}`}
      >
        <span class="decision-banner__verdict-line">
          ${decision === "accept" ? html`Accepted to ${venue}` : html`Not accepted at ${venue}`} ·
          <span class="decision-banner__paper">${paper.title}</span>
        </span>
        <button
          type="button"
          class="btn btn--sm"
          data-testid=${`decision-expand-${paper.id}`}
          @click=${props.onToggleCollapsed}
        >
          Open
        </button>
      </section>
    `;
  }

  return html`
    <section
      class="decision-banner decision-banner--${decision}"
      data-testid=${`decision-banner-${paper.id}`}
    >
      <div class="decision-banner__head">
        <div>
          <div class="decision-banner__eyebrow">AdminBot checked your paper</div>
          <div class="decision-banner__verdict">
            ${decision === "accept"
              ? html`Accepted to ${venue} 🎉`
              : html`Not accepted at ${venue}`}
          </div>
          <div class="decision-banner__paper">${paper.title}</div>
        </div>
        <button
          type="button"
          class="btn btn--sm"
          data-testid=${`decision-collapse-${paper.id}`}
          @click=${props.onToggleCollapsed}
        >
          Not now
        </button>
      </div>

      ${decision === "accept"
        ? html`
            <div class="decision-banner__row">
              <span class="decision-banner__label">Track</span>
              ${PRESENTATION_TYPES.map((type) =>
                choice(
                  `${type[0]?.toUpperCase()}${type.slice(1)}`,
                  draft.presentation === type,
                  () => props.onDraft({ presentation: type }),
                ),
              )}
            </div>
            <div class="decision-banner__row">
              <span class="decision-banner__label">Going?</span>
              ${choice("Yes", draft.attending === "yes", () => props.onDraft({ attending: "yes" }))}
              ${choice("No", draft.attending === "no", () => props.onDraft({ attending: "no" }))}

            </div>
          `
        : html`
            <div class="decision-banner__row">
              <span class="decision-banner__label">Where next?</span>
              ${PRE_REGISTRATION_VENUES.map((option) =>
                choice(option.label, draft.nextVenue === option.venue_id, () =>
                  props.onDraft({ nextVenue: option.venue_id }),
                ),
              )}

            </div>
          `}

      <div class="decision-banner__row">
        <button
          type="button"
          class="btn ${props.saved ? "" : "primary"}"
          data-testid=${`decision-save-${paper.id}`}
          @click=${acknowledge}
        >
          ${props.saved
            ? "Saved ✓"
            : decision === "reject" && draft.nextVenue
              ? "Pre-register now"
              : props.dirty
                ? "Update"
                : "Save"}
        </button>
        ${hasAnswer
          ? html`<button
              type="button"
              class="btn btn--sm"
              data-testid=${`decision-reset-${paper.id}`}
              @click=${props.onReset}
            >
              Reset
            </button>`
          : nothing}
        ${props.saved
          ? html`<span class="decision-banner__note">Recorded.</span>`
          : nothing}
        ${props.isEmailOwner
          ? html`<button
              type="button"
              class="decision-todo__button ${props.email?.open ? "is-open" : ""}"
              data-testid=${`decision-email-toggle-${paper.id}`}
              @click=${props.onToggleEmail}
            >
              TODO · email the coauthors
            </button>`
          : nothing}
      </div>
      ${props.isEmailOwner && props.email?.open
        ? renderEmailTask({ ...props, decision }, venue)
        : nothing}
    </section>
  `;
}


/**
 * The one task this decision creates for a person rather than for the record.
 *
 * Shaped like the PaperFlow task boxes because it is one: a named thing, owned by one person,
 * with everything needed to finish it in the box. The draft is pre-written and the parts that
 * genuinely differ per paper are left in [BRACKETS], so what still needs a human is visible
 * without reading the whole thing.
 */
function renderEmailTask(
  props: DecisionBannerProps & { decision: "accept" | "reject" },
  venue: string,
) {
  const { paper, decision, members } = props;
  const recipients = coauthorEmails(paper, members);
  const missing = unreachableAuthors(paper, members);
  const body = props.email?.body ?? buildCoauthorEmail(paper, decision, venue, "").body;
  const draft = buildCoauthorEmail(paper, decision, venue, "");
  const copy = (value: string) => () => void navigator.clipboard?.writeText(value);

  return html`
    <section class="decision-todo" data-testid=${`decision-email-${paper.id}`}>
      <div class="decision-todo__head">
        <span class="decision-todo__tag">TODO</span>
        <strong>You are asked to send all the coauthors the email as a Jinesis full member.</strong>
      </div>

      <div class="decision-todo__row">
        <span class="decision-banner__label">To</span>
        <code class="decision-todo__addresses">${recipients.join(", ") || "no addresses on file"}</code>
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${recipients.length === 0}
          data-testid=${`decision-copy-recipients-${paper.id}`}
          @click=${copy(recipients.join(", "))}
        >
          Copy recipients
        </button>
      </div>

      <div class="decision-todo__row">
        <span class="decision-banner__label">Bcc</span>
        <code class="decision-todo__addresses">${ADMINBOT_BCC}</code>
        <span class="decision-banner__note">Always — this is how the lab keeps the record.</span>
        <button type="button" class="btn btn--sm" @click=${copy(ADMINBOT_BCC)}>Copy bcc</button>
      </div>

      ${missing.length > 0
        ? html`<p class="decision-todo__missing">
            No address on file for ${missing.join(", ")} — add them by hand.
          </p>`
        : nothing}

      <textarea
        class="decision-todo__body"
        rows="14"
        spellcheck="true"
        data-testid=${`decision-email-body-${paper.id}`}
        .value=${body}
        @input=${(event: Event) => props.onEmailBody((event.target as HTMLTextAreaElement).value)}
      ></textarea>

      <div class="decision-todo__row">
        <button
          type="button"
          class="btn primary"
          data-testid=${`decision-copy-body-${paper.id}`}
          @click=${copy(body)}
        >
          Copy email
        </button>
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${body === draft.body}
          @click=${props.onResetEmail}
        >
          Reset draft
        </button>
        ${hasPlaceholders(body)
          ? html`<span class="decision-todo__warn">
              Still has [BRACKETS] to fill in.
            </span>`
          : nothing}
      </div>
    </section>
  `;
}
