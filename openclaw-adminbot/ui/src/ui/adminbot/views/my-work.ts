// The signed-in member's own work: one card per project or paper, and inside each card the whole
// list of what that paper still owes.
//
// Shaped like the profile page on purpose. A member's own record is a list of typed fields with a
// required mark, a hint about the shape each accepts, and autosave; the evidence a paper collects
// is the same kind of list, so it is rendered the same way rather than as a second vocabulary for
// the same idea. Closed, a card is a title and a progress line. Open, it is the form.
//
// The global nudge at the top is the same button Profile Overview carries, pointed at papers: it
// composes nothing and picks nobody. The service walks every live paper, finds the artifacts whose
// upstream evidence is already in, and messages whoever the slot registry says owes each one --
// the first author for nearly all of them. Admin-only, because it messages the whole lab.
//
// Projects and papers are the same thing here because they are the same record in AdminBot: a
// paper row moves through the PaperPublish steps from brainstorming to poster. Advancing one from
// this page writes `current_step` through the same endpoint the Active Papers page uses, so the
// two pages can never disagree about where something is -- they share both the step vocabulary
// (`stepLabels` / `paperSteps`) and the write path.
//
// Blockers are real records now, not browser state: they are written onto the paper the same way
// the step is, so an admin sees a report the moment it is filed. See blockers.ts.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { icons } from "../../icons.ts";
import type { PaperCycle, PaperNudgeBatch, PaperSlotOverviewRow } from "../auth/session.ts";
import {
  BLOCKER_TITLE_MAX,
  editBlockerInput,
  fileBlockerInput,
  openEntries,
  resolveBlockerInput,
} from "../blockers.ts";
import type {
  AdminBotPaperRecord,
  AdminBotPaperSaveInput,
  AdminBotPaperStep,
} from "../controllers/admin.ts";
import { DEADLINE_VENUES } from "../data/deadlines.ts";
import { isDormant, nextStepFor, nextTasksFor } from "../next-step.ts";
import { openPaperFlowMap } from "../paperflow-map.ts";
import { openLinkedInDraftDialog } from "../linkedin-draft-dialog.ts";
import { openPreRegistrationDialog } from "../pre-registration.ts";
import {
  formatVenueTargets,
  nextDeadlineVenue,
  papersNeedingRegistration,
  readVenueTargets,
} from "../venue-targets.ts";
import { isSamePerson } from "../../../../../extensions/adminbot/src/contracts/person-names.js";
import {
  diffForHistory,
  emptyPaperGridState,
  PAPER_GRID_THRESHOLD,
  recordHistory,
  renderPaperGrid,
  type PaperGridState,
} from "../paper-grid.ts";
import { paperSteps, stepLabels } from "./admin.ts";
import { renderPaperCycle } from "./paper-cycle.ts";
import { renderPaperSlots } from "./paper-slots.ts";
import { findOwnMember } from "./profile.ts";

export type MyWorkProps = {
  onSavePaper: (paper: AdminBotPaperSaveInput) => void;
  /** Asks the host to re-render. The grid edits in place, so it needs to drive its own repaint. */
  onRerender?: () => void;
  /** What each paper still owes, computed by the service -- see the note on `renderCardSummary`. */
  overview: PaperSlotOverviewRow[];
  /** The whole cycle by paper id, loaded the first time a card is opened. */
  slots: Record<string, PaperCycle>;
  openIds: string[];
  slotsBusyId: string | null;
  slotsError: string | null;
  slotsNotice: string | null;
  nudging: boolean;
  /** Hides the global nudge for a member. The service re-checks; this is the affordance, not the gate. */
  canNudge: boolean;
  /** The preview, or null when it is closed. Opening it sends nothing. */
  nudgeBatches: PaperNudgeBatch[] | null;
  nudgeLoading: boolean;
  nudgeSelected: string[];
  onReviewNudges: () => void;
  onToggleNudgeRecipient: (memberId: string) => void;
  onToggleCard: (paperId: string) => void;
  onSaveSlot: (
    paperId: string,
    slot: string,
    input: { url?: string; value_text?: string; value_note?: string; done?: boolean },
  ) => void;
  onNudgeAuthors: () => void;
  /** The signed-in member, so their own consent rows get buttons and nobody else's do. */
  memberId: string | null;
  memberName: (memberId: string) => string;
  onSaveDraft: (paperId: string, platform: string, body: string) => void;
  onCirculateDraft: (paperId: string, draftId: string) => void;
  onConsent: (paperId: string, draftId: string, decision: string, comment?: string) => void;
  onSetAttendee: (
    paperId: string,
    name: string,
    memberId: string | undefined,
    attending: string,
  ) => void;
  onSetReimbursement: (paperId: string, memberId: string, status: string) => void;
};

export type BlockerDraft = {
  paperId: string;
  /** The blocker being edited, keyed by filing time. Absent when filing a new one. */
  at?: string;
  text: string;
};

export type Blocker = {
  id: string;
  paperId: string;
  paperTitle: string;
  text: string;
  createdAt: number;
};

// Who reviews a blocker. The lab's head professor is a setting, so read it rather than naming a
// person in the source; fall back only when the setting has not loaded.
const FALLBACK_REVIEWER = "Zhijing";

export function reviewerName(state: AppViewState): string {
  const headId = state.adminBotData?.settings?.head_professor_member_id;
  if (!headId) {
    return FALLBACK_REVIEWER;
  }
  const head = (state.adminBotData?.members ?? []).find((member) => member.id === headId);
  return head?.name?.trim() || FALLBACK_REVIEWER;
}

// A paper is "mine" if I filed it, I mentor it, or my name is on it.
export function ownPapers(state: AppViewState): AdminBotPaperRecord[] {
  const member = findOwnMember(state);
  const memberId = state.memberId;
  const name = member?.name ?? "";
  return (state.adminBotData?.papers ?? []).filter(
    (paper) =>
      (memberId && paper.submitted_by_member_id === memberId) ||
      (memberId && paper.mentor_member_id === memberId) ||
      // Author entries carry marks that are about authorship, not identity -- "Joeun Yook*" for
      // equal contribution, "Yook, Joeun" from a BibTeX paste, an accent the roster spells
      // differently. This used to be a raw lowercase comparison, so a co-first author was
      // invisible on their own paper: the one character the venue added to mark the credit was
      // the character that hid it.
      (name.length > 0 &&
        (paper.authors ?? []).some((author) => isSamePerson(author, name))),
  );
}

