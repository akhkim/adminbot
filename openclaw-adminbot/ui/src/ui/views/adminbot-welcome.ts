// Control UI view renders the post-login AdminBot onboarding welcome screen.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import {
  acknowledgeOnboardingStepForMember,
  dismissAdminBotWelcome,
  toggleOnboardingStep,
} from "../adminbot-auth-flow.ts";
import type { MemberOnboardingStep } from "../adminbot-auth.ts";
import type { AppViewState } from "../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../external-link.ts";
import { agentLogoUrl } from "./agents-utils.ts";

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
      ${renderStepLinks(step)} ${renderStepAck(state, step)}
    </li>
  `;
}

// Every step ends with an explicit "I've read this". The checklist is reading material, so a click
// is the only evidence it was read -- nothing else about the step can be observed. The automatic
// calendar grant is the one step with nothing to acknowledge, so it shows as already done.
function renderStepAck(state: AppViewState, step: MemberOnboardingStep) {
  if (step.acknowledged_at) {
    return html`<p class="adminbot-welcome__step-ack" data-acknowledged="true">
      ${t("adminbotWelcome.ack.done")}
    </p>`;
  }
  if (step.status === "complete") {
    return nothing;
  }
  return html`
    <div class="adminbot-welcome__step-ack">
      <button
        type="button"
        class="btn btn--sm adminbot-welcome__ack-button"
        @click=${() => void acknowledgeOnboardingStepForMember(state, step.id)}
      >
        ${t("adminbotWelcome.ack.action")}
      </button>
    </div>
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

// Steps that ask the member to read something. Automatic grants (the calendar invite completes
// itself) are not chores, so they count towards neither the progress line nor the dismiss gate.
function readableSteps(steps: MemberOnboardingStep[]): MemberOnboardingStep[] {
  return steps.filter((step) => !(step.status === "complete" && !step.acknowledged_at));
}

// A single line of "where am I", so the screen opens with the shape of the work instead of a wall
// of steps. Counts what is left to read rather than total steps.
function renderAckProgress(steps: MemberOnboardingStep[]) {
  const readable = readableSteps(steps);
  const read = readable.filter((step) => step.acknowledged_at).length;
  if (readable.length === 0) {
    return nothing;
  }
  const remaining = readable.length - read;
  return html`
    <p class="adminbot-welcome__progress" data-complete=${remaining === 0 ? "true" : "false"}>
      ${remaining === 0
        ? t("adminbotWelcome.ack.allDone")
        : t("adminbotWelcome.ack.progress", {
            read: String(read),
            total: String(readable.length),
          })}
    </p>
  `;
}

export function renderAdminBotWelcome(state: AppViewState) {
  const onboarding = state.adminBotOnboarding;
  if (!onboarding) {
    return nothing;
  }
  const faviconSrc = agentLogoUrl(state.basePath ?? "");
  // Leaving is gated on reading: dismissing is what hides the checklist, so allowing it early is
  // the one way a member can skip required steps outright.
  const unread = readableSteps(onboarding.steps).filter((step) => !step.acknowledged_at).length;
  return html`
    <div class="login-gate adminbot-welcome">
      <div class="login-gate__card adminbot-welcome__card">
        <div class="login-gate__header">
          <img class="login-gate__logo" src=${faviconSrc} alt="OpenClaw" />
          <div class="login-gate__title">${t("adminbotWelcome.title")}</div>
          <div class="login-gate__sub">${t("adminbotWelcome.subtitle")}</div>
        </div>
        ${renderAckProgress(onboarding.steps)}
        ${groupStepsByCategory(onboarding.steps).map((group) => renderCategory(state, group))}
        ${state.adminBotOnboardingError
          ? html`<p class="adminbot-welcome__error" role="alert">
              ${state.adminBotOnboardingError}
            </p>`
          : nothing}
        <button
          type="button"
          class="btn primary adminbot-welcome__dismiss"
          ?disabled=${unread > 0}
          title=${unread > 0
            ? t("adminbotWelcome.dismissBlocked", { remaining: String(unread) })
            : nothing}
          @click=${() => dismissAdminBotWelcome(state)}
        >
          ${t("adminbotWelcome.dismiss")}
        </button>
      </div>
    </div>
  `;
}
