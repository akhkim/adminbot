// Home for anyone signed in: what is waiting on you, then where to go.
//
// The attention stack at the top is the point of the page. Everything the lab asks of a person --
// finishing onboarding, approving an action, admitting a new member -- used to live behind a tab
// they had to think to open, or behind a welcome screen that only appeared once. Here it is the
// first thing on the page, and it disappears when there is nothing to say.
//
// Each item is built from state the app already loads, and each is gated on the viewer's own role,
// so this page never shows a person work they cannot do. `access.ts` is still what enforces that;
// this is presentation.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { icons } from "../../icons.ts";
import { iconForTab, type Tab } from "../../navigation.ts";
import type { AccessRole } from "../access.ts";
import { ownPapers, paperProgress, stepLabel } from "./my-work.ts";
import { renderOnboardingChecklist } from "./onboarding-checklist.ts";
import { badgesFor, blankFields, findOwnMember } from "./profile.ts";

// One thing waiting on the viewer. `detail` is optional supporting text -- the queue items say
// everything in their summary.
type AttentionItem = {
  id: string;
  title: string;
  summary: string;
  actionLabel: string;
  onAction: () => void;
  detail?: unknown;
};

// Below the attention stack, the dashboard summarises the two pages a member owns rather than
// listing every door in the building: each card states the one number that would make someone open
// that page, and opens it.

// Blank mandatory fields never block saving or leaving the profile editor (see profile.ts) --
// this card, plus a daily Slack reminder for the same members, is how the lab actually follows up
// instead. blankFields() is already mandatory-only: optional fields never appear in it.
function mandatoryFieldsItem(state: AppViewState): AttentionItem | null {
  const member = findOwnMember(state);
  if (!member) {
    return null;
  }
  const blanks = blankFields(member);
  if (!blanks.length) {
    return null;
  }
  const key =
    blanks.length === 1
      ? "dashboard.mandatoryFields.summary"
      : "dashboard.mandatoryFields.summaryPlural";
  return {
    id: "mandatoryFields",
    title: t("dashboard.mandatoryFields.title"),
    summary: t(key, { count: String(blanks.length) }),
    actionLabel: t("dashboard.mandatoryFields.open"),
    onAction: () => state.setTab("profile"),
  };
}

function proposalsItem(state: AppViewState, role: AccessRole): AttentionItem | null {
  if (role !== "admin") {
    return null;
  }
  const pending = (state.adminBotData?.proposals ?? []).filter(
    (proposal) => proposal.status === "pending",
  );
  if (!pending.length) {
    return null;
  }
  return {
    id: "proposals",
    title: t("dashboard.proposals.title"),
    summary: t("dashboard.proposals.summary", { count: String(pending.length) }),
    actionLabel: t("dashboard.proposals.open"),
    onAction: () => state.setTab("adminbot"),
  };
}

function registrationsItem(state: AppViewState, role: AccessRole): AttentionItem | null {
  if (role !== "admin") {
    return null;
  }
  const pending = (state.registrations ?? []).filter(
    (registration) => registration.status === "pending",
  );
  if (!pending.length) {
    return null;
  }
  const key =
    pending.length === 1
      ? "dashboard.registrations.summary"
      : "dashboard.registrations.summaryPlural";
  return {
    id: "registrations",
    title: t("dashboard.registrations.title"),
    summary: t(key, { count: String(pending.length) }),
    actionLabel: t("dashboard.registrations.open"),
    onAction: () => state.setTab("adminbotRegistrations"),
  };
}

function attentionItems(state: AppViewState, role: AccessRole): AttentionItem[] {
  // Own-account work first: a person can always act on their own profile, whereas a queue may be
  // someone else's to clear. Onboarding itself is not in this stack -- it is the dedicated
  // warning card at the very top of the page, see renderOnboardingChecklist below.
  return [
    mandatoryFieldsItem(state),
    proposalsItem(state, role),
    registrationsItem(state, role),
  ].filter((item): item is AttentionItem => item !== null);
}

function renderAttentionCard(item: AttentionItem) {
  return html`
    <article class="dashboard-card" data-testid=${`dashboard-attention-${item.id}`}>
      <div class="dashboard-card__body">
        <h3 class="dashboard-card__title">${item.title}</h3>
        <p class="dashboard-card__summary">${item.summary}</p>
        ${item.detail ?? nothing}
      </div>
      <button type="button" class="btn primary dashboard-card__action" @click=${item.onAction}>
        ${item.actionLabel}
      </button>
    </article>
  `;
}

function renderAttention(state: AppViewState, role: AccessRole) {
  const items = attentionItems(state, role);
  return html`
    <section class="dashboard__attention" data-testid="dashboard-attention">
      <h2 class="dashboard__section-title">
        ${t("dashboard.attention.title")}
        ${items.length ? html`<span class="dashboard__count">${items.length}</span>` : nothing}
      </h2>
      ${items.length
        ? html`<div class="dashboard__stack">${items.map(renderAttentionCard)}</div>`
        : html`<p class="dashboard__empty">${t("dashboard.attention.empty")}</p>`}
    </section>
  `;
}