// Progress is position in the PaperPublish pipeline, not a number someone types. A paper at
// "Submission" is 3 of 8 through, and that is the only progress the lab actually tracks.
export function paperProgress(paper: AdminBotPaperRecord): { index: number; percent: number } {
  const index = paperSteps.indexOf(paper.current_step as AdminBotPaperStep);
  if (index < 0) {
    return { index: -1, percent: 0 };
  }
  return { index, percent: Math.round(((index + 1) / paperSteps.length) * 100) };
}

export function stepLabel(step: string): string {
  return stepLabels[step] ?? step;
}

function saveStep(props: MyWorkProps, paper: AdminBotPaperRecord, step: AdminBotPaperStep) {
  props.onSavePaper({
    id: paper.id,
    title: paper.title,
    authors: paper.authors ?? [],
    currentStep: step,
  });
}

// Two ways to move a paper, because they answer different questions: "it moved on" (Next) and
// "it is actually at X" (the picker). Both write the same field.
function renderStepControls(paper: AdminBotPaperRecord, props: MyWorkProps) {
  const { index } = paperProgress(paper);
  const next = index >= 0 && index < paperSteps.length - 1 ? paperSteps[index + 1] : null;
  return html`
    <div class="my-work-item__controls">
      <button
        type="button"
        class="btn btn--sm"
        data-testid=${`my-work-map-${paper.id}`}
        @click=${() => openPaperFlowMap(paper)}
      >
        View PaperFlow
      </button>
      <button
        type="button"
        class="btn btn--sm"
        data-testid=${`my-work-linkedin-${paper.id}`}
        @click=${() => openLinkedInDraftDialog(paper)}
      >
        Draft LinkedIn post
      </button>
      ${next
        ? html`
            <button
              type="button"
              class="btn btn--sm"
              data-testid=${`my-work-advance-${paper.id}`}
              @click=${() => saveStep(props, paper, next)}
            >
              ${t("myWork.items.advance", { step: stepLabel(next) })}
            </button>
          `
        : nothing}
    </div>
  `;
}

/**
 * Report a blocker, as structured data rather than a chat message.
 *
 * The previous version wrote to browser state only, so "goes to Zhijing for review" was not true:
 * nothing left the reporter's tab. This writes onto the paper record, which every admin already
 * reads, so a report is visible the moment it is filed and survives a reload.
 *
 * The stage is a fixed list rather than free text because the whole point is that an admin can
 * sort by it. It reuses `paperSteps`, so the options a member picks from and the buckets an admin
 * sorts into cannot drift apart.
 *
 * One live blocker per paper: filing a second replaces the first, which is what "what is stuck
 * right now" means. Resolved ones are kept -- see blockers.ts for why.
 */

function renderBlockerForm(state: AppViewState, props: MyWorkProps, paper: AdminBotPaperRecord) {
  const draft = state.myWorkBlockerDraft;
  if (draft?.paperId !== paper.id) {
    return nothing;
  }
  const editing = draft.at ? openEntries(paper).find((entry) => entry.at === draft.at) : undefined;

  return html`
    <form
      class="blocker-form"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget as HTMLFormElement);
        const title = String(data.get("title") ?? "").trim();
        if (!title) {
          return;
        }
        const fields = {
          stage: String(data.get("stage") ?? ""),
          title,
          note: String(data.get("note") ?? "").trim(),
        };
        props.onSavePaper(
          editing
            ? editBlockerInput(paper, editing.at, fields)
            : // Named at filing time so the admin list can say who to go ask.
              fileBlockerInput(paper, { ...fields, by: findOwnMember(state)?.name ?? "" }),
        );
        state.myWorkBlockerDraft = null;
      }}
    >
      <p class="blocker-form__notice">
        <span class="blocker-form__notice-icon" aria-hidden="true">${icons.alertTriangle}</span>
        <span>
          This is a quick blocker report for PaperFlow — not a messaging system. Anything
          confidential, or anything that needs a back-and-forth, belongs in Slack.
        </span>
      </p>

      <div class="blocker-form__fields">
        <label class="register__field">
          <span class="register__label">Which stage is blocked?</span>
          <select class="input" name="stage" data-testid=${`blocker-stage-${paper.id}`}>
            ${paperSteps.map(
              (step) => html`
                <option value=${step} ?selected=${step === (editing?.stage || paper.current_step)}>
                  ${stepLabel(step)}
                </option>
              `,
            )}
          </select>
        </label>

        <label class="register__field">
          <span class="register__label">What is blocked? (short)</span>
          <input
            class="input"
            name="title"
            maxlength=${BLOCKER_TITLE_MAX}
            placeholder="e.g. OpenReview rejects the PDF"
            .value=${editing?.title ?? ""}
            data-testid=${`blocker-title-${paper.id}`}
          />
          <span class="register__hint">Up to ${BLOCKER_TITLE_MAX} characters.</span>
        </label>
      </div>

      <label class="register__field">
        <span class="register__label">Details</span>
        <textarea
          class="input"
          name="note"
          rows="4"
          placeholder=${t("myWork.blockers.placeholder")}
        >
${editing?.note ?? ""}</textarea
        >
      </label>

      <div class="blocker-form__footer">
        <p class="blocker-form__reviewer">
          ${t("myWork.blockers.reviewer", { name: reviewerName(state) })}
        </p>
        <div class="register__actions">
          <button type="submit" class="btn primary">
            ${editing ? "Save changes" : t("myWork.blockers.submit")}
          </button>
          <button
            type="button"
            class="btn"
            @click=${() => {
              state.myWorkBlockerDraft = null;
            }}
          >
            ${t("myWork.blockers.cancel")}
          </button>
        </div>
      </div>
    </form>
  `;
}

