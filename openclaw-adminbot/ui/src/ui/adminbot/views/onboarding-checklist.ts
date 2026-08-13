// The signed-in member's onboarding checklist, rendered as a standing warning card on the
// dashboard rather than a first-login popup: it shows on every login/reload until the member
// has walked every step (acknowledgeOnboardingChecklist in auth/flow.ts).
//
// Steps are walked one at a time rather than shown as a wall of text. A required, incomplete step
// blocks "Next" -- "Back" is always available, and undoing a previously-marked step is always
// allowed, whether or not it's required. The block only ever applies going forward.
import { html, nothing } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
import { acknowledgeOnboardingChecklist, toggleOnboardingStep } from "../auth/flow.ts";
import type { MemberOnboardingStep } from "../auth/session.ts";

// Auto-granted at registration approval (see auth.ts); there is nothing for the member to do,
// so it gets no self-attestation toggle and never blocks "Next".
const AUTO_GRANTED_STEP_IDS = new Set(["calendar_invite"]);
const stepCardRef = createRef<HTMLDivElement>();
// Fixed display order for step categories; any category not listed here (there shouldn't be one)
// falls back to appearing after all known ones, in first-seen order.
const CATEGORY_ORDER = [
  "Getting started",
  "Social media",
  "Compute access",
  "Working with us",
  "Questions",
];

function statusLabel(status: MemberOnboardingStep["status"]): string {
  if (status === "complete") {
    return t("adminbotWelcome.status.complete");
  }
  if (status === "current") {
    return t("adminbotWelcome.status.current");
  }
  return t("adminbotWelcome.status.remaining");
}

function groupStepsByCategory(
  steps: MemberOnboardingStep[],
): Array<{ category: string; steps: MemberOnboardingStep[] }> {
  const groups = new Map<string, MemberOnboardingStep[]>();
  for (const step of steps) {
    const bucket = groups.get(step.category);
    if (bucket) {
      bucket.push(step);
    } else {
      groups.set(step.category, [step]);
    }
  }
  const known = CATEGORY_ORDER.filter((category) => groups.has(category));
  const unknown = [...groups.keys()].filter((category) => !CATEGORY_ORDER.includes(category));
  return [...known, ...unknown].map((category) => ({
    category,
    steps: groups.get(category) ?? [],
  }));
}

// Flattened walk order: category grouping decides sequence, but navigation is a single linear
// list -- "step 4 of 11" means the same thing regardless of which category it falls in.
function flattenOrderedSteps(
  steps: MemberOnboardingStep[],
): Array<{ category: string; step: MemberOnboardingStep }> {
  return groupStepsByCategory(steps).flatMap((group) =>
    group.steps.map((step) => ({ category: group.category, step })),
  );
}

function renderStepLinks(step: MemberOnboardingStep) {
  if (!step.links?.length) {
    return nothing;
  }
  return html`
    <div class="onboarding-step-card__links">
      ${step.links.map(
        (link) => html`
          <a
            class="btn onboarding-step-card__link"
            href=${link.url}
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            >${link.label}</a
          >
        `,
      )}
    </div>
  `;
}

// Completion is self-attested. Undoing is always allowed, required or not -- the required
// constraint only ever blocks moving forward, never blocks correcting a mistaken "done".
function renderStepToggle(state: AppViewState, step: MemberOnboardingStep) {
  if (AUTO_GRANTED_STEP_IDS.has(step.id)) {
    return nothing;
  }
  const complete = step.status === "complete";
  const busy = state.adminBotOnboardingBusyStepId === step.id;
  return html`
    <button
      type="button"
      class="btn onboarding-step-card__toggle"
      ?disabled=${busy || state.adminBotOnboardingBusyStepId !== null}
      @click=${async () => {
        await toggleOnboardingStep(state, step.id, !complete);
        scrollToStepCard();
      }}
    >
      ${busy
        ? t("adminbotWelcome.saving")
        : complete
          ? t("adminbotWelcome.undo")
          : t("adminbotWelcome.markDone")}
    </button>
  `;
}

// The auto-granted calendar step is complete from the start and has no toggle, so opening the walk
// on definition order would show a card nothing can be done with. Start on the first step that
// still needs the member; once they have navigated, their explicit position wins over the default.
function firstUnwalkedStepIndex(
  ordered: Array<{ category: string; step: MemberOnboardingStep }>,
): number {
  const index = ordered.findIndex((entry) => entry.step.status !== "complete");
  return Math.max(0, index);
}

function currentStepIndex(
  state: AppViewState,
  ordered: Array<{ category: string; step: MemberOnboardingStep }>,
): number {
  const raw = state.adminBotOnboardingStepIndex ?? firstUnwalkedStepIndex(ordered);
  return Math.max(0, Math.min(raw, ordered.length - 1));
}

function goToStep(state: AppViewState, index: number, total: number) {
  state.adminBotOnboardingStepIndex = Math.max(0, Math.min(index, total - 1));
  scrollToStepCard();
}

