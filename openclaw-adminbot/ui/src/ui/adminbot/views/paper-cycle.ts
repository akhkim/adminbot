// The parts of a paper card that are lists rather than single fields: the social drafts and who
// has signed off on them, who is going to the conference, and who has been reimbursed.
//
// Kept apart from the slot checklist above it because they behave differently. A slot is one
// answer with one owner; each of these is a set of rows about several people, and the useful
// question is "who has not answered yet" rather than "is it filled in".
import { html, nothing } from "lit";
import { icons } from "../../icons.ts";
import type {
  PaperAttendee,
  PaperReimbursement,
  PaperSocialConsent,
  PaperSocialDraft,
} from "../auth/session.ts";

export type PaperCycleProps = {
  paperId: string;
  drafts: PaperSocialDraft[];
  consents: PaperSocialConsent[];
  attendees: PaperAttendee[];
  reimbursements: PaperReimbursement[];
  /** Whether the venue said yes and the acceptance details are all in. */
  conferenceOpen: boolean;
  missingAcceptanceDetails: string[];
  cycleClosed: boolean;
  /** The signed-in member, so their own consent row gets buttons and nobody else's does. */
  memberId: string | null;
  memberName: (memberId: string) => string;
  onSaveDraft: (platform: string, body: string) => void;
  onCirculateDraft: (draftId: string) => void;
  /** LinkedIn only: run the model draft with the panel's venue/context inputs and store the text. */
  onGenerateLinkedInDraft?: (venue: string, note: string) => void;
  onConsent: (draftId: string, decision: string, comment?: string) => void;
  onSetAttendee: (name: string, memberId: string | undefined, attending: string) => void;
  onSetReimbursement: (memberId: string, status: string) => void;
};

const PLATFORM_LABELS: Record<string, string> = { x: "X", linkedin: "LinkedIn" };

const REIMBURSEMENT_LABELS: Record<string, string> = {
  not_applicable: "Not applicable",
  pending: "Not filed yet",
  submitted: "Submitted",
  reimbursed: "Reimbursed",
};

const ATTENDING_LABELS: Record<string, string> = {
  yes: "Going",
  no: "Not going",
  unknown: "Not said yet",
};

/**
 * The live draft per platform.
 *
 * Superseded rows are kept by the service so "what did they actually approve" stays answerable,
 * but the card shows the current one -- the history is an audit question, not a daily one.
 */
function liveDraft(drafts: PaperSocialDraft[], platform: string): PaperSocialDraft | undefined {
  return drafts.find((draft) => draft.platform === platform && draft.status !== "superseded");
}

function renderConsentRow(props: PaperCycleProps, consent: PaperSocialConsent) {
  const mine = consent.member_id === props.memberId;
  return html`
    <li class="paper-cycle__consent" data-decision=${consent.decision}>
      <span class="paper-cycle__consent-name">${props.memberName(consent.member_id)}</span>
      <span class="paper-cycle__consent-state">
        ${consent.decision === "ok"
          ? "Approved"
          : consent.decision === "changes_requested"
            ? "Asked for changes"
            : "Waiting"}
      </span>
      ${consent.comment
        ? html`<span class="paper-cycle__consent-comment">${consent.comment}</span>`
        : nothing}
      ${mine && consent.decision === "pending"
        ? html`
            <span class="paper-cycle__consent-actions">
              <button
                type="button"
                class="btn btn--sm"
                data-testid=${`consent-ok-${consent.draft_id}`}
                @click=${() => props.onConsent(consent.draft_id, "ok")}
              >
                Looks good
              </button>
              <button
                type="button"
                class="btn btn--sm"
                data-testid=${`consent-changes-${consent.draft_id}`}
                @click=${(event: Event) => {
                  const comment = globalThis.prompt?.("What would you change?") ?? "";
                  if (comment.trim()) {
                    props.onConsent(consent.draft_id, "changes_requested", comment.trim());
                  }
                  (event.currentTarget as HTMLButtonElement).blur();
                }}
              >
                Ask for changes
              </button>
            </span>
          `
        : nothing}
    </li>
  `;
}

/**
 * One platform's draft, and who still owes a sign-off on it.
 *
 * The consent list is the point of storing drafts at all: a post that names a senior author has to
 * be shown to that author, and this is where "shown to" becomes a record rather than a memory.
 */