/**
 * The blockers already filed on one paper, each with its own controls.
 *
 * Per-row rather than one form for the paper, because a paper can be stuck on several things and
 * "edit the blocker" is meaningless once there are three of them.
 */
function renderPaperBlockers(state: AppViewState, props: MyWorkProps, paper: AdminBotPaperRecord) {
  const open = openEntries(paper);
  if (open.length === 0) {
    return nothing;
  }
  return html`
    <ul class="my-work-item__blockers">
      ${open.map(
        (entry) => html`
          <li class="my-work-item__blocker">
            <span class="my-work-item__blocker-icon" aria-hidden="true"
              >${icons.alertTriangle}</span
            >
            <span class="my-work-item__blocker-copy">
              <span class="my-work-item__blocker-title">${entry.title}</span>
              <span class="my-work-item__blocker-meta">${stepLabel(entry.stage)}</span>
            </span>
            <button
              type="button"
              class="btn btn--sm"
              data-testid=${`blocker-edit-${paper.id}-${entry.at}`}
              @click=${() => {
                state.myWorkBlockerDraft = { paperId: paper.id, at: entry.at, text: "" };
              }}
            >
              Edit
            </button>
            <button
              type="button"
              class="btn btn--sm"
              data-testid=${`blocker-resolve-${paper.id}-${entry.at}`}
              @click=${() => {
                props.onSavePaper(
                  resolveBlockerInput(paper, entry.at, findOwnMember(state)?.name ?? ""),
                );
              }}
            >
              Resolved
            </button>
          </li>
        `,
      )}
    </ul>
  `;
}

/**
 * How much evidence one paper has, straight from the service.
 *
 * Not computed here, and deliberately so: the same walk decides who the global nudge messages, so
 * a count derived in the browser could disagree with what pressing the button actually chases.
 */
function overviewFor(props: MyWorkProps, paperId: string): PaperSlotOverviewRow | undefined {
  return props.overview.find((row) => row.paper_id === paperId);
}

/**
 * The closed card: enough to decide whether to open it, and nothing else.
 *
 * A percentage alone was the old summary and it is not actionable -- "56%" tells nobody what to
 * go and do. This carries the count *and* the first thing outstanding, which is the sentence
 * somebody scanning five papers is actually looking for.
 */
function renderCardSummary(paper: AdminBotPaperRecord, props: MyWorkProps) {
  const row = overviewFor(props, paper.id);
  if (!row) {
    return nothing;
  }
  const percent = row.required_count
    ? Math.round((row.provided_count / row.required_count) * 100)
    : 0;
  const outstanding = row.missing_slots.length;
  // Spans throughout, not divs and paragraphs: this renders inside the disclosure button, and a
  // button may only contain phrasing content. The CSS gives them the layout back.
  return html`
    <span class="my-work-item__evidence">
      <span
        class=${`my-work-item__bar ${outstanding === 0 ? "is-complete" : ""}`}
        role="img"
        aria-label=${`${row.provided_count} of ${row.required_count} artifacts on file`}
      >
        <span class="my-work-item__fill" style="width: ${percent}%"></span>
      </span>
      <span class="my-work-item__evidence-count ab-num"
        >${row.provided_count}/${row.required_count}</span
      >
      ${row.dormant
        ? html`<span class="pill">Dormant</span>`
        : outstanding
          ? html`<span class="my-work-item__outstanding"
              >${outstanding} outstanding${row.escalating ? " · escalating" : ""}</span
            >`
          : html`<span class="my-work-item__outstanding is-complete">Everything is in</span>`}
    </span>
  `;
}

/** Venue and deadline as the card's subtitle -- the two facts that decide how urgent it is. */
function renderCardVenue(paper: AdminBotPaperRecord, props: MyWorkProps) {
  const row = overviewFor(props, paper.id);
  const venue = row?.venue ?? paper.venue ?? paper.artifacts?.conference;
  const deadline = row?.deadline ?? paper.deadline;
  if (!venue && !deadline) {
    return nothing;
  }
  return html`
    <span class="my-work-item__venue">
      ${venue ? html`<span>${venue}</span>` : nothing}
      ${deadline ? html`<span class="ab-num">${deadline.slice(0, 10)}</span>` : nothing}
    </span>
  `;
}

/**
 * What the venue said, and what it owes once it said yes.
 *
 * Four details rather than one flag, and all four asked rather than inferred: `is_archival` is the
 * one that decides whether this counts as a publication at all, and the same workshop can be
 * archival one year and not the next. Until they are in, the conference half of the card stays
 * shut -- "who is going" cannot be asked sensibly of a paper whose venue nobody has recorded.
 */
