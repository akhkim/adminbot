// Control UI view renders the post-login AdminBot onboarding welcome screen.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { dismissAdminBotWelcome } from "../adminbot-auth-flow.ts";
import type { MemberOnboardingStep } from "../adminbot-auth.ts";
import type { AppViewState } from "../app-view-state.ts";
import { agentLogoUrl } from "./agents-utils.ts";

function statusLabel(status: MemberOnboardingStep["status"]): string {
  if (status === "complete") {
    return t("adminbotWelcome.status.complete");
  }
  if (status === "current") {
    return t("adminbotWelcome.status.current");
  }
  return t("adminbotWelcome.status.remaining");
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
    </li>
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
        <ol class="adminbot-welcome__list">
          ${onboarding.steps.map((step) => renderStep(step))}
        </ol>
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
