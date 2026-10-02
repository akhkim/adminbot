// The signed-in member's onboarding, as a page of its own.
//
// It used to be two things at the bottom of My Profile: a "Steps to finish" stack that only linked
// out, and, under it, a folded checklist that was the sole place a step could be ticked off. On a
// page somebody edits every week that is a wall of somebody else's business, and the two halves
// said the same thing twice.
//
// So it is a tab, and the tab is a tracker: how far along you are, what is left, and what you have
// already done, folded away. Every step is markable here -- completion is self-attested (no
// service can verify "joined the Slack"), and that attestation is what the onboarding follow-up
// sweep keys off, so there has to be one place that owns it.
//
// The walk-one-step-at-a-time card this replaces made sense as a first-login gate. It does not
// make sense as a page you return to: coming back to step 7 of 11 to tick off the one thing you
// finished this week meant pressing Next six times.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
import { icons } from "../../icons.ts";
import { toggleOnboardingStep } from "../auth/flow.ts";
import type { MemberOnboardingStep } from "../auth/session.ts";
import { blankFields, findOwnMember } from "./profile.ts";

// Auto-granted at registration approval (see auth.ts); there is nothing for the member to do, so
// it gets no self-attestation toggle.
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

// Completion is self-attested, and undoing is always allowed -- "required" describes what the lab
// is waiting for, never a one-way door on a member's own answer.
function renderStepToggle(state: AppViewState, step: MemberOnboardingStep) {
  if (AUTO_GRANTED_STEP_IDS.has(step.id)) {
    return html`<span class="getting-started__auto">${t("adminbotWelcome.autoGranted")}</span>`;
  }
  const complete = step.status === "complete";
  const busy = state.adminBotOnboardingBusyStepId === step.id;
  return html`
    <button
      type="button"
      class="btn onboarding-step-card__toggle ${complete ? "" : "primary"}"
      data-testid=${`getting-started-toggle-${step.id}`}
      ?disabled=${state.adminBotOnboardingBusyStepId !== null}
      @click=${() => void toggleOnboardingStep(state, step.id, !complete)}
    >
      ${busy
        ? t("adminbotWelcome.saving")
        : complete
          ? t("adminbotWelcome.undo")
          : t("adminbotWelcome.markDone")}
    </button>
  `;
}

function renderStepCard(state: AppViewState, step: MemberOnboardingStep) {
  return html`
    <div class="onboarding-step-card getting-started__step" data-testid=${`step-${step.id}`}>
      <div class="onboarding-step-card__row onboarding-step-card__row--task">
        <div class="onboarding-step-card__task">
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

      <div class="getting-started__step-footer">${renderStepToggle(state, step)}</div>
    </div>
  `;
}

// A done step keeps its label and its way back out, and nothing else: the detail and the links were
// instructions for doing it, and re-reading them is not what somebody opens this list for.
function renderDoneRow(state: AppViewState, step: MemberOnboardingStep) {
  return html`
    <li class="getting-started__done-row" data-testid=${`done-${step.id}`}>
      <span class="getting-started__done-mark" aria-hidden="true">${icons.check}</span>
      <span class="getting-started__done-label">${step.label}</span>
      ${renderStepToggle(state, step)}
    </li>
  `;
}

function renderProgress(done: number, total: number, requiredLeft: number) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return html`
    <section class="getting-started__progress" data-testid="getting-started-progress">
      <div class="getting-started__progress-row">
        <span class="getting-started__progress-count">
          ${t("adminbotWelcome.progress.steps", { done: String(done), total: String(total) })}
        </span>
        ${requiredLeft > 0
          ? html`<span class="ab-chip getting-started__required-left">
              ${t("gettingStarted.requiredLeft", { count: String(requiredLeft) })}
            </span>`
          : nothing}
      </div>
      <!-- aria-hidden because the count above already says the same thing in words, and a
           progress element repeating it is one more thing to listen past. -->
      <div class="getting-started__bar" aria-hidden="true">
        <span class="getting-started__bar-fill" style=${`width: ${pct}%`}></span>
      </div>
      ${done === total
        ? html`<p class="getting-started__all-done">${t("adminbotWelcome.progress.allDone")}</p>`
        : nothing}
    </section>
  `;
}