function renderAcceptance(paper: AdminBotPaperRecord, props: MyWorkProps) {
  const decision = paper.venue_decision ?? "pending";
  const save = (fields: Partial<AdminBotPaperSaveInput>) =>
    props.onSavePaper({
      id: paper.id,
      title: paper.title,
      authors: paper.authors ?? [],
      currentStep: paper.current_step as AdminBotPaperStep,
      ...fields,
    });
  return html`
    <div class="paper-acceptance" data-testid=${`paper-acceptance-${paper.id}`}>
      <label class="paper-acceptance__field">
        <span class="register__label">Venue decision</span>
        <select
          class="input"
          data-testid=${`paper-decision-${paper.id}`}
          @change=${(event: Event) =>
            save({ venueDecision: (event.target as HTMLSelectElement).value })}
        >
          ${["pending", "accept", "reject"].map(
            (value) => html`
              <option value=${value} ?selected=${value === decision}>
                ${value === "pending"
                  ? "Not heard yet"
                  : value === "accept"
                    ? "Accepted"
                    : "Rejected"}
              </option>
            `,
          )}
        </select>
      </label>
      ${decision === "accept"
        ? html`
            <label class="paper-acceptance__field">
              <span class="register__label">Accepted venue</span>
              <input
                class="input"
                .value=${paper.accepted_venue ?? ""}
                placeholder="e.g. ACL 2027"
                data-testid=${`paper-accepted-venue-${paper.id}`}
                @change=${(event: Event) =>
                  save({ acceptedVenue: (event.target as HTMLInputElement).value })}
              />
            </label>
            <label class="paper-acceptance__field">
              <span class="register__label">Year</span>
              <input
                class="input"
                type="number"
                min="2000"
                max="2100"
                .value=${paper.accepted_year ? String(paper.accepted_year) : ""}
                data-testid=${`paper-accepted-year-${paper.id}`}
                @change=${(event: Event) =>
                  save({ acceptedYear: (event.target as HTMLInputElement).value })}
              />
            </label>
            <label class="paper-acceptance__field">
              <span class="register__label">Archival?</span>
              <select
                class="input"
                data-testid=${`paper-archival-${paper.id}`}
                @change=${(event: Event) =>
                  save({ isArchival: (event.target as HTMLSelectElement).value })}
              >
                <option value="" ?selected=${paper.is_archival === undefined}>Not said</option>
                <option value="true" ?selected=${paper.is_archival === true}>
                  Archival — counts as a publication
                </option>
                <option value="false" ?selected=${paper.is_archival === false}>Non-archival</option>
              </select>
            </label>
            <label class="paper-acceptance__field">
              <span class="register__label">Presentation</span>
              <select
                class="input"
                data-testid=${`paper-presentation-${paper.id}`}
                @change=${(event: Event) =>
                  save({ presentationType: (event.target as HTMLSelectElement).value })}
              >
                <option value="" ?selected=${!paper.presentation_type}>Not said</option>
                ${["poster", "findings", "main", "spotlight", "oral", "award"].map(
                  (type) => html`
                    <option value=${type} ?selected=${type === paper.presentation_type}>
                      ${type[0]?.toUpperCase()}${type.slice(1)}
                    </option>
                  `,
                )}
              </select>
            </label>
          `
        : nothing}
    </div>
  `;
}

/** The lists that hang off a paper: drafts and their sign-offs, who travelled, who is square. */
function renderCycle(paper: AdminBotPaperRecord, props: MyWorkProps) {
  const cycle = props.slots[paper.id];
  if (!cycle) {
    return nothing;
  }
  return renderPaperCycle({
    paperId: paper.id,
    drafts: cycle.drafts,
    consents: cycle.consents,
    attendees: cycle.attendees,
    reimbursements: cycle.reimbursements,
    conferenceOpen:
      paper.venue_decision === "accept" && cycle.missingAcceptanceDetails.length === 0,
    missingAcceptanceDetails: cycle.missingAcceptanceDetails,
    cycleClosed: cycle.cycleClosed,
    memberId: props.memberId,
    memberName: props.memberName,
    onSaveDraft: (platform: string, body: string) => props.onSaveDraft(paper.id, platform, body),
    onCirculateDraft: (draftId: string) => props.onCirculateDraft(paper.id, draftId),
    onConsent: (draftId: string, decision: string, comment?: string) =>
      props.onConsent(paper.id, draftId, decision, comment),
    onSetAttendee: (name: string, memberId: string | undefined, attending: string) =>
      props.onSetAttendee(paper.id, name, memberId, attending),
    onSetReimbursement: (memberId: string, status: string) =>
      props.onSetReimbursement(paper.id, memberId, status),
  });
}

/**
 * One paper, as a card that opens.
 *
 * The whole head is the toggle rather than a chevron off to one side: the target is the thing
 * somebody is already pointing at, and a 23-field form behind a 16px hit area is a form nobody
 * finds. The blocker button sits outside it so reporting a blocker does not also expand the card.
 */
function renderItem(state: AppViewState, paper: AdminBotPaperRecord, props: MyWorkProps) {
  const { index } = paperProgress(paper);
  const blocked = openEntries(paper).length > 0;
  const open = props.openIds.includes(paper.id);
  const panelId = `my-work-body-${paper.id}`;
  return html`
    <article
      class=${`my-work-item ${blocked ? "my-work-item--blocked" : ""}`}
      ?data-open=${open}
      data-testid=${`my-work-item-${paper.id}`}
    >
      <div class="my-work-item__head">
        <button
          type="button"
          class="my-work-item__toggle"
          aria-expanded=${open ? "true" : "false"}
          aria-controls=${panelId}
          data-testid=${`my-work-toggle-${paper.id}`}
          @click=${() => props.onToggleCard(paper.id)}
        >
          <!-- One icon rotated by CSS, matching the Deadlines disclosure. Swapping the glyph in
               JS would animate nothing and put the open state in two places. -->
          <span class="my-work-item__chevron" aria-hidden="true">${icons.chevronRight}</span>
          <span class="my-work-item__copy">
            <span class="my-work-item__title">${paper.title}</span>
            <span class="my-work-item__meta">${(paper.authors ?? []).join(", ")}</span>
            ${renderCardVenue(paper, props)} ${renderCardSummary(paper, props)}
          </span>
        </button>
        <button
          type="button"
          class="btn btn--sm my-work-item__report"
          data-testid=${`my-work-report-${paper.id}`}
          @click=${() => {
            state.myWorkBlockerDraft = { paperId: paper.id, text: "" };
          }}
        >
          ${t("myWork.blockers.report")}
        </button>
      </div>
      ${renderPaperBlockers(state, props, paper)} ${renderBlockerForm(state, props, paper)}
      <!-- The panel element is always here so aria-controls always resolves; only its contents
           are conditional, because a closed card has not fetched its slots yet and 23 blank
           fields in the DOM would be a lie rather than a saving. -->
      <div class="my-work-item__body" id=${panelId} ?hidden=${!open}>
        ${open
          ? html`
              ${renderVenueTargets(paper)} ${renderTarget(paper, props)}
              ${renderStepper(paper, props, index)}
              ${renderNextStep(paper)} ${renderAcceptance(paper, props)}
              ${renderPaperSlots({
                paperId: paper.id,
                slots: props.slots[paper.id]?.slots ?? [],
                loading: props.slotsBusyId === paper.id,
                onSaveSlot: (slot, input) => props.onSaveSlot(paper.id, slot, input),
                showAllSlots: showAllSlots.has(paper.id),
                onToggleShowAll: () => {
                  if (showAllSlots.has(paper.id)) {
                    showAllSlots.delete(paper.id);
                  } else {
                    showAllSlots.add(paper.id);
                  }
                  props.onRerender?.();
                },
                // The LinkedIn gate opens the same dialog the card's button does, because that
                // is the only thing that can actually satisfy it.
                onOpenDraft: () => openLinkedInDraftDialog(paper),
              })}
              ${renderCycle(paper, props)} ${renderStepControls(paper, props)}
            `
          : nothing}
      </div>
    </article>
  `;
}

