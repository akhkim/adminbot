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
import { nextStepFor } from "../next-step.ts";
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
  return html`
    <p class="my-work-item__next">
      ${icons.cornerDownRight}
      <span>
        <strong>Next: ${next.headline}</strong>
        ${next.unblocks ? html`<span class="my-work-item__next-why"> — unblocks ${next.unblocks}</span>` : nothing}
      </span>
    </p>
    ${next.alsoOpen.length > 0
      ? html`<p class="my-work-item__next-also">
          Also open now: ${next.alsoOpen.join(", ")}
        </p>`
      : nothing}
  `;
}

// Adding writes a new paper row at the first step, with the member as its author -- the same
// record the Active Papers page lists, so it appears there too.
function renderAdd(state: AppViewState, props: MyWorkProps) {
  const draft = state.myWorkProjectDraft;
  if (draft === null) {
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
  const member = findOwnMember(state);
  return html`
    <form
      class="my-work-add-form"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
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
        });
        state.myWorkProjectDraft = null;
      }}
    >
      <input
        class="input"
        placeholder=${t("myWork.items.namePlaceholder")}
        .value=${draft}
        @input=${(event: Event) => {
          state.myWorkProjectDraft = (event.target as HTMLInputElement).value;
        }}
      />
      <button type="submit" class="btn primary">${t("myWork.items.addSubmit")}</button>
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
          ${renderAdd(state, props)}
        </div>
        ${items.length
          ? html`<div class="my-work__items">
              ${items.map((paper) => renderItem(state, paper, props))}
            </div>`
          : html`<p class="my-work__empty">${t("myWork.items.empty")}</p>`}
        <p class="my-work__notice">${t("myWork.items.syncNotice")}</p>
      </section>
    </div>
  `;
}
