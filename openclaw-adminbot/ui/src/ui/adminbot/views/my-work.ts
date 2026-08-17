// The signed-in member's own work: one list of the projects and papers they are on, where each is
// up to, and anything holding one up.
//
// Projects and papers are the same thing here because they are the same record in AdminBot: a
// paper row moves through the PaperPublish steps from brainstorming to poster. Advancing one from
// this page writes `current_step` through the same endpoint the Active Papers page uses, so the
// two pages can never disagree about where something is -- they share both the step vocabulary
// (`stepLabels` / `paperSteps`) and the write path.
//
// Prototype scope: the AdminBot service has no blocker route yet, so a submitted blocker lives in
// browser state and the UI says so rather than implying it was filed.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { icons } from "../../icons.ts";
import type {
  AdminBotPaperRecord,
  AdminBotPaperSaveInput,
  AdminBotPaperStep,
} from "../controllers/admin.ts";
import { nextStepFor, nextTasksFor } from "../next-step.ts";
import { DEADLINE_VENUES } from "../data/deadlines.ts";
import { openPaperFlowMap } from "../paperflow-map.ts";
import { paperSteps, stepLabels } from "./admin.ts";
import { findOwnMember } from "./profile.ts";

export type MyWorkProps = {
  onSavePaper: (paper: AdminBotPaperSaveInput) => void;
};

export type BlockerDraft = {
  paperId: string;
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
  const name = (member?.name ?? "").trim().toLowerCase();
  return (state.adminBotData?.papers ?? []).filter(
    (paper) =>
      (memberId && paper.submitted_by_member_id === memberId) ||
      (memberId && paper.mentor_member_id === memberId) ||
      (name && (paper.authors ?? []).some((author) => author.trim().toLowerCase() === name)),
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

function renderBlockerForm(state: AppViewState, paper: AdminBotPaperRecord) {
  const draft = state.myWorkBlockerDraft;
  if (draft?.paperId !== paper.id) {
    return html`
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
    `;
  }
  return html`
    <form
      class="my-work-blocker-form"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const text = draft.text.trim();
        if (!text) {
          return;
        }
        state.myWorkBlockers = [
          ...state.myWorkBlockers,
          {
            id: `${paper.id}-${state.myWorkBlockers.length + 1}`,
            paperId: paper.id,
            paperTitle: paper.title,
            text,
            createdAt: Date.now(),
          },
        ];
        state.myWorkBlockerDraft = null;
      }}
    >
      <textarea
        class="input my-work-blocker-form__text"
        rows="3"
        placeholder=${t("myWork.blockers.placeholder")}
        .value=${draft.text}
        @input=${(event: Event) => {
          state.myWorkBlockerDraft = {
            paperId: paper.id,
            text: (event.target as HTMLTextAreaElement).value,
          };
        }}
      ></textarea>
      <p class="my-work-blocker-form__reviewer">
        ${t("myWork.blockers.reviewer", { name: reviewerName(state) })}
      </p>
      <div class="my-work-blocker-form__actions">
        <button type="submit" class="btn primary">${t("myWork.blockers.submit")}</button>
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
    </form>
  `;
}

function renderItem(state: AppViewState, paper: AdminBotPaperRecord, props: MyWorkProps) {
  const { index, percent } = paperProgress(paper);
  const blocked = (state.myWorkBlockers ?? []).some((blocker) => blocker.paperId === paper.id);
  return html`
    <article
      class=${`my-work-item ${blocked ? "my-work-item--blocked" : ""}`}
      data-testid=${`my-work-item-${paper.id}`}
    >
      <div class="my-work-item__head">
        <div class="my-work-item__copy">
          <h3 class="my-work-item__title">${paper.title}</h3>
          <p class="my-work-item__meta">${(paper.authors ?? []).join(", ")}</p>
          ${renderTarget(paper, props)}
        </div>
        ${renderBlockerForm(state, paper)}
      </div>
      ${renderStepper(paper, props, index)}
      ${renderNextStep(paper)}
      ${renderStepControls(paper, props)}
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
        ${!known && current
          ? html`<option value=${current} selected>${current}</option>`
          : nothing}
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

function renderStepper(paper: AdminBotPaperRecord, props: MyWorkProps, currentIndex: number) {
  const move = (step: AdminBotPaperStep, targetIndex: number) => {
    const skipped = targetIndex - currentIndex;
    if (skipped > 1) {
      const names = paperSteps
        .slice(currentIndex, targetIndex)
        .map((value) => stepLabel(value))
        .join(", ");
      if (!globalThis.confirm(`Jumping to ${stepLabel(step)} marks these as done: ${names}.\n\nContinue?`)) {
        return;
      }
    }
    saveStep(props, paper, step);
  };

  return html`
    <div class="stepper" role="group" aria-label=${`${paper.title} progress`}>
      <ol class="stepper__track">
        ${paperSteps.map((step, index) => {
          const state =
            index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
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
              <span class="task__who">
                ${task.isApproval ? `Approval from ${task.waitingOn}` : `Owner: ${task.waitingOn}`}
              </span>
              <span class="task__unblocks">
                ${task.optional
                  ? "Blocks nothing"
                  : task.unblocks.length
                    ? `Unblocks ${task.unblocks.slice(0, 2).join(", ")}`
                    : "Last step on this branch"}
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
      <label class="register__field">
        <span class="register__label">Title</span>
        <input
          class="input"
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
    </form>
  `;
}

function renderBlockers(state: AppViewState) {
  const blockers = state.myWorkBlockers ?? [];
  if (!blockers.length) {
    return nothing;
  }
  return html`
    <section class="my-work__section" data-testid="my-work-blockers">
      <h2 class="my-work__section-title">${t("myWork.blockers.title")}</h2>
      <div class="my-work__blockers">
        ${blockers.map(
          (blocker) => html`
            <article class="my-work-blocker">
              <span class="my-work-blocker__icon" aria-hidden="true">${icons.alertTriangle}</span>
              <div class="my-work-blocker__copy">
                <p class="my-work-blocker__text">${blocker.text}</p>
                <p class="my-work-blocker__meta">
                  ${blocker.paperTitle} ·
                  ${t("myWork.blockers.reviewer", { name: reviewerName(state) })}
                </p>
              </div>
              <span class="pill my-work-blocker__status">${t("myWork.blockers.pending")}</span>
            </article>
          `,
        )}
      </div>
      <p class="my-work__notice">${t("myWork.blockers.prototypeNotice")}</p>
    </section>
  `;
}

export function renderMyWork(state: AppViewState, props: MyWorkProps) {
  const items = ownPapers(state);
  return html`
    <div class="my-work">
      ${renderBlockers(state)}
      <section class="my-work__section">
        <div class="my-work__section-head">
          <h2 class="my-work__section-title">${t("myWork.items.title")}</h2>
          ${renderAddButton(state)}
        </div>
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