/**
 * The pipeline as a stepper, and the stepper as the control.
 *
 * This replaces a percentage bar plus a select. The bar said "56%", which is not a thing anyone
 * can act on, and the select listed all eight steps as equals, so jumping from Brainstorming docs
 * to Social posts was one click and asserted five things had happened that had not.
 *
 * Clicking a dot moves the paper there. Backwards is free -- correcting a mis-click, or a genuine
 * regression like a rejection, is normal. Skipping *forward* past unfinished steps asks first,
 * because that is the move that silently marks work done and makes every later nudge wrong.
 */
const STEPPER_SHORT_LABELS: Record<string, string> = {
  brainstorming_docs: "Brainstorm",
  overleaf_writing: "Overleaf",
  submission: "Submission",
  google_drive_pdf: "Drive PDF",
  arxiv_polish: "arXiv",
  social_posts: "Social",
  slide_making: "Slides",
  poster_making: "Poster",
};

/**
 * Target venue and confidence, editable in place.
 *
 * Asked once at registration, but a paper's target moves -- a missed deadline, a change of plan,
 * a rejection. Making it a pair of selects on the card means changing it is one click where the
 * information already is, instead of a form somewhere else.
 */
function renderTarget(paper: AdminBotPaperRecord, props: MyWorkProps) {
  const current = paper.artifacts?.conference ?? "";
  const confidence = paper.artifacts?.confidence ?? "";
  const venues = upcomingVenues();
  // Keep whatever the paper already names, even once its deadline has passed, or editing the
  // confidence would silently retarget the paper.
  const known = venues.some((venue) => venue.name === current);

  const save = (conference: string, odds: string) =>
    props.onSavePaper({
      id: paper.id,
      title: paper.title,
      authors: paper.authors ?? [],
      currentStep: paper.current_step as AdminBotPaperStep,
      conference,
      confidence: odds,
    });

  return html`
    <p class="my-work-item__target">
      <select
        class="target__select"
        data-testid=${`target-venue-${paper.id}`}
        @change=${(event: Event) => save((event.target as HTMLSelectElement).value, confidence)}
      >
        ${!known && current ? html`<option value=${current} selected>${current}</option>` : nothing}
        ${venues.map(
          (venue) => html`
            <option value=${venue.name} ?selected=${venue.name === current}>
              ${venue.name} · ${venue.deadline_aoe.slice(0, 10)}
            </option>
          `,
        )}
        <option value="" ?selected=${!current}>Other / not decided yet</option>
      </select>
      <select
        class="target__select"
        data-testid=${`target-confidence-${paper.id}`}
        @change=${(event: Event) => save(current, (event.target as HTMLSelectElement).value)}
      >
        <option value="" ?selected=${!confidence}>No estimate</option>
        ${CONFIDENCE_OPTIONS.map(
          (value) => html`
            <option value=${value} ?selected=${value === confidence}>${value}% likely</option>
          `,
        )}
      </select>
    </p>
  `;
}

/**
 * Where this paper is aimed, stated rather than implied.
 *
 * The venue and the odds used to live only in two small selects, which is the right control for
 * changing them and the wrong one for reading them: a deadline three weeks out rendered as grey
 * 11px text between two dropdowns. This says it once, in words, at the top of the card.
 */
function renderVenueTargets(paper: AdminBotPaperRecord) {
  const targets = readVenueTargets(paper);
  if (targets.length === 0) {
    return nothing;
  }
  return html`
    <p class="paper-targets" data-testid=${`paper-targets-${paper.id}`}>
      <span class="paper-targets__label">Pre-registered</span>
      <span class="paper-targets__value">${formatVenueTargets(targets)}</span>
    </p>
  `;
}

function renderStepper(paper: AdminBotPaperRecord, props: MyWorkProps, currentIndex: number) {
  const move = (step: AdminBotPaperStep, targetIndex: number) => {
    const skipped = targetIndex - currentIndex;
    if (skipped > 1) {
      const names = paperSteps
        .slice(currentIndex, targetIndex)
        .map((value) => stepLabel(value))
        .join(", ");
      if (
        !globalThis.confirm(
          `Jumping to ${stepLabel(step)} marks these as done: ${names}.\n\nContinue?`,
        )
      ) {
        return;
      }
    }
    saveStep(props, paper, step);
  };

  return html`
    <div class="stepper" role="group" aria-label=${`${paper.title} progress`}>
      <ol class="stepper__track">
        ${paperSteps.map((step, index) => {
          const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
          return html`
            <li class=${`stepper__step stepper__step--${state}`}>
              <button
                type="button"
                class="stepper__dot"
                data-testid=${`step-${paper.id}-${step}`}
                aria-current=${state === "current" ? "step" : "false"}
                title=${`Move to ${stepLabel(step)}`}
                @click=${() => move(step, index)}
              >
                <span class="sr-only">${stepLabel(step)}</span>
                ${state === "done" ? html`<span aria-hidden="true">✓</span>` : nothing}
              </button>
              <span class="stepper__label">${STEPPER_SHORT_LABELS[step] ?? stepLabel(step)}</span>
            </li>
          `;
        })}
      </ol>
    </div>
  `;
}