// The guidebook pointers that used to sit under the onboarding stack on My Profile. They are advice
// rather than something the lab is waiting on, so they stay below the checklist and keep their own
// heading -- but they are still "things left to do", which is what this page is.
function renderSuggestions(state: AppViewState) {
  const member = findOwnMember(state);
  if (!member) {
    return nothing;
  }
  const blanks = new Set(blankFields(member).map((field) => field.key));
  const suggestions: Array<{
    id: string;
    title: string;
    body: string;
    label: string;
    href: string;
  }> = [];

  // No URN card here: the collector hand-off sits on the field it feeds (renderFieldAction on the
  // profile), where it stays reachable after the field is filled. No GPU card either -- cluster
  // access is granted on the admin side, so a member could not act on it.
  if (blanks.has("personal_website")) {
    suggestions.push({
      id: "website",
      title: t("profile.suggestions.websiteTitle"),
      body: t("profile.suggestions.websiteBody"),
      label: t("profile.suggestions.websiteLink"),
      href: "https://github.com/akhkim/openclaw-adminbot-lab#member-pages",
    });
  }

  if (!suggestions.length) {
    return nothing;
  }

  return html`
    <section class="getting-started__section" data-testid="getting-started-suggestions">
      <h2 class="getting-started__section-title">${t("profile.suggestions.other")}</h2>
      <div class="profile__suggestions">
        ${suggestions.map(
          (suggestion) => html`
            <article class="profile-suggestion" data-testid=${`suggestion-${suggestion.id}`}>
              <h3 class="profile-suggestion__title">${suggestion.title}</h3>
              <p class="profile-suggestion__body">${suggestion.body}</p>
              <a
                class="profile-suggestion__link"
                href=${suggestion.href}
                target=${EXTERNAL_LINK_TARGET}
                rel=${buildExternalLinkRel()}
              >
                ${suggestion.label}
                <span class="profile-suggestion__icon" aria-hidden="true">
                  ${icons.externalLink}
                </span>
              </a>
            </article>
          `,
        )}
      </div>
    </section>
  `;
}

/** How many steps this member still owes the lab, for the pointer on My Profile and the sidebar. */
export function outstandingOnboardingCount(state: AppViewState): number {
  return (state.adminBotOnboarding?.steps ?? []).filter((step) => step.status !== "complete")
    .length;
}

export function renderGettingStarted(state: AppViewState) {
  const steps = state.adminBotOnboarding?.steps ?? [];
  if (!steps.length) {
    // Not an error: the checklist is generated when a registration is approved, so a member who
    // arrived another way (seeded roster, admin-created record) has none and never will.
    return html`<p class="getting-started__empty" data-testid="getting-started-empty">
      ${t("gettingStarted.empty")}
    </p>`;
  }

  const remaining = steps.filter((step) => step.status !== "complete");
  const done = steps.filter((step) => step.status === "complete");
  const requiredLeft = remaining.filter(
    (step) => step.required && !AUTO_GRANTED_STEP_IDS.has(step.id),
  ).length;

  return html`
    <div class="getting-started" data-testid="getting-started">
      ${renderProgress(done.length, steps.length, requiredLeft)}
      ${state.adminBotOnboardingError
        ? html`<p class="onboarding-step-card__error" role="alert">
            ${state.adminBotOnboardingError}
          </p>`
        : nothing}
      ${remaining.length
        ? html`
            <section class="getting-started__section" data-testid="getting-started-remaining">
              <h2 class="getting-started__section-title">${t("gettingStarted.stillToDo")}</h2>
              ${groupStepsByCategory(remaining).map(
                (group) => html`
                  <div class="getting-started__group">
                    <h3 class="getting-started__group-title">${group.category}</h3>
                    <div class="getting-started__steps">
                      ${group.steps.map((step) => renderStepCard(state, step))}
                    </div>
                  </div>
                `,
              )}
            </section>
          `
        : nothing}
      ${done.length
        ? html`
            <details class="my-work__done getting-started__done" data-testid="getting-started-done">
              <summary class="my-work__done-summary">
                ${t("gettingStarted.done", { count: String(done.length) })}
              </summary>
              <ul class="getting-started__done-list">
                ${done.map((step) => renderDoneRow(state, step))}
              </ul>
            </details>
          `
        : nothing}
      ${renderSuggestions(state)}
    </div>
  `;
}
