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
  firstFullMemberAuthor,
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


/**
 * What to call the venue on the banner.
 *
 * `accepted_venue` is the clean answer where it exists. Where it does not, the fallback is
 * `artifacts.conference`, which on real rows carries the spreadsheet's own phrasing -- "ARR
 * Acceptance; to be committed to EMNLP". Printing that verbatim produces "Accepted to ARR
 * Acceptance; to be committed to EMNLP", which reads as a bug even though every word is true.
 * ARR is a review pool rather than a venue: the conference at the end of the sentence is the one
 * the paper was accepted to, so that is the one the banner names.
 */
export function displayVenue(paper: AdminBotPaperRecord): string {
  const raw = paper.accepted_venue?.trim() || paper.artifacts?.conference?.trim();
  if (!raw) {
    return "the venue";
  }
  // Applied to both fields, not just the fallback. The deployed rows carry the whole sentence in
  // accepted_venue as well, which is how "Accepted to ARR Acceptance; to be committed to EMNLP"
  // survived the first pass at this.
  return /committed to\s+(.+)$/iu.exec(raw)?.[1]?.trim() || raw;
}


export type DecisionBannerProps = {
  paper: AdminBotPaperRecord;
  decision: "accept" | "reject";
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
  const venue = displayVenue(paper);

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
          : renderEmailOwnerNote(props)}
      </div>
      ${props.isEmailOwner && props.email?.open
        ? renderEmailTask(props, venue)
        : nothing}
    </section>
  `;
}


/**
 * What the other coauthors see where the sender sees a TODO.
 *
 * Silence was the old answer, and it was unreadable in both directions: somebody who should have
 * been asked could not tell whether the rule had picked them and failed to draw, or picked
 * somebody else on purpose. Naming the person makes a wrong pick visible the moment it happens
 * -- which is how the roster spelling that hid Terry stayed hidden for a week.
 */
function renderEmailOwnerNote(props: DecisionBannerProps) {
  const owner = firstFullMemberAuthor(props.paper, props.members);
  if (!owner) {
    // No full member on the author list at all: the duty has no owner, and saying so is the only
    // way anybody finds out. Usually it means a roster name is spelled differently here.
    return html`<span class="decision-todo__owner">
      No Jinesis member matched this author list, so nobody has been asked to email the coauthors.
    </span>`;
  }
  return html`<span class="decision-todo__owner">
    ${owner.name} is asked to email the coauthors.
  </span>`;
}

/**
 * The one task this decision creates for a person rather than for the record.
 *
 * Shaped like the PaperFlow task boxes because it is one: a named thing, owned by one person,
 * with everything needed to finish it in the box. The draft is pre-written and the parts that
 * genuinely differ per paper are left in [BRACKETS], so what still needs a human is visible
 * without reading the whole thing.
 */
function renderEmailTask(props: DecisionBannerProps, venue: string) {
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