// What to do next on this paper, derived from the PaperFlow dependency graph rather than typed by
// hand. Read-only: it computes from `current_step` and writes nothing.
function renderNextStep(paper: AdminBotPaperRecord) {
  // A dormant paper shows why it is quiet. Suppressing the tasks *and* saying nothing would read
  // as a broken card rather than a deliberate rest.
  if (isDormant(paper)) {
    return html`<p class="my-work-item__next my-work-item__next--dormant">
      <span>Dormant — no reminders while this sits idle. Move a step to wake it up.</span>
    </p>`;
  }
  const next = nextStepFor(paper);
  if (!next) {
    return nothing;
  }
  if (next.done) {
    return html`<p class="my-work-item__next my-work-item__next--done">
      ${icons.check} <span>Everything on this paper is finished.</span>
    </p>`;
  }

  const tasks = nextTasksFor(paper);
  if (tasks.length === 0) {
    return nothing;
  }

  // The graph fans out, so the frontier is usually several tasks at once -- after the PDF
  // compiles, slides, social and archival are all open. Listing them as cards says "these can
  // happen in parallel", which a single "Next:" line actively hid.
  return html`
    <div class="tasks">
      <p class="tasks__title">
        What can be done now
        ${tasks.length > 1
          ? html`<span class="tasks__count">${tasks.length} in parallel</span>`
          : nothing}
      </p>
      <ul class="tasks__grid">
        ${tasks.map(
          (task) => html`
            <li
              class=${`task ${task.isApproval ? "task--approval" : ""} ${
                task.optional ? "task--optional" : ""
              }`}
            >
              <span class="task__branch">${task.branch || "Task"}</span>
              <strong class="task__label">${task.label}</strong>
              ${task.hint ? html`<span class="task__hint">${task.hint}</span>` : nothing}
              <span class="task__footer">
                <span class="task__who">
                  ${task.isApproval
                    ? `Approval from ${task.waitingOn}`
                    : `Owner: ${task.waitingOn}`}
                </span>
                <span class="task__unblocks">
                  ${task.optional
                    ? "Blocks nothing"
                    : task.unblocks.length
                      ? `Unblocks ${task.unblocks.slice(0, 2).join(", ")}`
                      : "Last step on this branch"}
                </span>
              </span>
            </li>
          `,
        )}
      </ul>
    </div>
  `;
}

// Adding writes a new paper row at the first step, with the member as its author -- the same
// record the Active Papers page lists, so it appears there too. The button lives in the section
// head; clicking it drops a simple inline form in below the list, no overlay.
function renderAddButton(state: AppViewState) {
  return html`
    <button
      type="button"
      class="btn my-work__add"
      data-testid="my-work-add-project"
      @click=${() => {
        state.myWorkProjectDraft = "";
        // The form renders below the list, out of view for anyone with more than a few papers.
        // Lit commits the re-render in a microtask, so the form exists by the next frame -- bring
        // it up and drop the cursor in the title box instead of leaving the user to hunt for it.
        window.requestAnimationFrame(() => {
          const reduceMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
          document.querySelector<HTMLElement>("#my-work-add-form")?.scrollIntoView({
            behavior: reduceMotion ? "auto" : "smooth",
            block: "start",
          });
          document
            .querySelector<HTMLInputElement>("#my-work-add-form input[name='title']")
            ?.focus();
        });
      }}
    >
      ${t("myWork.items.add")}
    </button>
  `;
}

/**
 * Venues worth offering when registering a paper: the next few real deadlines, soonest first.
 *
 * Read from the bundled deadline board rather than a hand-kept list, so the default is whatever
 * is actually next rather than whatever someone typed last year. Archival conference deadlines
 * only -- camera-ready and commitment rows are not things you target from scratch.
 */
function upcomingVenues(now = new Date()) {
  const future = DEADLINE_VENUES.filter((venue) => {
    const due = Date.parse(venue.deadline_aoe.replace(" ", "T") + "Z");
    return Number.isFinite(due) && due > now.getTime();
  })
    // Archival conferences only. Sorting purely by date buries ICLR and ARR under fifty workshop
    // commitment deadlines, so the default ends up a venue nobody was aiming for.
    .filter((venue) => venue.venue_type === "conference" && venue.archival)
    .sort((left, right) => left.deadline_aoe.localeCompare(right.deadline_aoe));

  // One row per venue, not one per milestone: ICLR appears twice (abstract, then full paper) and
  // offering both as separate targets asks a question nobody means to answer. Keep the paper
  // deadline, since that is the one people are working towards.
  const byGroup = new Map<string, (typeof future)[number]>();
  for (const venue of future) {
    const key = venue.venue_group || venue.name;
    const kept = byGroup.get(key);
    const isPaperDeadline = venue.milestone !== "abstract";
    if (!kept || (isPaperDeadline && kept.milestone === "abstract")) {
      byGroup.set(key, venue);
    }
  }
  return [...byGroup.values()].slice(0, 2);
}

/** How sure the authors are about hitting this venue. Coarse on purpose: finer is false precision. */
const CONFIDENCE_OPTIONS = ["30", "50", "80", "99"];