function renderDraft(props: PaperCycleProps, platform: string) {
  const draft = liveDraft(props.drafts, platform);
  const consents = draft ? props.consents.filter((consent) => consent.draft_id === draft.id) : [];
  const waiting = consents.filter((consent) => consent.decision === "pending").length;
  return html`
    <div class="paper-cycle__draft" data-testid=${`paper-draft-${props.paperId}-${platform}`}>
      <div class="paper-cycle__draft-head">
        <strong>${PLATFORM_LABELS[platform] ?? platform} post</strong>
        ${draft
          ? html`<span
              class="paper-slot__pill ${draft.status === "approved"
                ? "paper-slot__pill--done"
                : ""}"
            >
              ${draft.status === "approved"
                ? "Approved"
                : draft.status === "circulated"
                  ? `${waiting} still to answer`
                  : "Not circulated"}
            </span>`
          : html`<span class="paper-slot__pill">No draft</span>`}
      </div>
      ${platform === "linkedin"
        ? html`
            <!-- Absorbed from the old "Draft LinkedIn post" dialog: same two optional inputs, but
                 inline where the post actually lives, so generating and circulating are one row. -->
            <label class="paper-cycle__field">
              <span>Venue / session <em>(optional)</em></span>
              <input
                class="input"
                type="text"
                data-el="venue"
                placeholder="ICML 2026, poster Wed Jul 8 Hall A #3015"
              />
            </label>
            <label class="paper-cycle__field">
              <span>Extra context <em>(optional)</em></span>
              <input class="input" type="text" data-el="note" placeholder="anything the abstract does not say" />
            </label>
          `
        : nothing}
      <textarea
        class="input paper-cycle__draft-body"
        rows="3"
        placeholder=${`Draft the ${PLATFORM_LABELS[platform] ?? platform} post…`}
        .value=${draft?.body ?? ""}
        data-testid=${`paper-draft-body-${props.paperId}-${platform}`}
        @change=${(event: Event) => {
          const value = (event.target as HTMLTextAreaElement).value.trim();
          if (value && value !== draft?.body) {
            props.onSaveDraft(platform, value);
          }
        }}
      ></textarea>
      ${platform === "linkedin" && props.onGenerateLinkedInDraft
        ? html`
            <div class="paper-cycle__draft-actions">
              <button
                type="button"
                class="btn btn--sm primary"
                data-testid=${`paper-draft-generate-${props.paperId}-linkedin`}
                @click=${(event: Event) => {
                  const root = (event.currentTarget as HTMLElement).closest(".paper-cycle__draft");
                  const venue =
                    root?.querySelector<HTMLInputElement>('[data-el="venue"]')?.value.trim() ?? "";
                  const note =
                    root?.querySelector<HTMLInputElement>('[data-el="note"]')?.value.trim() ?? "";
                  props.onGenerateLinkedInDraft(venue, note);
                }}
              >
                Generate draft
              </button>
              ${draft?.status === "draft"
                ? html`
                    <button
                      type="button"
                      class="btn btn--sm paper-cycle__circulate"
                      data-testid=${`paper-draft-circulate-${props.paperId}-${platform}`}
                      @click=${() => props.onCirculateDraft(draft.id)}
                    >
                      Send to coauthors for sign-off
                    </button>
                  `
                : nothing}
            </div>
          `
        : nothing}
      ${platform !== "linkedin" && draft?.status === "draft"
        ? html`
            <button
              type="button"
              class="btn btn--sm paper-cycle__circulate"
              data-testid=${`paper-draft-circulate-${props.paperId}-${platform}`}
              @click=${() => props.onCirculateDraft(draft.id)}
            >
              Send to coauthors for sign-off
            </button>
          `
        : nothing}
      ${consents.length
        ? html`<ul class="paper-cycle__consents">
            ${consents.map((consent) => renderConsentRow(props, consent))}
          </ul>`
        : draft?.status === "circulated"
          ? html`<p class="paper-slot__note">
              No coauthors on the roster to ask, so this is approved as it stands.
            </p>`
          : nothing}
    </div>
  `;
}

