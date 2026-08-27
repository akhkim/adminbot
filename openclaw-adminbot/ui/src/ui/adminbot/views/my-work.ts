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
import { ref } from "lit/directives/ref.js";
import { isSamePerson } from "../../../../../extensions/adminbot/src/contracts/person-names.js";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { icons } from "../../icons.ts";
import type { PaperCycle, PaperNudgeBatch, PaperSlotOverviewRow } from "../auth/session.ts";
import {
  draftLinkedInPost,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";
import {
  BLOCKER_TITLE_MAX,
  editBlockerInput,
  fileBlockerInput,
  openEntries,
  resolveBlockerInput,
} from "../blockers.ts";
import { buildCoauthorEmail, firstFullMemberAuthor } from "../coauthor-email.ts";
import type {
  AdminBotLabMember,
  AdminBotPaperRecord,
  AdminBotPaperSaveInput,
  AdminBotPaperStep,
} from "../controllers/admin.ts";
import { aoeInstantMs } from "../data/deadline-time.ts";
import { DEADLINE_VENUES } from "../data/deadlines.ts";
import {
  ARCHIVAL_VENUES,
  type CatalogVenue,
  NON_ARCHIVAL_VENUES,
  WORKSHOP_VENUES,
  formatVenue,
  parseVenue,
  venueYears,
} from "../data/venue-catalog.ts";
import { decisionOf, isDecisionAnswered, renderDecisionBanner } from "../decision-popup.ts";
import { isDormant, nextStepFor, nextTasksFor } from "../next-step.ts";
import {
  completedOnLabel,
  completionReadiness,
  isPaperCompleted,
  partitionByCompletion,
} from "../paper-completion.ts";
import {
  diffForHistory,
  emptyPaperGridState,
  PAPER_GRID_THRESHOLD,
  recordHistory,
  renderPaperGrid,
  type PaperGridState,
} from "../paper-grid.ts";
import { openPaperFlowMap } from "../paperflow-map.ts";
import { openPreRegistrationDialog } from "../pre-registration.ts";
import {
  formatVenueTargets,
  serializeVenueTargets,
  nextDeadlineVenue,
  papersNeedingRegistration,
  effectiveVenueTargets,
  readVenueTargets,
  venueTargetMatches,
} from "../venue-targets.ts";
import { paperSteps, stepLabels } from "./admin.ts";
import { renderPaperCycle } from "./paper-cycle.ts";
import { renderPaperSlots } from "./paper-slots.ts";
import { renderPaperTimeline } from "./paper-timeline.ts";
import { renderPaperWeeklyUpdates } from "./paper-weekly-updates.ts";
import { findOwnMember } from "./profile.ts";

export type MyWorkProps = {
  onSavePaper: (paper: AdminBotPaperSaveInput) => void;
  /**
   * Which papers this surface is about. Defaults to the signed-in member's own, which is what
   * My Projects & Papers means; Active Papers passes the whole lab. The cards, their fields and
   * every write are identical either way -- an admin editing any paper is the same gesture as an
   * author editing theirs, and the service decides what each is allowed to change.
   */
  papers?: AdminBotPaperRecord[];
  /** Section heading. Defaults to My Projects & Papers' own. */
  title?: string;
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
  /**
   * The member's own page, rather than the admin view over every paper in the lab.
   *
   * Active Papers reuses this renderer to get the same cards and the same writes, and that is
   * worth keeping -- but the banners above the list are addressed to one person. "All of your
   * papers are not registered" and a decision prompt on somebody else's paper are both wrong there,
   * and the second one invites an admin to answer a question that was asked of the author.
   */
  personal?: boolean;
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
  /** Writes the signed-in member's own line for this week. Absent leaves the log read-only. */
  onSaveWeeklyUpdate?: (paperId: string, body: string) => void;
  /**
   * Removes the paper outright. Absent hides the control entirely.
   *
   * Optional rather than always-on because the affordance should only appear where the viewer can
   * actually use it -- the service allows an admin any paper and a member only one they authored,
   * and a button that always 403s teaches people to distrust the page.
   */
  onDeletePaper?: (paper: AdminBotPaperRecord) => void;
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
/**
 * Every paper this member is on -- not just the ones they filed.
 *
 * A paper belongs to everyone who wrote it, so a project one coauthor registers has to appear on
 * all of their pages. `author_links` is the recorded answer to "who is this author", written when
 * somebody picked them, and it is checked first because it is the only line here that is not a
 * guess about a string the venue owns.
 */
export function ownPapers(state: AppViewState): AdminBotPaperRecord[] {
  const member = findOwnMember(state);
  const memberId = state.memberId;
  const name = member?.name ?? "";
  return (state.adminBotData?.papers ?? []).filter(
    (paper) =>
      (memberId && paper.submitted_by_member_id === memberId) ||
      (memberId && paper.first_author_member_id === memberId) ||
      (memberId && paper.mentor_member_id === memberId) ||
      (memberId && (paper.author_links ?? []).some((link) => link.member_id === memberId)) ||
      // Author entries carry marks that are about authorship, not identity -- "Joeun Yook*" for
      // equal contribution, "Yook, Joeun" from a BibTeX paste, an accent the roster spells
      // differently. This used to be a raw lowercase comparison, so a co-first author was
      // invisible on their own paper: the one character the venue added to mark the credit was
      // the character that hid it.
      (name.length > 0 && (paper.authors ?? []).some((author) => isSamePerson(author, name))),
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
//
// Takes `state` for the one reason the other row helpers do not need it: the draft dialog posts to
// /papers/linkedin-draft, so it needs the console's configured AdminBot URL. Called without it,
// resolveAdminBotBaseUrl falls back to this page's own hostname and a guessed port -- which is not
// where AdminBot lives when the console is served from anywhere but the service itself, so every
// draft died as "AdminBot is not reachable" before the request left the browser.
function renderStepControls(state: AppViewState, paper: AdminBotPaperRecord, props: MyWorkProps) {
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
      <!-- The pipeline pointer, demoted to what it actually is.
           The timeline above is read off the evidence and needs no pointer at all, but
           current_step still buckets blockers and drives the Active Papers view, and it has to
           be movable in both directions -- a mis-click, or a rejection that sends a paper back to
           writing. Jumping *forward* past unfinished steps still asks first, because that is the
           move that asserts work happened. -->
      <label class="my-work-item__step">
        <span class="sr-only">Pipeline step</span>
        <select
          class="target__select"
          data-testid=${`my-work-step-${paper.id}`}
          @change=${(event: Event) => {
            const target = (event.target as HTMLSelectElement).value as AdminBotPaperStep;
            const targetIndex = paperSteps.indexOf(target);
            if (targetIndex - index > 1) {
              const names = paperSteps
                .slice(index, targetIndex)
                .map((value) => stepLabel(value))
                .join(", ");
              if (
                !globalThis.confirm(
                  `Jumping to ${stepLabel(target)} marks these as done: ${names}.\n\nContinue?`,
                )
              ) {
                (event.target as HTMLSelectElement).value = paper.current_step;
                return;
              }
            }
            saveStep(props, paper, target);
          }}
        >
          ${paperSteps.map(
            (step) => html`
              <option value=${step} ?selected=${step === paper.current_step}>
                ${stepLabel(step)}
              </option>
            `,
          )}
        </select>
      </label>
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
        class=${`my-work-item__bar ${row.provided_count >= row.required_count ? "is-complete" : ""}`}
        role="img"
        aria-label=${`${row.provided_count} of ${row.required_count} artifacts on file`}
      >
        <span class="my-work-item__fill" style="width: ${percent}%"></span>
      </span>
      <span class="my-work-item__evidence-count ab-num"
        >${row.provided_count}/${row.required_count}</span
      >
      ${renderOutstanding(row, outstanding)}
    </span>
  `;
}

/**
 * The one phrase on the closed card that says how this paper stands.
 *
 * "Everything is in" is a claim about the artifacts and nothing else, so it is made from the
 * count and never from the length of `missing_slots`. Those are not the same statement: the
 * service returns nothing outstanding for a paper it is not chasing, and a rejected paper is not
 * chased -- which is how a paper with nothing on file but a rejection logged against it came to
 * announce that everything was in.
 *
 * The two quiet states say why they are quiet instead:
 *   - rejected: the next move is a venue, not an artifact, and no nudge will ask for one
 *   - nothing chaseable: work is outstanding but every open slot is behind something unsettled
 */
function renderOutstanding(row: PaperSlotOverviewRow, outstanding: number) {
  if (row.dormant) {
    return html`<span class="pill">Dormant</span>`;
  }
  if (row.closed) {
    return html`<span class="my-work-item__outstanding is-closed"
      >Rejected — pick a new venue to reopen it</span
    >`;
  }
  if (row.provided_count >= row.required_count) {
    return html`<span class="my-work-item__outstanding is-complete">Everything is in</span>`;
  }
  if (outstanding === 0) {
    return html`<span class="my-work-item__outstanding">Waiting on earlier steps</span>`;
  }
  return html`<span class="my-work-item__outstanding"
    >${outstanding} outstanding${row.escalating ? " · escalating" : ""}</span
  >`;
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
    <div
      class="paper-acceptance"
      data-decision=${decision}
      data-testid=${`paper-acceptance-${paper.id}`}
    >
      <label class="paper-acceptance__field">
        <span class="register__label">Venue decision</span>
        <select
          class="input"
          data-testid=${`paper-decision-${paper.id}`}
          @change=${(event: Event) => {
            const value = (event.target as HTMLSelectElement).value;
            (event.target as HTMLSelectElement)
              .closest(".paper-acceptance")
              ?.setAttribute("data-decision", value);
            save({ venueDecision: value });
          }}
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
      ${renderCompletion(paper, props)}
    </div>
  `;
}

/**
 * "This one is finished" -- the last thing anybody does to a paper.
 *
 * Sits at the end of the acceptance block because that is where its precondition is decided: the
 * venue decision is two controls above it, so the answer to "why is this greyed out" is on screen
 * at the same time as the question. See paper-completion.ts for why presenting is a claim a person
 * makes rather than something the service works out.
 */
function renderCompletion(paper: AdminBotPaperRecord, props: MyWorkProps) {
  const done = isPaperCompleted(paper);
  const { ready, reason } = completionReadiness(paper);
  const write = (completedAt: string) =>
    props.onSavePaper({
      id: paper.id,
      title: paper.title,
      authors: paper.authors ?? [],
      currentStep: paper.current_step as AdminBotPaperStep,
      completedAt,
    });
  return html`
    <div class="paper-completion" data-testid=${`paper-completion-${paper.id}`}>
      ${done
        ? html`
            <p class="paper-completion__done">
              Completed <span class="ab-num">${completedOnLabel(paper)}</span>
            </p>
            <button
              type="button"
              class="btn btn--sm"
              data-testid=${`paper-reopen-${paper.id}`}
              @click=${() => write("")}
            >
              Reopen
            </button>
          `
        : html`
            <button
              type="button"
              class="btn btn--sm"
              ?disabled=${!ready}
              data-testid=${`paper-complete-${paper.id}`}
              @click=${() => write(new Date().toISOString())}
            >
              Mark as presented and completed
            </button>
            ${reason ? html`<span class="paper-completion__why">${reason}</span>` : nothing}
          `}
    </div>
  `;
}

/**
 * The weekly log: what each author did on this paper, week by week.
 *
 * Only rendered once the card's cycle has been fetched, like the rest of the card -- an empty log
 * and an unloaded one look identical, and only one of them means nobody has written anything.
 */
function renderWeeklyUpdates(paper: AdminBotPaperRecord, props: MyWorkProps) {
  const cycle = props.slots[paper.id];
  if (!cycle) {
    return nothing;
  }
  const names: Record<string, string> = {};
  for (const update of cycle.weeklyUpdates) {
    names[update.member_id] = props.memberName(update.member_id);
  }
  return renderPaperWeeklyUpdates({
    paperId: paper.id,
    updates: cycle.weeklyUpdates,
    ...(props.memberId ? { memberId: props.memberId } : {}),
    memberNames: names,
    busy: props.slotsBusyId === paper.id,
    // No session, no box: the service takes the author from the session, so a reader without one
    // has nothing to write with.
    ...(props.onSaveWeeklyUpdate && props.memberId
      ? { onSave: (body: string) => props.onSaveWeeklyUpdate?.(paper.id, body) }
      : {}),
  });
}

/** The lists that hang off a paper: drafts and their sign-offs, who travelled, who is square. */
function renderCycle(state: AppViewState, paper: AdminBotPaperRecord, props: MyWorkProps) {
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
    // The old dialog's generate path, minus the PDF picker: the service reads the Drive copy the
    // card already chases. Result lands in the panel's textarea as a stored draft, so the usual
    // sign-off row takes over from there.
    onGenerateLinkedInDraft: async (venue: string, note: string) => {
      const stored = loadStoredMemberSession();
      if (!stored) {
        globalThis.alert?.("Sign in first — drafting runs against your own session.");
        return;
      }
      try {
        const result = await draftLinkedInPost(
          {
            paperId: paper.id,
            ...(paper.artifacts?.arxiv_url ? { url: paper.artifacts.arxiv_url } : {}),
            ...(venue ? { venue } : {}),
            ...(note ? { note } : {}),
          },
          stored.sessionToken ?? "",
          resolveAdminBotBaseUrl(state.settings),
        );
        if (!result.ok) {
          globalThis.alert?.(result.message ?? "Could not generate the draft.");
          return;
        }
        props.onSaveDraft(paper.id, "linkedin", result.value.text);
      } catch (error) {
        globalThis.alert?.((error as Error).message);
      }
    },
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
  const blocked = openEntries(paper).length > 0;
  const open = props.openIds.includes(paper.id);
  const done = isPaperCompleted(paper);
  const panelId = `my-work-body-${paper.id}`;
  return html`
    <article
      class=${`my-work-item ${blocked ? "my-work-item--blocked" : ""} ${
        done ? "my-work-item--done" : ""
      }`}
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
            <span class="my-work-item__title">
              ${paper.title}
              ${done
                ? html`<span
                    class="my-work-item__badge"
                    data-testid=${`my-work-done-badge-${paper.id}`}
                    >Completed</span
                  >`
                : nothing}
            </span>
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
              ${renderPaperTimeline({
                paperId: paper.id,
                slots: props.slots[paper.id]?.slots ?? [],
                paper,
              })}
              ${renderNextStep(paper)} ${renderAcceptance(paper, props)}
              ${renderPaperSlots({
                paperId: paper.id,
                slots: props.slots[paper.id]?.slots ?? [],
                stages: props.slots[paper.id]?.stages ?? [],
                details: {
                  authors: paper.authors ?? [],
                  // The picker renders when the roster is on hand; without it the card falls back
                  // to the old text box rather than showing an author list nobody can add to.
                  authorLinks: paper.author_links ?? [],
                  members: (state.adminBotData?.members ?? []).map((member) => ({
                    id: member.id,
                    name: member.name,
                    ...(member.email ? { hint: member.email } : {}),
                  })),
                  // Optional-chained: this view is rendered against partial state doubles in
                  // tests and against a host that may predate the field, and an author list that
                  // throws is worse than one whose draft box starts empty.
                  coauthorDraft: state.myWorkCoauthorDraft?.[paper.id] ?? { email: "", name: "" },
                  onCoauthorDraftChange: (draft) => {
                    const current = state.myWorkCoauthorDraft?.[paper.id] ?? {
                      email: "",
                      name: "",
                    };
                    state.myWorkCoauthorDraft = {
                      ...state.myWorkCoauthorDraft,
                      [paper.id]: { ...current, ...draft },
                    };
                    props.onRerender?.();
                  },
                  feedbackGivers: paper.feedback_givers ?? [],
                  venue: paper.venue ?? paper.artifacts?.conference ?? "",
                  authorRoles: paper.author_roles ?? "",
                  // Written through the same paper save every other control on this card uses, so
                  // the details and the step pointer cannot end up on different records.
                  onSaveDetails: (details) =>
                    props.onSavePaper({
                      id: paper.id,
                      title: paper.title,
                      authors: details.authors,
                      // The links are the author list now; `authors` rides along for a service
                      // old enough not to know about them, and is regenerated from the links.
                      ...(details.authorLinks ? { authorLinks: details.authorLinks } : {}),
                      feedbackGivers: details.feedbackGivers,
                      venue: details.venue,
                      authorRoles: details.authorRoles,
                      currentStep: paper.current_step,
                    }),
                },
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
                // Clicking "Write the draft" scrolls to the Social drafts section and opens it.
                onOpenDraft: (_platform) => {
                  const el = document.getElementById(`paper-social-drafts-${paper.id}`);
                  if (el instanceof HTMLDetailsElement) {
                    el.open = true;
                    el.scrollIntoView({ behavior: "smooth", block: "start" });
                  }
                },
              })}
              ${renderWeeklyUpdates(paper, props)} ${renderCycle(state, paper, props)}
              ${renderStepControls(state, paper, props)} ${renderDeletePaper(paper, props)}
            `
          : nothing}
      </div>
    </article>
  `;
}

/**
 * Removing a paper filed by mistake.
 *
 * Last thing in the card, behind a confirm naming the title. Deleting takes the evidence slots,
 * the social drafts, the weekly updates and the conference rows with it, and none of that comes
 * back -- so the one thing this control must not be is easy to hit while scrolling.
 *
 * A plain confirm() rather than a bespoke dialog: it is the one prompt a browser will not let a
 * page style into looking harmless, which is the right property here.
 */
function renderDeletePaper(paper: AdminBotPaperRecord, props: MyWorkProps) {
  if (!props.onDeletePaper) {
    return nothing;
  }
  return html`
    <p class="my-work-item__danger">
      <button
        class="btn btn--sm danger"
        type="button"
        data-testid=${`delete-paper-${paper.id}`}
        @click=${() => {
          if (globalThis.confirm?.(t("myWork.delete.confirm", { title: paper.title }))) {
            props.onDeletePaper?.(paper);
          }
        }}
      >
        ${t("myWork.delete.action")}
      </button>
      <span class="muted">${t("myWork.delete.hint")}</span>
    </p>
  `;
}

/**
 * Target venue and confidence, editable in place.
 *
 * Asked once at registration, but a paper's target moves -- a missed deadline, a change of plan,
 * a rejection. Making it selects on the card means changing it is one click where the information
 * already is, instead of a form somewhere else.
 *
 * Year and venue are separate because they change for different reasons: a slipped paper keeps its
 * venue and moves a year, and a rejected one keeps the year and moves venue. One combined list
 * would make either edit a hunt through every venue-year pair.
 */
function renderTarget(paper: AdminBotPaperRecord, props: MyWorkProps) {
  const current = paper.artifacts?.conference ?? "";
  const confidence = paper.artifacts?.confidence ?? "";
  const parsed = parseVenue(current);
  // Keep whatever the paper already names when the catalog cannot express it, or touching either
  // select would silently retarget the paper.
  const custom = current && !parsed.id ? current : "";
  const year = parsed.year ?? defaultTarget().year;

  /**
   * Save the target, and register the paper for it.
   *
   * Declaring where a paper is going *is* pre-registering it -- there is no second intention to
   * collect. Until now these two selects wrote only `artifacts.conference`, while every reader of
   * "is this paper pre-registered" looks at `artifacts.venue_targets`, so an author who set their
   * target here was still counted as not having pre-registered and still got asked to.
   *
   * The chosen venue is upserted rather than made the whole list: a paper aimed at two venues
   * through the pre-registration dialog must not lose one because somebody adjusted the year on
   * this card. Any existing target for the same venue is replaced, the rest are left alone, and
   * clearing the venue removes just its own entry.
   */
  const save = (conference: string, odds: string) => {
    const existing = readVenueTargets(paper);
    const parsedNext = parseVenue(conference);
    const venueId = parsedNext.id ?? conference.trim();
    // Drop any target this edit supersedes, matching on the venue rather than the id string so a
    // target written by the dialog's id space is replaced rather than duplicated.
    const kept = existing.filter((target) => !venueId || !venueTargetMatches(target, venueId));
    const confidenceValue = Number(odds);
    const targets = venueId
      ? [
          ...kept,
          {
            venue_id: venueId,
            label: conference.trim() || venueId,
            // The odds select can be empty ("No estimate"); a target still has to carry a number,
            // and the same 50 the Add a project form defaults to is the honest one.
            confidence:
              Number.isFinite(confidenceValue) && confidenceValue > 0 ? confidenceValue : 50,
          },
        ]
      : kept;
    props.onSavePaper({
      id: paper.id,
      title: paper.title,
      authors: paper.authors ?? [],
      currentStep: paper.current_step as AdminBotPaperStep,
      conference,
      confidence: odds,
      venueTargets: serializeVenueTargets(targets),
    });
  };

  // Both selects write the one `conference` field, so whichever one moved has to read the other.
  const retarget = (event: Event) => {
    const root = (event.target as HTMLElement).closest(".my-work-item__target");
    const pick = (role: string) =>
      root?.querySelector<HTMLSelectElement>(`[data-role="${role}"]`)?.value ?? "";
    const venueId = pick("venue-name");
    if (!venueId) {
      save("", confidence);
      return;
    }
    if (venueId === custom) {
      save(custom, confidence);
      return;
    }
    save(formatVenue(venueId, Number(pick("venue-year"))), confidence);
  };

  return html`
    <p class="my-work-item__target">
      <select
        class="target__select"
        data-role="venue-year"
        aria-label="Target year"
        data-testid=${`target-venue-year-${paper.id}`}
        @change=${retarget}
      >
        ${venueYears().map(
          (option) => html`
            <option value=${String(option)} ?selected=${option === year}>${option}</option>
          `,
        )}
      </select>
      <select
        class="target__select"
        data-role="venue-name"
        aria-label="Target venue"
        data-testid=${`target-venue-${paper.id}`}
        @change=${retarget}
      >
        ${custom ? html`<option value=${custom} selected>${custom}</option>` : nothing}
        ${venueOptions(parsed.id ?? "")}
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
  const targets = effectiveVenueTargets(paper);
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

/**
 * The venue select's options, grouped by whether publishing there consumes the paper.
 *
 * Shared by the card and the registration form so the two can never offer different venues -- the
 * card is where a registration gets corrected, and a venue missing from one of them would read as
 * the target having been dropped.
 */
function venueOptions(selectedId: string) {
  const group = (label: string, entries: CatalogVenue[]) => html`
    <optgroup label=${label}>
      ${entries.map(
        (entry) => html`
          <option value=${entry.id} ?selected=${entry.id === selectedId}>${entry.label}</option>
        `,
      )}
    </optgroup>
  `;
  return html`
    ${group("Archival", ARCHIVAL_VENUES)} ${group("Non-archival", NON_ARCHIVAL_VENUES)}
    ${group("Workshops (check the CFP)", WORKSHOP_VENUES)}
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
 * The next real archival deadlines, soonest first.
 *
 * Read from the bundled deadline board rather than a hand-kept list, so a new paper defaults to
 * whatever is actually next rather than to whatever someone typed last year. The venue *list* is
 * the catalog (data/venue-catalog.ts); this only decides which of its entries opens selected.
 * Archival conference deadlines only -- camera-ready and commitment rows are not things you target
 * from scratch.
 */
function upcomingVenues(now = new Date()) {
  const future = DEADLINE_VENUES.filter((venue) => {
    const due = aoeInstantMs(venue.deadline_aoe);
    return Number.isFinite(due) && due > now.getTime();
  })
    // Archival conferences only. Sorting purely by date buries ICLR and ARR under fifty workshop
    // commitment deadlines, so the default ends up a venue nobody was aiming for.
    .filter((venue) => venue.archival_status === "archival")
    .toSorted((left, right) => left.deadline_aoe.localeCompare(right.deadline_aoe));

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
  return [...byGroup.values()].slice(0, 6);
}

/**
 * What a new paper is aimed at before anyone says otherwise: the next real deadline.
 *
 * The deadline board is still the source of the default -- it is the only thing that knows what is
 * actually next -- but the answer is expressed as a catalog venue and a year, so the two selects
 * open on it. A deadline the catalog cannot name (a workshop, an ARR cycle) falls through to no
 * venue rather than to a target nobody can then edit.
 */
function defaultTarget(now = new Date()) {
  const year = now.getUTCFullYear();
  for (const venue of upcomingVenues(now)) {
    const parsed = parseVenue(venue.name);
    if (parsed.id) {
      return { id: parsed.id, year: parsed.year ?? year };
    }
  }
  return { id: "", year };
}

/** How sure the authors are about hitting this venue. Coarse on purpose: finer is false precision. */
const CONFIDENCE_OPTIONS = ["30", "50", "80", "99"];

function renderAddForm(state: AppViewState, props: MyWorkProps) {
  const draft = state.myWorkProjectDraft ?? "";
  const member = findOwnMember(state);
  const fallback = defaultTarget();
  // Seeded from the next deadline, held in view state so a re-render (typing the title, adding a
  // row) does not throw away what has been picked.
  //
  // Read through a function rather than captured once: every handler below runs after the render
  // that created it, and a handler that closed over the array would write whatever was on screen
  // when it was drawn. That is invisible while a re-render happens between every click and wrong
  // the moment one does not -- the submit would file the seeded venue over the picked one.
  const currentTargets = () =>
    state.myWorkProjectVenues?.length
      ? state.myWorkProjectVenues
      : [{ venueId: fallback.id, year: fallback.year, confidence: 50 }];
  const targets = currentTargets();
  const updateTarget = (
    index: number,
    patch: Partial<{ venueId: string; year: number; confidence: number }>,
  ) => {
    state.myWorkProjectVenues = currentTargets().map((target, at) =>
      at === index ? { ...target, ...patch } : target,
    );
    props.onRerender?.();
  };
  return html`
    <form
      id="my-work-add-form"
      class="my-work-add-form register"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const title = draft.trim();
        if (!title) {
          return;
        }
        const rows = currentTargets();
        const primary = rows[0] ?? { venueId: fallback.id, year: fallback.year, confidence: 50 };
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
          // Every target, each with its own odds -- the shape venue-targets.ts already stores.
          venueTargets: serializeVenueTargets(
            rows.map((target) => ({
              venue_id: target.venueId,
              label: formatVenue(target.venueId, target.year),
              confidence: target.confidence,
            })),
          ),
          // The first target also lands in the legacy pair. The deadline board, the venue-stage
          // nudges and the card's own target line all read `artifacts.conference`, and none of
          // them understands a list yet; writing both keeps one paper from reading two ways.
          conference: formatVenue(primary.venueId, primary.year),
          confidence: String(primary.confidence),
        });
        state.myWorkProjectDraft = null;
        state.myWorkProjectVenues = [];
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

      <!-- One row per venue the paper is aimed at, each with its own odds.
           A paper genuinely can be 80% ICLR and 50% ARR October: those are independent bets on
           the same work, not a distribution that has to sum to anything -- which is why the
           probability sits on the row rather than on the form.

           Conference before year, because the conference is the decision and the year follows
           from it. There was also a second venue select above this row: two controls sharing one
           form name, so FormData read the first and the "defaults to the next deadline" promise
           below was never actually kept. -->
      <div class="register__field">
        <span class="register__label">Target venues</span>
        ${targets.map(
          (target, index) => html`
            <div
              class="register__row register__row--venue"
              data-testid=${`register-venue-row-${index}`}
            >
              <label class="sr-only" for=${`register-venue-${index}`}>Target venue</label>
              <select
                class="input"
                id=${`register-venue-${index}`}
                data-testid=${`register-venue-${index}`}
                @change=${(event: Event) =>
                  updateTarget(index, { venueId: (event.target as HTMLSelectElement).value })}
              >
                ${venueOptions(target.venueId)}
                <option value="" ?selected=${!target.venueId}>Other / not decided yet</option>
              </select>
              <label class="sr-only" for=${`register-venue-year-${index}`}>Target year</label>
              <select
                class="input"
                id=${`register-venue-year-${index}`}
                data-testid=${`register-venue-year-${index}`}
                @change=${(event: Event) =>
                  updateTarget(index, {
                    year: Number((event.target as HTMLSelectElement).value),
                  })}
              >
                ${venueYears().map(
                  (year) => html`
                    <option value=${String(year)} ?selected=${year === target.year}>${year}</option>
                  `,
                )}
              </select>
              <label class="sr-only" for=${`register-venue-odds-${index}`}>How likely</label>
              <select
                class="input"
                id=${`register-venue-odds-${index}`}
                data-testid=${`register-venue-odds-${index}`}
                @change=${(event: Event) =>
                  updateTarget(index, {
                    confidence: Number((event.target as HTMLSelectElement).value),
                  })}
              >
                ${CONFIDENCE_OPTIONS.map(
                  (value) => html`
                    <option value=${value} ?selected=${Number(value) === target.confidence}>
                      ${value}% likely
                    </option>
                  `,
                )}
              </select>
              ${targets.length > 1
                ? html`<button
                    type="button"
                    class="btn btn--sm"
                    title="Remove this venue"
                    data-testid=${`register-venue-remove-${index}`}
                    @click=${() => {
                      state.myWorkProjectVenues = currentTargets().filter((_, at) => at !== index);
                      props.onRerender?.();
                    }}
                  >
                    ${icons.x}
                  </button>`
                : nothing}
            </div>
          `,
        )}
        <button
          type="button"
          class="btn btn--sm"
          data-testid="register-venue-add"
          @click=${() => {
            state.myWorkProjectVenues = [
              ...currentTargets(),
              { venueId: "", year: fallback.year, confidence: 50 },
            ];
            props.onRerender?.();
          }}
        >
          Add another conference
        </button>
        <span class="register__hint">
          Defaults to the next deadline. Add as many as the paper is genuinely aimed at, each with
          its own odds.
        </span>
      </div>

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
function renderBlockers(state: AppViewState, items: AdminBotPaperRecord[]) {
  const blockers = items.flatMap((paper) =>
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
  // Gated on its own rather than trusting that the only way to fill `nudgeBatches` is the
  // admin-only button above: this block names every member who owes something and quotes the
  // message that would go to them, which is not a member's view of their own page.
  if (!props.canNudge || !batches) {
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
/**
 * Decisions this member has not answered, and what they have half-picked.
 *
 * Session state, not app state: dismissing is a "not right now", and the stored flag is what
 * makes an answer permanent. Kept module-level so a re-render mid-answer does not lose the
 * buttons already pressed.
 */
const collapsedDecisions = new Set<string>();
/** Papers whose answer was written in this session, so the button can say so before a reload. */
const savedDecisions = new Set<string>();
/**
 * Papers edited since their answer was written.
 *
 * Needed because `isDecisionAnswered` reads the stored flag, which stays true once an answer has
 * ever been saved -- so without this, changing Track from Main to Spotlight left the button
 * reading "Saved ✓" while describing something older than the screen.
 */
const dirtyDecisions = new Set<string>();
/** The coauthor-email task: whether the box is open, and the body as edited. */
const emailTasks = new Map<string, { open: boolean; body: string }>();
const decisionDrafts = new Map<
  string,
  { presentation: string; attending: "yes" | "no" | ""; nextVenue: string }
>();

/** The venue as the banner names it, so the mail and the heading never disagree. */
function venueOf(paper: AdminBotPaperRecord): string {
  return paper.accepted_venue?.trim() || paper.artifacts?.conference?.trim() || "the venue";
}

function renderDecisionBanners(
  papers: AdminBotPaperRecord[],
  props: MyWorkProps,
  members: AdminBotLabMember[],
) {
  const memberId = props.memberId;
  if (!memberId) {
    return nothing;
  }
  // Every decided paper, answered or not. The banner is the record of the decision as well as
  // the prompt for it, so it does not leave when the prompt is satisfied.
  const waiting = papers.filter((paper) => decisionOf(paper) !== null);
  if (waiting.length === 0) {
    return nothing;
  }
  return html`${waiting.map((paper) => {
    const decision = decisionOf(paper);
    if (!decision) {
      return nothing;
    }
    // "Saved" survives a re-render but not a fresh page load, where the stored flag takes over.
    // An edit since the last write beats both.
    const saved =
      !dirtyDecisions.has(paper.id) && (savedDecisions.has(paper.id) || isDecisionAnswered(paper));
    const draft = decisionDrafts.get(paper.id) ?? {
      presentation: paper.presentation_type ?? "",
      attending: "" as const,
      nextVenue: "",
    };
    return renderDecisionBanner({
      paper,
      decision,
      draft,
      saved,
      dirty: dirtyDecisions.has(paper.id),
      members,
      // One person per paper is asked, and author order decides who, so everybody can predict
      // the answer from the paper rather than from who opened AdminBot first.
      // Matched on id where the session carries one, and on name otherwise. A member whose
      // roster row is not the row the session names -- a duplicate entry, an import that made a
      // second row -- would otherwise be told nothing at all on their own paper.
      isEmailOwner: (() => {
        const owner = firstFullMemberAuthor(paper, members);
        if (!owner) {
          return false;
        }
        return owner.id === memberId || isSamePerson(owner.name, props.memberName(memberId));
      })(),
      email: emailTasks.get(paper.id) ?? null,
      onToggleEmail: () => {
        const current = emailTasks.get(paper.id);
        emailTasks.set(paper.id, {
          open: !current?.open,
          body:
            current?.body ??
            buildCoauthorEmail(paper, decision, venueOf(paper), props.memberName(memberId)).body,
        });
        props.onRerender?.();
      },
      onEmailBody: (body) => {
        emailTasks.set(paper.id, { open: true, body });
        props.onRerender?.();
      },
      onResetEmail: () => {
        emailTasks.set(paper.id, {
          open: true,
          body: buildCoauthorEmail(paper, decision, venueOf(paper), props.memberName(memberId))
            .body,
        });
        props.onRerender?.();
      },
      onReset: () => {
        decisionDrafts.set(paper.id, { presentation: "", attending: "", nextVenue: "" });
        savedDecisions.delete(paper.id);
        dirtyDecisions.add(paper.id);
        props.onRerender?.();
      },
      onDraft: (patch) => {
        decisionDrafts.set(paper.id, { ...draft, ...patch });
        // Any change re-arms the button: "Saved" must never describe something older than the
        // thing on screen.
        savedDecisions.delete(paper.id);
        dirtyDecisions.add(paper.id);
        props.onRerender?.();
      },
      onSavePaper: (input) => {
        savedDecisions.add(paper.id);
        dirtyDecisions.delete(paper.id);
        props.onSavePaper(input);
      },
      onSetAttendance: (attending) =>
        props.onSetAttendee(paper.id, props.memberName(memberId), memberId, attending),
      onPreRegister: () =>
        openPreRegistrationDialog({
          papers,
          onSavePaper: props.onSavePaper,
          onDone: () => props.onRerender?.(),
        }),
      collapsed: collapsedDecisions.has(paper.id),
      onToggleCollapsed: () => {
        // Collapsed, not gone. The decision is still unanswered, and a banner that vanishes on
        // "not now" takes the news with it -- the author has no way back to it short of noticing
        // a dropdown deep in the card.
        if (collapsedDecisions.has(paper.id)) {
          collapsedDecisions.delete(paper.id);
        } else {
          collapsedDecisions.add(paper.id);
        }
        props.onRerender?.();
      },
    });
  })}`;
}

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
          <span aria-hidden="true">🚨</span> Conference pre-registration — ${next.venue.label}
        </div>
        <div class="prereg-banner__sub">
          ${next.days} day${next.days === 1 ? "" : "s"} to the deadline · ${outstanding.length} of
          your ${papers.length} paper${papers.length === 1 ? "" : "s"} not registered
          yet${registered > 0 ? ` · ${registered} done` : ""}
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

/**
 * Opens the dialog once it is in the document.
 *
 * `showModal()` and not the `open` attribute: only the modal form gives the focus trap, the Escape
 * key and the backdrop, and a card with a dozen editable fields behind a non-modal panel is a way
 * to type into the wrong one.
 */
function showPaperDialog(element?: Element) {
  // `showModal` is guarded rather than assumed: jsdom does not implement it, and a render helper
  // that throws there takes down every test of any page this dialog happens to be on.
  if (!(element instanceof HTMLDialogElement) || element.open) {
    return;
  }
  const open = () => {
    if (element.isConnected && !element.open && typeof element.showModal === "function") {
      element.showModal();
    }
  };
  if (element.isConnected) {
    open();
  } else {
    queueMicrotask(open);
  }
}

/**
 * One paper's card, opened from the row that names it.
 *
 * Active Papers used to render this card for every paper in the lab, stacked under the table -- the
 * same deck a member gets for their own three or four papers, over seventy. That is not a page an
 * administrator reads; it is a page they scroll past to reach the boards below it. The card is
 * still exactly the card, with the same fields and the same writes. It just arrives when somebody
 * asks for a specific paper, which is the only time it answers anything.
 *
 * Always expanded: the dialog was opened to read this paper, so making its body a second click is
 * asking the same question twice.
 */
export function renderPaperCardDialog(params: {
  state: AppViewState;
  props: MyWorkProps;
  paper: AdminBotPaperRecord;
  onClose: () => void;
}) {
  return html`
    <dialog
      class="paper-card-dialog"
      data-testid="paper-card-dialog"
      ${ref(showPaperDialog)}
      @click=${(event: Event) => {
        // The backdrop is the dialog itself; a click that lands on a child is not a dismissal.
        if (event.target === event.currentTarget) {
          (event.currentTarget as HTMLDialogElement).close();
        }
      }}
      @close=${params.onClose}
    >
      <div class="paper-card-dialog__panel">
        <div class="paper-card-dialog__header">
          <strong>${params.paper.title}</strong>
          <button
            class="btn btn--sm"
            type="button"
            data-testid="paper-card-dialog-close"
            @click=${(event: Event) => {
              const dialog = (event.currentTarget as HTMLElement).closest("dialog");
              // Same reason as showPaperDialog: `close` is absent in jsdom. Without it the host
              // never learns the card was dismissed and the row stays lit.
              if (typeof dialog?.close === "function") {
                dialog.close();
              } else {
                dialog?.dispatchEvent(new Event("close"));
              }
            }}
          >
            ${t("common.close")}
          </button>
        </div>
        <div class="paper-card-dialog__body">
          ${renderItem(params.state, params.paper, { ...params.props, openIds: [params.paper.id] })}
        </div>
      </div>
    </dialog>
  `;
}

export function renderMyWork(state: AppViewState, props: MyWorkProps) {
  const items = props.papers ?? ownPapers(state);
  // Two lists, one source: a finished paper is still the member's, it just stops being work.
  const { ongoing, completed } = partitionByCompletion(items);
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
      ${props.personal ? renderPreRegistrationBanner(items, props) : nothing}
      ${props.personal
        ? renderDecisionBanners(items, props, state.adminBotData?.members ?? [])
        : nothing}
      ${renderBlockers(state, items)}
      <section class="my-work__section">
        <div class="my-work__section-head">
          <h2 class="my-work__section-title">${props.title ?? t("myWork.items.title")}</h2>
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
          ? html`
              <div class="my-work__items">
                ${ongoing.map((paper) => renderItem(state, paper, props))}
              </div>
              ${completed.length
                ? html`
                    <!-- Finished papers stay on the page rather than disappearing: they are the
                         record of what the lab published, and a list that silently shrinks is how
                         somebody loses a paper. Below the live ones, and behind a disclosure, so
                         they cost a line rather than a scroll. -->
                    <details class="my-work__done" data-testid="my-work-completed">
                      <summary class="my-work__done-summary">
                        Completed (${completed.length})
                      </summary>
                      <div class="my-work__items">
                        ${completed.map((paper) => renderItem(state, paper, props))}
                      </div>
                    </details>
                  `
                : nothing}
              ${ongoing.length === 0
                ? html`<p class="my-work__empty">
                    Nothing in flight — every paper here is finished.
                  </p>`
                : nothing}
            `
          : html`<p class="my-work__empty">${t("myWork.items.empty")}</p>`}
        <p class="my-work__notice">${t("myWork.items.syncNotice")}</p>
        ${state.myWorkProjectDraft !== null ? renderAddForm(state, props) : nothing}
      </section>
    </div>
  `;
}