function renderAddForm(state: AppViewState, props: MyWorkProps) {
  const draft = state.myWorkProjectDraft ?? "";
  const member = findOwnMember(state);
  return html`
    <form
      id="my-work-add-form"
      class="my-work-add-form register"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const data = new FormData(form);
        const title = draft.trim();
        if (!title) {
          return;
        }
        props.onSavePaper({
          // Slugged from the title: the service upserts by id, and a member filing a paper has no
          // id to offer.
          id: title
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, "-")
            .replace(/(^-|-$)/gu, "")
            .slice(0, 60),
          title,
          authors: member?.name?.trim() ? [member.name.trim()] : [],
          currentStep: paperSteps[0],
          conference: String(data.get("venue") ?? ""),
          confidence: String(data.get("confidence") ?? ""),
        });
        state.myWorkProjectDraft = null;
      }}
    >
      <div class="my-work-add-form__head">
        <h3>${t("myWork.items.add")}</h3>
        <p>Starts at the first step and shows up on Active Papers too.</p>
      </div>

      <label class="register__field">
        <span class="register__label">Title</span>
        <input
          class="input"
          name="title"
          placeholder=${t("myWork.items.namePlaceholder")}
          .value=${draft}
          @input=${(event: Event) => {
            state.myWorkProjectDraft = (event.target as HTMLInputElement).value;
          }}
        />
      </label>

      <label class="register__field">
        <span class="register__label">Target venue</span>
        <select class="input" name="venue" data-testid="register-venue">
          ${upcomingVenues().map(
            (venue, index) => html`
              <option value=${venue.name} ?selected=${index === 0}>
                ${venue.name} · ${venue.deadline_aoe.slice(0, 10)}
              </option>
            `,
          )}
          <option value="">Other / not decided yet</option>
        </select>
        <span class="register__hint">Defaults to the next deadline. Change it any time.</span>
      </label>

      <fieldset class="register__field">
        <legend class="register__label">How likely is this venue?</legend>
        <div class="register__chips">
          ${CONFIDENCE_OPTIONS.map(
            (value, index) => html`
              <label class="chip">
                <input type="radio" name="confidence" value=${value} ?checked=${index === 1} />
                <span>${value}%</span>
              </label>
            `,
          )}
        </div>
        <span class="register__hint">A rough call, so everyone reads the plan the same way.</span>
      </fieldset>
      <div class="register__actions">
        <button type="submit" class="btn">${t("myWork.items.addSubmit")}</button>
        <button
          type="button"
          class="btn"
          @click=${() => {
            state.myWorkProjectDraft = null;
          }}
        >
          ${t("myWork.blockers.cancel")}
        </button>
      </div>
    </form>
  `;
}

// Derived from the papers themselves rather than from a separate list, so a member and an admin
// are always looking at the same records -- a blocker filed here is the one that shows up in
// Zhijing's sorted view, and clearing it there clears it here.
function renderBlockers(state: AppViewState) {
  const blockers = ownPapers(state).flatMap((paper) =>
    openEntries(paper).map((blocker) => ({ paper, blocker })),
  );
  if (!blockers.length) {
    return nothing;
  }
  return html`
    <section class="my-work__section" data-testid="my-work-blockers">
      <h2 class="my-work__section-title">${t("myWork.blockers.title")}</h2>
      <div class="my-work__blockers">
        ${blockers.map(
          ({ paper, blocker }) => html`
            <article class="my-work-blocker">
              <span class="my-work-blocker__icon" aria-hidden="true">${icons.alertTriangle}</span>
              <div class="my-work-blocker__copy">
                <p class="my-work-blocker__text">${blocker.title}</p>
                <p class="my-work-blocker__meta">
                  ${paper.title} · ${stepLabel(blocker.stage as AdminBotPaperStep)} ·
                  ${t("myWork.blockers.reviewer", { name: reviewerName(state) })}
                </p>
              </div>
              <span class="pill my-work-blocker__status">${t("myWork.blockers.pending")}</span>
            </article>
          `,
        )}
      </div>
    </section>
  `;
}

// Grid mode is per-session UI state, not part of the app model: it changes nothing about the
// papers and nobody needs it restored on reload. Kept module-level so a re-render mid-edit does
// not throw away half-typed cells.
let gridState: PaperGridState | null = null;

// Which cards have been expanded to their full checklist. Per session and per card: it is a
// viewing preference, not a fact about the paper.
const showAllSlots = new Set<string>();

function exitGrid(rerender: () => void): void {
  gridState = null;
  rerender();
}

/**
 * The global nudge.
 *
 * One button, no composer and no recipient picker -- the same shape Profile Overview uses, for the
 * same reason: the service derives both from state, so an admin pressing this is asking for the
 * standing rule to be applied now rather than writing a message. The count is papers with
 * something outstanding, which is what pressing it would actually chase.
 *
 * Disabled at zero rather than hidden: a button that vanishes when the lab is caught up gives no
 * way to tell "everything is in" apart from "this feature is gone".
 */
function renderNudgeButton(props: MyWorkProps) {
  if (!props.canNudge) {
    return nothing;
  }
  const outstanding = props.overview.filter(
    (row) => !row.dormant && !row.closed && row.missing_slots.length > 0,
  ).length;
  const open = props.nudgeBatches !== null;
  return html`
    <button
      type="button"
      class="btn btn--sm"
      data-testid="my-work-review-nudges"
      ?disabled=${props.nudgeLoading || outstanding === 0}
      aria-expanded=${open ? "true" : "false"}
      @click=${props.onReviewNudges}
    >
      <span aria-hidden="true">${icons.send}</span>
      ${props.nudgeLoading
        ? t("paperSlots.nudgeLoading")
        : open
          ? t("paperSlots.nudgeClose")
          : t("paperSlots.nudgeReview", { count: String(outstanding) })}
    </button>
  `;
}

/**
 * The batches, before anything goes out.
 *
 * This is the whole difference between a manual nudge and a scheduled one. A cron job can send a
 * message nobody read; a person pressing a button should be able to see the words that will
 * arrive under their name, and to leave somebody out of this round without waiving anything or
 * editing the paper. So the preview shows the composed message verbatim, one card per person, and
 * the send takes the ticks.
 *
 * Somebody with no Slack id on file is shown, unticked and unticking, rather than hidden: "we
 * cannot reach this person" is a fact worth seeing when you are asking why they never respond.
 */