// Smooth-scrolls the current step card into view. lit commits the state change rendered inside the
// click that called this (goToStep/toggle) in a microtask, so scrolling synchronously would measure
// the card that is about to be replaced -- and a layout mutation during a smooth scroll is what
// leaves that black band across tall steps. Waiting a frame means the newly committed card is the
// one measured and scrolled.
function scrollToStepCard(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // `block: "start"` would drive the whole page until the card top meets the viewport edge --
      // for a tall step (e.g. Compute Canada) it scrolls away every bit of context above, and the
      // dark card plus the empty pane below reads as a huge black rectangle. `nearest` only moves
      // the page as much as needed to reveal the card, and not at all when it is already visible.
      stepCardRef.value?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });
}

// A required, not-yet-complete step blocks "Next". Auto-granted steps never block -- there is
// nothing the member can do about them -- and completed steps never block regardless of how they
// got that way.
function blocksAdvance(step: MemberOnboardingStep): boolean {
  if (AUTO_GRANTED_STEP_IDS.has(step.id)) {
    return false;
  }
  return step.required && step.status !== "complete";
}

function renderStepCard(
  state: AppViewState,
  entry: { category: string; step: MemberOnboardingStep },
  index: number,
  total: number,
) {
  const { category, step } = entry;
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const blocked = blocksAdvance(step);

  return html`
    <div class="onboarding-step-card" ${ref(stepCardRef)}>
      <div class="onboarding-step-card__row onboarding-step-card__row--category">
        <span class="onboarding-step-card__category">${category}</span>
        <span class="onboarding-step-card__count">${index + 1} / ${total}</span>
      </div>

      <div class="onboarding-step-card__row onboarding-step-card__row--task">
        <div class="onboarding-step-card__task">
          <span class="onboarding-step-card__number">${index + 1}</span>
          <span class="onboarding-step-card__label">${step.label}</span>
        </div>
        <div class="onboarding-step-card__badges">
          ${step.required
            ? html`<span class="onboarding-step-card__badge onboarding-step-card__badge--required"
                >${t("adminbotWelcome.required")}</span
              >`
            : html`<span class="onboarding-step-card__badge onboarding-step-card__badge--optional"
                >${t("adminbotWelcome.optional")}</span
              >`}
          <span
            class="onboarding-step-card__badge onboarding-step-card__badge--status"
            data-status=${step.status}
            >${statusLabel(step.status)}</span
          >
        </div>
      </div>

      <div class="onboarding-step-card__body">
        ${step.detail ? html`<p class="onboarding-step-card__detail">${step.detail}</p>` : nothing}
        ${step.bullets?.length
          ? html`<ul class="onboarding-step-card__bullets">
              ${step.bullets.map(
                (bullet) => html`<li>
                  <span class="onboarding-step-card__bullet-text">${bullet.text}</span>
                  ${bullet.points?.length
                    ? html`<ul class="onboarding-step-card__points">
                        ${bullet.points.map((point) => html`<li>${point}</li>`)}
                      </ul>`
                    : nothing}
                </li>`,
              )}
            </ul>`
          : nothing}
        ${renderStepLinks(step)}
      </div>

      ${blocked
        ? html`<p class="onboarding-step-card__blocked-note" role="alert">
            ${t("adminbotWelcome.blockedNote")}
          </p>`
        : nothing}

      <div class="onboarding-step-card__footer">
        ${!isFirst
          ? html`
              <button
                type="button"
                class="btn onboarding-step-card__back"
                @click=${() => goToStep(state, index - 1, total)}
              >
                ${t("adminbotWelcome.back")}
              </button>
            `
          : nothing}
        ${renderStepToggle(state, step)}
        <button
          type="button"
          class="btn primary onboarding-step-card__next"
          ?disabled=${blocked}
          @click=${() => {
            if (isLast) {
              acknowledgeOnboardingChecklist(state);
            } else {
              goToStep(state, index + 1, total);
            }
          }}
        >
          ${isLast ? t("adminbotWelcome.finish") : t("adminbotWelcome.next")}
        </button>
      </div>
    </div>
  `;
}

// True whenever the card below has something to show -- there is a checklist and the member has
// not acknowledged it yet. Dashboard.ts checks this before deciding whether the warning occupies
// the top of the page.
export function hasUnacknowledgedOnboarding(state: AppViewState): boolean {
  return Boolean(state.adminBotOnboarding) && !state.adminBotOnboardingAcknowledged;
}

export function renderOnboardingChecklist(state: AppViewState) {
  const onboarding = state.adminBotOnboarding;
  if (!onboarding || state.adminBotOnboardingAcknowledged) {
    return nothing;
  }
  const ordered = flattenOrderedSteps(onboarding.steps);
  if (ordered.length === 0) {
    return nothing;
  }
  const index = currentStepIndex(state, ordered);

  return html`
    <section class="dashboard-onboarding" data-testid="dashboard-onboarding-warning">
      <div class="dashboard-onboarding__header">
        <div class="dashboard-onboarding__title">${t("dashboard.onboardingWarning.title")}</div>
        <div class="dashboard-onboarding__sub">${t("dashboard.onboardingWarning.subtitle")}</div>
      </div>
      ${state.adminBotOnboardingError
        ? html`<p class="onboarding-step-card__error" role="alert">
            ${state.adminBotOnboardingError}
          </p>`
        : nothing}
      ${renderStepCard(state, ordered[index], index, ordered.length)}
    </section>
  `;
}