// Control UI view renders the post-login AdminBot onboarding welcome screen.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { dismissAdminBotWelcome } from "../adminbot-auth-flow.ts";
import type { MemberOnboardingStep } from "../adminbot-auth.ts";
import type { AppViewState } from "../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import { agentLogoUrl } from "./agents-utils.ts";

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

function renderStep(step: MemberOnboardingStep) {
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
        </span>
      </div>
      ${step.detail ? html`<p class="adminbot-welcome__step-detail">${step.detail}</p>` : nothing}
      ${step.bullets?.length
        ? html`<ul class="adminbot-welcome__step-bullets">
            ${step.bullets.map((bullet) => html`<li>${bullet}</li>`)}
          </ul>`
        : nothing}
      ${renderStepLinks(step)}
    </li>
  `;
}

function renderCategory(group: { category: string; steps: MemberOnboardingStep[] }) {
  return html`
    <section class="adminbot-welcome__category">
      <h3 class="adminbot-welcome__category-title">${group.category}</h3>
      <ol class="adminbot-welcome__list">
        ${group.steps.map((step) => renderStep(step))}
      </ol>
    </section>
  `;
}

export function renderAdminBotWelcome(state: AppViewState) {
  const onboarding = state.adminBotOnboarding;
  if (!onboarding) {
    return nothing;
  }
  const faviconSrc = agentLogoUrl(state.basePath ?? "");
  return html`
    <div class="login-gate adminbot-welcome">
      <div class="login-gate__card adminbot-welcome__card">
        <div class="login-gate__header">
          <img class="login-gate__logo" src=${faviconSrc} alt="OpenClaw" />
          <div class="login-gate__title">${t("adminbotWelcome.title")}</div>
          <div class="login-gate__sub">${t("adminbotWelcome.subtitle")}</div>
        </div>
        ${groupStepsByCategory(onboarding.steps).map((group) => renderCategory(group))}
        <button
          type="button"
          class="btn primary adminbot-welcome__dismiss"
          @click=${() => dismissAdminBotWelcome(state)}
        >
          ${t("adminbotWelcome.dismiss")}
        </button>
      </div>
    </div>
  `;
}
