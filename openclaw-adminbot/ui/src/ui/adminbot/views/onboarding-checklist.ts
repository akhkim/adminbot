// The signed-in member's onboarding checklist, rendered as a standing warning card on the
// dashboard rather than a first-login popup: it shows on every login/reload until the member
// explicitly clicks "I have read this" (acknowledgeOnboardingChecklist in auth/flow.ts), which is
// deliberately independent of finishing the steps themselves -- someone can acknowledge having
// read the checklist and still have work left on it, same as any other required-reading sign-off.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
import { acknowledgeOnboardingChecklist, toggleOnboardingStep } from "../auth/flow.ts";
import type { MemberOnboardingStep } from "../auth/session.ts";

// Auto-granted at registration approval (see auth.ts); there is nothing for the member to do,
// so it gets no self-attestation toggle.
const AUTO_GRANTED_STEP_IDS = new Set(["calendar_invite"]);

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

function renderStepLinks(step: MemberOnboardingStep) {
  if (!step.links?.length) {
    return nothing;
  }
  return html`
    <div class="adminbot-welcome__step-links">
      ${step.links.map(
        (link) => html`
          <a
            class="btn btn--sm adminbot-welcome__step-link"
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

// Completion is self-attested: no external service can verify these steps (LinkedIn exposes no
// membership API at all), so the member's own toggle is the record the onboarding nudge keys off.
function renderStepToggle(state: AppViewState, step: MemberOnboardingStep) {
  if (AUTO_GRANTED_STEP_IDS.has(step.id)) {
    return nothing;
  }
  const complete = step.status === "complete";
  const busy = state.adminBotOnboardingBusyStepId === step.id;
  return html`
    <button
      type="button"
      class="btn btn--sm adminbot-welcome__step-toggle"
      ?disabled=${busy || state.adminBotOnboardingBusyStepId !== null}
      @click=${() => void toggleOnboardingStep(state, step.id, !complete)}
    >
      ${busy ? "Saving…" : complete ? "Undo" : "Mark done"}
    </button>
  `;
}

function renderStep(state: AppViewState, step: MemberOnboardingStep) {
  return html`
    <li class="adminbot-welcome__step" data-status=${step.status}>
      <div class="adminbot-welcome__step-header">
        <span class="adminbot-welcome__step-label">${step.label}</span>
        <span class="adminbot-welcome__step-badges">
          ${step.required
            ? html`<span class="adminbot-welcome__badge adminbot-welcome__badge--required"
                >${t("adminbotWelcome.required")}</span
              >`
            : nothing}
          <span
            class="adminbot-welcome__badge adminbot-welcome__badge--status"
            data-status=${step.status}
            >${statusLabel(step.status)}</span
          >
          ${renderStepToggle(state, step)}
        </span>
      </div>
      ${step.detail ? html`<p class="adminbot-welcome__step-detail">${step.detail}</p>` : nothing}
      ${step.bullets?.length
        ? html`<ul class="adminbot-welcome__step-bullets">
            ${step.bullets.map(
              (bullet) => html`<li>
                <span class="adminbot-welcome__bullet-text">${bullet.text}</span>
                ${bullet.points?.length
                  ? html`<ul class="adminbot-welcome__step-points">
                      ${bullet.points.map((point) => html`<li>${point}</li>`)}
                    </ul>`
                  : nothing}
              </li>`,
            )}
          </ul>`
        : nothing}
      ${renderStepLinks(step)}
    </li>
  `;
}

function renderCategory(
  state: AppViewState,
  group: { category: string; steps: MemberOnboardingStep[] },
) {
  return html`
    <section class="adminbot-welcome__category">
      <h3 class="adminbot-welcome__category-title">${group.category}</h3>
      <ol class="adminbot-welcome__list">
        ${group.steps.map((step) => renderStep(state, step))}
      </ol>
    </section>
  `;
}

// A single line of "where am I", so the card opens with the shape of the work instead of a wall
// of steps. Counts steps actually finished; the automatic calendar grant counts like any other.
function renderStepProgress(steps: MemberOnboardingStep[]) {
  if (!steps.length) {
    return nothing;
  }
  const done = steps.filter((step) => step.status === "complete").length;
  return html`
    <p class="adminbot-welcome__progress" data-complete=${done === steps.length ? "true" : "false"}>
      ${done === steps.length
        ? t("adminbotWelcome.progress.allDone")
        : t("adminbotWelcome.progress.steps", {
            done: String(done),
            total: String(steps.length),
          })}
    </p>
  `;
}

// True whenever the card in renderOnboardingChecklist below has something to show -- i.e. there
// is a checklist and the member has not acknowledged it yet. Dashboard.ts checks this before
// deciding whether the warning occupies the top of the page.
export function hasUnacknowledgedOnboarding(state: AppViewState): boolean {
  return Boolean(state.adminBotOnboarding) && !state.adminBotOnboardingAcknowledged;
}

export function renderOnboardingChecklist(state: AppViewState) {
  const onboarding = state.adminBotOnboarding;
  if (!onboarding || state.adminBotOnboardingAcknowledged) {
    return nothing;
  }
  return html`
    <section class="dashboard-onboarding" data-testid="dashboard-onboarding-warning">
      <div class="dashboard-onboarding__header">
        <div class="dashboard-onboarding__title">${t("dashboard.onboardingWarning.title")}</div>
        <div class="dashboard-onboarding__sub">${t("dashboard.onboardingWarning.subtitle")}</div>
      </div>
      ${renderStepProgress(onboarding.steps)}
      ${groupStepsByCategory(onboarding.steps).map((group) => renderCategory(state, group))}
      ${state.adminBotOnboardingError
        ? html`<p class="adminbot-welcome__error" role="alert">${state.adminBotOnboardingError}</p>`
        : nothing}
      <button
        type="button"
        class="btn primary dashboard-onboarding__acknowledge"
        data-testid="dashboard-onboarding-acknowledge"
        @click=${() => acknowledgeOnboardingChecklist(state)}
      >
        ${t("dashboard.onboardingWarning.acknowledge")}
      </button>
    </section>
  `;
}