function renderNudgePreview(props: MyWorkProps) {
  const batches = props.nudgeBatches;
  if (!batches) {
    return nothing;
  }
  if (batches.length === 0) {
    return html`<p class="nudge-preview__empty" data-testid="my-work-nudge-preview">
      ${t("paperSlots.nudgedNone")}
    </p>`;
  }
  const selected = batches.filter(
    (batch) => batch.deliverable && props.nudgeSelected.includes(batch.member_id),
  );
  return html`
    <section class="nudge-preview" data-testid="my-work-nudge-preview">
      <p class="nudge-preview__lede">
        ${t("paperSlots.nudgePreviewLede", { count: String(batches.length) })}
      </p>
      <ul class="nudge-preview__list">
        ${batches.map(
          (batch) => html`
            <li class="nudge-preview__item ${batch.deliverable ? "" : "is-unreachable"}">
              <label class="nudge-preview__head">
                <input
                  type="checkbox"
                  ?checked=${props.nudgeSelected.includes(batch.member_id)}
                  ?disabled=${!batch.deliverable}
                  data-testid=${`nudge-pick-${batch.member_id}`}
                  @change=${() => props.onToggleNudgeRecipient(batch.member_id)}
                />
                <span class="nudge-preview__name">${batch.member_name}</span>
                <span class="nudge-preview__count">
                  ${t("paperSlots.nudgeItems", {
                    items: String(batch.item_count),
                    papers: String(batch.paper_titles.length),
                  })}
                </span>
                ${batch.deliverable
                  ? nothing
                  : html`<span class="nudge-preview__unreachable"
                      >${t("paperSlots.nudgeUnreachable")}</span
                    >`}
              </label>
              <pre class="nudge-preview__message">${batch.message}</pre>
            </li>
          `,
        )}
      </ul>
      <div class="nudge-preview__actions">
        <button
          type="button"
          class="btn primary"
          data-testid="my-work-nudge-authors"
          ?disabled=${props.nudging || selected.length === 0}
          @click=${props.onNudgeAuthors}
        >
          ${props.nudging
            ? t("paperSlots.nudging")
            : t("paperSlots.nudgeSend", { count: String(selected.length) })}
        </button>
        <span class="nudge-preview__hint">${t("paperSlots.nudgeHint")}</span>
      </div>
    </section>
  `;
}


/**
 * The pre-registration banner.
 *
 * Deliberately the loudest thing on the page, and deliberately temporary: it appears only while a
 * deadline is close and only while this member still has a paper that has not been pointed at it.
 * Register everything and it disappears, which is the only honest way to make a banner people do
 * not learn to scroll past.
 *
 * The count is of the member's own unregistered papers rather than the lab's, because a number
 * about other people's work is not a prompt to do anything.
 */
function renderPreRegistrationBanner(papers: AdminBotPaperRecord[], props: MyWorkProps) {
  const next = nextDeadlineVenue();
  if (!next || papers.length === 0) {
    return nothing;
  }
  const outstanding = papersNeedingRegistration(papers, next.venue.venue_id);
  if (outstanding.length === 0) {
    return nothing;
  }
  const registered = papers.length - outstanding.length;
  return html`
    <section
      class="prereg-banner ${next.days <= 14 ? "prereg-banner--urgent" : ""}"
      data-testid="prereg-banner"
    >
      <div class="prereg-banner__text">
        <div class="prereg-banner__title">
          <span aria-hidden="true">🚨</span> Conference pre-registration —
          ${next.venue.label}
        </div>
        <div class="prereg-banner__sub">
          ${next.days} day${next.days === 1 ? "" : "s"} to the deadline ·
          ${outstanding.length} of your ${papers.length} paper${papers.length === 1 ? "" : "s"}
          not registered yet${registered > 0 ? ` · ${registered} done` : ""}
        </div>
      </div>
      <button
        type="button"
        class="btn primary prereg-banner__cta"
        data-testid="prereg-open"
        @click=${() =>
          openPreRegistrationDialog({
            papers,
            onSavePaper: props.onSavePaper,
            onDone: () => props.onRerender?.(),
          })}
      >
        Pre-register a paper
      </button>
    </section>
  `;
}

export function renderMyWork(state: AppViewState, props: MyWorkProps) {
  const items = ownPapers(state);
  // A grid for three papers is worse than three cards; the threshold is where the per-paper
  // surface stops paying for itself.
  const gridOffered = items.length > PAPER_GRID_THRESHOLD;
  const rerender = () => props.onRerender?.();

  if (gridOffered && gridState) {
    return html`
      <div class="my-work">
        ${renderPaperGrid({
          state: gridState,
          papers: items,
          onChange: rerender,
          onSaveAll: (inputs) => {
            if (!gridState) {
              return;
            }
            gridState.saving = true;
            gridState.notice = `Saving ${inputs.length} paper(s)…`;
            // Diffed before the write: afterwards the record holds the new value and the old
            // one is gone, so "changed X from A to B" would no longer be answerable.
            const entries = diffForHistory(gridState, items);
            gridState.history = recordHistory(entries);
            rerender();
            // One request per changed paper, because that is the endpoint that exists today.
            // The seam for PATCH /papers/bulk is exactly here.
            for (const input of inputs) {
              props.onSavePaper(input);
            }
            gridState.saving = false;
            gridState.edits = new Map();
            gridState.notice = `Sent ${inputs.length} paper(s) · ${entries.length} change(s) logged.`;
            rerender();
          },
          onExit: () => exitGrid(rerender),
        })}
      </div>
    `;
  }

  return html`
    <div class="my-work">
      ${renderPreRegistrationBanner(items, props)} ${renderBlockers(state)}
      <section class="my-work__section">
        <div class="my-work__section-head">
          <h2 class="my-work__section-title">${t("myWork.items.title")}</h2>
          <div class="my-work__section-actions">
            ${gridOffered
              ? html`<button
                  type="button"
                  class="btn btn--sm"
                  data-testid="my-work-open-grid"
                  @click=${() => {
                    gridState = emptyPaperGridState();
                    rerender();
                  }}
                >
                  Fill in as a spreadsheet (${items.length})
                </button>`
              : nothing}
            ${renderNudgeButton(props)} ${renderAddButton(state)}
          </div>
        </div>
        ${renderNudgePreview(props)}
        ${props.slotsNotice
          ? html`<p class="my-work__notice-line" role="status">${props.slotsNotice}</p>`
          : nothing}
        ${props.slotsError
          ? html`<p class="my-work__error-line" role="alert">${props.slotsError}</p>`
          : nothing}
        ${items.length
          ? html`<div class="my-work__items">
              ${items.map((paper) => renderItem(state, paper, props))}
            </div>`
          : html`<p class="my-work__empty">${t("myWork.items.empty")}</p>`}
        <p class="my-work__notice">${t("myWork.items.syncNotice")}</p>
        ${state.myWorkProjectDraft !== null ? renderAddForm(state, props) : nothing}
      </section>
    </div>
  `;
}