function renderAttendees(props: PaperCycleProps) {
  return html`
    <details class="paper-cycle__group" open>
      <summary class="paper-slots__group-head">
        <h4 class="paper-slots__group-title">
          <span class="paper-slots__group-icon" aria-hidden="true">${icons.user}</span>
          Who is going
        </h4>
        <span class="paper-slots__group-chevron" aria-hidden="true">${icons.chevronDown}</span>
      </summary>
      ${props.attendees.length
        ? html`<ul class="paper-cycle__rows">
            ${props.attendees.map(
              (attendee) => html`
                <li class="paper-cycle__row">
                  <span>${attendee.name}</span>
                  <select
                    class="input"
                    data-testid=${`paper-attendee-${props.paperId}-${attendee.attendee_key}`}
                    @change=${(event: Event) =>
                      props.onSetAttendee(
                        attendee.name,
                        attendee.member_id,
                        (event.target as HTMLSelectElement).value,
                      )}
                  >
                    ${["yes", "no", "unknown"].map(
                      (state) => html`
                        <option value=${state} ?selected=${state === attendee.attending}>
                          ${ATTENDING_LABELS[state]}
                        </option>
                      `,
                    )}
                  </select>
                </li>
              `,
            )}
          </ul>`
        : html`<p class="paper-slot__note">Nobody added yet.</p>`}
      <form
        class="paper-cycle__add"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const form = event.currentTarget as HTMLFormElement;
          const name = String(new FormData(form).get("name") ?? "").trim();
          if (name) {
            props.onSetAttendee(name, undefined, "unknown");
            form.reset();
          }
        }}
      >
        <input
          class="input"
          name="name"
          placeholder="Add an author"
          data-testid=${`paper-attendee-add-${props.paperId}`}
        />
        <button type="submit" class="btn btn--sm">Add</button>
      </form>
    </details>
  `;
}

/**
 * Reimbursements, and the sentence that says whether the paper is finished.
 *
 * Only people recorded as going appear: a reimbursement row for somebody who stayed home is a
 * question with no answer, and it would hold the cycle open forever.
 */
function renderReimbursements(props: PaperCycleProps) {
  const going = props.attendees.filter(
    (attendee) => attendee.attending === "yes" && attendee.member_id,
  );
  if (going.length === 0) {
    return nothing;
  }
  const byMember = new Map(props.reimbursements.map((row) => [row.member_id, row]));
  return html`
    <details class="paper-cycle__group" open>
      <summary class="paper-slots__group-head">
        <h4 class="paper-slots__group-title">
          <span class="paper-slots__group-icon" aria-hidden="true">${icons.wrench}</span>
          Reimbursements
        </h4>
        <span class="paper-slots__group-chevron" aria-hidden="true">${icons.chevronDown}</span>
      </summary>
      <ul class="paper-cycle__rows">
        ${going.map((attendee) => {
          const memberId = attendee.member_id as string;
          const status = byMember.get(memberId)?.status ?? "pending";
          return html`
            <li class="paper-cycle__row">
              <span>${attendee.name}</span>
              <select
                class="input"
                data-testid=${`paper-reimbursement-${props.paperId}-${memberId}`}
                @change=${(event: Event) =>
                  props.onSetReimbursement(memberId, (event.target as HTMLSelectElement).value)}
              >
                ${Object.entries(REIMBURSEMENT_LABELS).map(
                  ([value, label]) => html`
                    <option value=${value} ?selected=${value === status}>${label}</option>
                  `,
                )}
              </select>
            </li>
          `;
        })}
      </ul>
      <p class="paper-slot__note">
        Everyone who travelled being square is what closes this paper — not somebody deciding it
        looks finished.
      </p>
    </details>
  `;
}

export function renderPaperCycle(props: PaperCycleProps) {
  return html`
    <div class="paper-cycle" data-testid=${`paper-cycle-${props.paperId}`}>
      <details class="paper-cycle__group" id=${`paper-social-drafts-${props.paperId}`} open>
        <summary class="paper-slots__group-head">
          <h4 class="paper-slots__group-title">
            <span class="paper-slots__group-icon" aria-hidden="true">${icons.globe}</span>
            Social drafts
          </h4>
          <span class="paper-slots__group-chevron" aria-hidden="true">${icons.chevronDown}</span>
        </summary>
        <p class="paper-slot__note">
          Stored so the coauthors named in a post can be shown it before it goes out.
        </p>
        ${["x", "linkedin"].map((platform) => renderDraft(props, platform))}
      </details>

      ${props.missingAcceptanceDetails.length
        ? html`<p class="paper-cycle__blocked">
            The venue accepted this — record the ${props.missingAcceptanceDetails.join(", ")} above
            and the conference section opens.
          </p>`
        : nothing}
      ${props.conferenceOpen ? renderAttendees(props) : nothing}
      ${props.conferenceOpen ? renderReimbursements(props) : nothing}
      ${props.cycleClosed
        ? html`<p class="paper-cycle__closed">
            ${icons.check} Everything on this paper is finished, expenses included.
          </p>`
        : nothing}
    </div>
  `;
}