// How many rows a summary shows before it stops being an overview and starts being the page.
const SUMMARY_PREVIEW_LIMIT = 3;

function renderSummary(params: {
  state: AppViewState;
  tab: Tab;
  title: string;
  headline: string;
  detail: string;
  body: unknown;
  open: string;
}) {
  return html`
    <article class="dashboard-summary" data-testid=${`dashboard-summary-${params.tab}`}>
      <h3 class="dashboard-summary__title">
        <span class="dashboard-summary__icon" aria-hidden="true">
          ${icons[iconForTab(params.tab)]}
        </span>
        ${params.title}
      </h3>
      <p class="dashboard-summary__headline">${params.headline}</p>
      <p class="dashboard-summary__detail">${params.detail}</p>
      ${params.body}
      <button
        type="button"
        class="btn dashboard-summary__action"
        @click=${() => params.state.setTab(params.tab)}
      >
        ${params.open}
      </button>
    </article>
  `;
}

function renderMore(count: number) {
  return count > 0
    ? html`<li class="dashboard-summary__more">
        ${t("dashboard.more", { count: String(count) })}
      </li>`
    : nothing;
}

function renderProfileSummary(state: AppViewState) {
  const member = findOwnMember(state);
  if (!member) {
    return nothing;
  }
  const blanks = blankFields(member);
  const badges = badgesFor(state, member);
  const name = member.name?.trim() || member.email?.trim() || "";
  return renderSummary({
    state,
    tab: "profile",
    title: t("dashboard.profileSummary.title"),
    headline: name,
    detail: [member.role?.trim(), member.affiliation?.trim()].filter(Boolean).join(" · "),
    // An overview of the page: the badges you hold, and the blanks that are still waiting.
    body: html`
      ${badges.length
        ? html`<div class="dashboard-summary__badges">
            ${badges
              .slice(0, SUMMARY_PREVIEW_LIMIT)
              .map((badge) => html`<span class="dashboard-summary__badge">${badge}</span>`)}
            ${badges.length > SUMMARY_PREVIEW_LIMIT
              ? html`<span class="dashboard-summary__badge dashboard-summary__badge--more">
                  ${t("dashboard.more", {
                    count: String(badges.length - SUMMARY_PREVIEW_LIMIT),
                  })}
                </span>`
              : nothing}
          </div>`
        : nothing}
      ${blanks.length
        ? html`<p class="dashboard-summary__line dashboard-summary__line--warn">
            ${t(
              blanks.length === 1
                ? "dashboard.profileSummary.blanks"
                : "dashboard.profileSummary.blanksPlural",
              { count: String(blanks.length) },
            )}
          </p>`
        : html`<p class="dashboard-summary__line">${t("dashboard.profileSummary.complete")}</p>`}
    `,
    open: t("dashboard.profileSummary.open"),
  });
}

function renderWorkSummary(state: AppViewState) {
  const items = ownPapers(state);
  const blockers = (state.myWorkBlockers ?? []).length;
  return renderSummary({
    state,
    tab: "myWork",
    title: t("dashboard.workSummary.title"),
    headline: t(
      items.length === 1 ? "dashboard.workSummary.counts" : "dashboard.workSummary.countsPlural",
      { count: String(items.length) },
    ),
    detail: blockers
      ? t(
          blockers === 1
            ? "dashboard.workSummary.blockers"
            : "dashboard.workSummary.blockersPlural",
          { count: String(blockers) },
        )
      : t("dashboard.workSummary.clear"),
    // An overview of the page: each item with the same step and progress it shows there.
    body: items.length
      ? html`<ul class="dashboard-summary__list">
          ${items.slice(0, SUMMARY_PREVIEW_LIMIT).map((paper) => {
            const { percent } = paperProgress(paper);
            return html`
              <li class="dashboard-summary__row">
                <span class="dashboard-summary__row-label">${paper.title}</span>
                <span class="dashboard-summary__bar">
                  <span class="dashboard-summary__bar-fill" style=${`width:${percent}%`}></span>
                </span>
                <span class="dashboard-summary__row-step">${stepLabel(paper.current_step)}</span>
              </li>
            `;
          })}
          ${renderMore(items.length - SUMMARY_PREVIEW_LIMIT)}
        </ul>`
      : nothing,
    open: t("dashboard.workSummary.open"),
  });
}

export function renderDashboard(state: AppViewState, role: AccessRole) {
  return html`
    <div class="dashboard">
      ${renderOnboardingChecklist(state)} ${renderAttention(state, role)}
      <section class="dashboard__summaries">
        <div class="dashboard__grid">
          ${renderProfileSummary(state)} ${renderWorkSummary(state)}
        </div>
      </section>
    </div>
  `;
}
