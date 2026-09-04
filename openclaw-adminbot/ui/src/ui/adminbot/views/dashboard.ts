// Home for anyone signed in: what is waiting on you, what is coming up, and where to go.
//
// This briefly folded into the profile page, on the reasoning that a summary of your own record
// should not sit above the record itself. That reasoning only held for the profile summary card,
// and it cost the other three: the attention stack, the deadline board and the work summary are
// about the lab and the calendar, not about the member's own fields, so putting them on the
// editor buried them under a form. They are a landing page again.
//
// The profile summary card stays gone. It is the one card that really did only say "you are
// here" -- the profile's own completion ledger says the same thing, on the page that can act on
// it.
//
// Each item is built from state the app already loads, and each is gated on the viewer's own role,
// so this never shows a person work they cannot do. `access.ts` is still what enforces that; this
// is presentation. The deadline board itself is the same public renderer used by the dedicated
// route: signed-in members should not get a smaller or stale copy of a public tool.
import { html, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import type { AppViewState } from "../../app-view-state.ts";
import { icons } from "../../icons.ts";
import { iconForTab, isKnownTab, type Tab } from "../../navigation.ts";
import type { AccessRole } from "../access.ts";
import { nextStepFor } from "../next-step.ts";
import {
  daysLeftLabel,
  upcomingMajorDeadlines,
  urgencyOf,
} from "../data/deadline-time.ts";
import { renderAoeDateTime } from "./deadline-date.ts";
import { renderMemberMap } from "./member-map.ts";
import { ownPapers, paperProgress, stepLabel } from "./my-work.ts";
import {
  blankFields,
  fieldLabel,
  findOwnMember,
  focusProfileField,
} from "./profile.ts";

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

// Blank mandatory fields never block saving or leaving the profile editor (see profile.ts) --
// this card, plus a daily Slack reminder for the same members, is how the lab actually follows up
// instead. blankFields() is already mandatory-only: optional fields never appear in it.
//
// The fields live on another tab again, so this navigates rather than scrolling.
//
// Same idea as SUMMARY_PREVIEW_LIMIT below, one card up: enough blanks named to be a route into
// the profile, not so many that this card outgrows the stack it lives in.
const BLANK_FIELD_PREVIEW_LIMIT = 5;

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
  // Naming the blanks is only half the help; each name is the shortest route to the box that
  // answers it, so each one is a button that opens the profile with that control focused.
  const openField = (fieldKey: string) => () => {
    focusProfileField(fieldKey);
    state.setTab("profile");
  };
  // A new member has a dozen blanks, which wrapped to four rows and made one card in the stack
  // three times the height of its siblings -- pushing everything below it off the screen. The
  // first few are a route in; the count in the summary above already carries the total, and the
  // Open profile action carries the rest.
  const shown = blanks.slice(0, BLANK_FIELD_PREVIEW_LIMIT);
  const hidden = blanks.length - shown.length;
  return {
    id: "mandatoryFields",
    title: t("dashboard.mandatoryFields.title"),
    summary: t(key, { count: String(blanks.length) }),
    actionLabel: t("dashboard.mandatoryFields.open"),
    onAction: () => state.setTab("profile"),
    detail: html`
      <ul class="dashboard-card__steps">
        ${shown.map(
          (field) => html`
            <li>
              <button
                type="button"
                class="dashboard-card__step dashboard-card__step--action"
                data-testid=${`dashboard-blank-${field.key}`}
                @click=${openField(field.key)}
              >
                ${fieldLabel(field.key)}
              </button>
            </li>
          `,
        )}
        ${
          hidden > 0
            ? html`<li class="dashboard-card__step dashboard-card__step--more">
                ${t("dashboard.more", { count: String(hidden) })}
              </li>`
            : nothing
        }
      </ul>
    `,
  };
}

/**
 * Anything the lab has told this member, as one card per notification.
 *
 * The same sentence reached them on Slack and popped in the corner when it arrived. This is the
 * copy that is still here tomorrow: a DM scrolls away and a popup is dismissed in a second, and
 * neither is a place to look something up. Read notifications stay on the card -- "read" means the
 * member has seen it, not that they have done it, and an attendance reminder is worth keeping on
 * screen until they have actually turned up to a meeting.
 */
function notificationItems(
  state: AppViewState,
  role: AccessRole,
): AttentionItem[] {
  if (role === "anonymous") {
    return [];
  }
  return (state.adminBotNotifications ?? []).map((notification) => ({
    id: `notification-${notification.id}`,
    title: notification.title,
    summary: notification.body,
    actionLabel: t("dashboard.notifications.open"),
    onAction: () => {
      void state.markNotificationsRead?.([notification.id]);
      // Checked rather than cast: the tab is a string the service chose, and routing at a view that
      // does not exist would be worse than the card simply not navigating.
      if (isKnownTab(notification.tab)) {
        state.setTab(notification.tab);
      }
    },
  }));
}

function proposalsItem(
  state: AppViewState,
  role: AccessRole,
): AttentionItem | null {
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
    summary: t("dashboard.proposals.summary", {
      count: String(pending.length),
    }),
    actionLabel: t("dashboard.proposals.open"),
    onAction: () => state.setTab("adminbot"),
  };
}

function emailReviewsItem(
  state: AppViewState,
  role: AccessRole,
): AttentionItem | null {
  if (role !== "admin") {
    return null;
  }
  const reviews = state.adminBotData?.emailReviews ?? [];
  if (reviews.length === 0) {
    return null;
  }
  return {
    id: "email-reviews",
    title: "Emails need a decision",
    summary: `${reviews.length} ${
      reviews.length === 1 ? "message was" : "messages were"
    } held because AdminBot could not safely decide what to update.`,
    actionLabel: "Review emails",
    onAction: () => state.setTab("adminbot"),
  };
}

function registrationsItem(
  state: AppViewState,
  role: AccessRole,
): AttentionItem | null {
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

/**
 * Papers whose next step is waiting on the person looking at the page.
 *
 * The point of surfacing this on the dashboard rather than only on the paper list: a next step
 * nobody navigates to is not a nudge. This is the alarm — computed from the dependency graph, so
 * it fires the moment a step becomes actionable rather than after a reminder window elapses.
 */
function nextStepItem(
  state: AppViewState,
  role: AccessRole,
): AttentionItem | null {
  if (role === "anonymous") {
    return null;
  }
  const papers = state.adminBotData?.papers ?? [];
  if (papers.length === 0) {
    return null;
  }

  // Admins care about the whole pipeline; a member only about papers they are on.
  const scoped = role === "admin" ? papers : ownPapers(state);
  const open = scoped
    .map((paper) => ({ paper, next: nextStepFor(paper) }))
    .filter((row) => row.next && !row.next.done);
  if (open.length === 0) {
    return null;
  }

  const waitingOnPi = open.filter((row) => row.next?.isApproval).length;
  const first = open[0];
  const summary =
    open.length === 1 && first?.next
      ? `${first.paper.title}: ${first.next.headline}`
      : `${open.length} papers have an actionable next step` +
        (waitingOnPi > 0 ? `, ${waitingOnPi} waiting on approval` : "");

  return {
    id: "next-step",
    title: "Next steps are ready",
    summary,
    actionLabel: role === "admin" ? "Open Active Papers" : "Open my work",
    onAction: () =>
      state.setTab(role === "admin" ? "adminbotPapers" : "myWork"),
  };
}

function attentionItems(
  state: AppViewState,
  role: AccessRole,
): AttentionItem[] {
  // Own-account work first: a person can always act on their own profile, whereas a queue may be
  // someone else's to clear. Onboarding itself is not in this stack -- it is the checklist at the
  // very bottom of the profile page, see renderOnboardingChecklist.
  return [
    // Above the member's own housekeeping: a notification is the lab having decided to say
    // something to this person, which outranks a blank field nobody has asked about.
    ...notificationItems(state, role),
    mandatoryFieldsItem(state),
    nextStepItem(state, role),
    emailReviewsItem(state, role),
    proposalsItem(state, role),
    registrationsItem(state, role),
  ].filter((item): item is AttentionItem => item !== null);
}

function renderAttentionCard(item: AttentionItem) {
  return html`
    <article
      class="dashboard-card"
      data-testid=${`dashboard-attention-${item.id}`}
    >
      <div class="dashboard-card__body">
        <h3 class="dashboard-card__title">${item.title}</h3>
        <p class="dashboard-card__summary">${item.summary}</p>
        ${item.detail ?? nothing}
      </div>
      <button
        type="button"
        class="btn primary dashboard-card__action"
        @click=${item.onAction}
      >
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
        ${
          items.length
            ? html`<span
                class="dashboard__count"
                aria-label=${t("dashboard.attention.countLabel", { count: String(items.length) })}
                >${items.length}</span
              >`
            : nothing
        }
      </h2>
      ${
        items.length
          ? html`<div class="dashboard__stack">
              ${items.map(renderAttentionCard)}
            </div>`
          : html`<p class="dashboard__empty">
              ${t("dashboard.attention.empty")}
            </p>`
      }
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
    <article
      class="dashboard-summary"
      data-testid=${`dashboard-summary-${params.tab}`}
    >
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

function renderWorkSummary(state: AppViewState) {
  const items = ownPapers(state);
  const blockers = (state.myWorkBlockers ?? []).length;
  return renderSummary({
    state,
    tab: "myWork",
    title: t("dashboard.workSummary.title"),
    headline: t(
      items.length === 1
        ? "dashboard.workSummary.counts"
        : "dashboard.workSummary.countsPlural",
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
                <span
                  class="dashboard-summary__bar"
                  role="progressbar"
                  aria-valuenow=${percent}
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-label=${t("dashboard.myWork.progressLabel", { title: paper.title })}
                >
                  <span
                    class="dashboard-summary__bar-fill"
                    style=${`width:${percent}%`}
                  ></span>
                </span>
                <span class="dashboard-summary__row-step"
                  >${stepLabel(paper.current_step)}</span
                >
              </li>
            `;
          })}
          ${renderMore(items.length - SUMMARY_PREVIEW_LIMIT)}
        </ul>`
      : nothing,
    open: t("dashboard.workSummary.open"),
  });
}

/**
 * The dashboard: what is waiting on the viewer, a summary of their projects and papers, and the
 * complete public deadline board.
 */
/** How many deadlines the dashboard shows. Two is a glance; the board is one click away. */
const DASHBOARD_DEADLINE_COUNT = 2;

type NextDeadline = {
  key: string;
  label: string;
  instant: number;
  mine: boolean;
};

/**
 * The next two deadlines, across both lists the member is actually working to.
 *
 * A union rather than the public board alone. The board answers "what is the field doing"; a
 * member's own dated milestones -- a thesis draft, a committee date, a conference they added to
 * their own panel -- are the ones they plan around, and a summary that showed only the public half
 * could say "nothing for six weeks" to somebody with a submission on Friday.
 *
 * Two, and no more. The whole board used to render here, which made the dashboard mostly a copy of
 * the Deadlines tab: the same rows, one scroll further down, on a page whose job is to say what is
 * waiting on *you*. It is a glance now, and it links to the board rather than reproducing it.
 */
function nextDeadlines(state: AppViewState): NextDeadline[] {
  const now = Date.now();
  const rows: NextDeadline[] = upcomingMajorDeadlines(
    now,
    DASHBOARD_DEADLINE_COUNT,
  ).map((entry) => ({
    key: `venue:${entry.venue.deadline_id ?? entry.venue.name}`,
    label: entry.venue.name,
    instant: entry.instant,
    mine: false,
  }));
  const member = findOwnMember(state);
  for (const milestone of member?.milestones ?? []) {
    const date = String(milestone.date ?? "").trim();
    if (!date) {
      continue;
    }
    // Midday rather than midnight: a whole-day milestone has no clock on it, and parsing it as
    // UTC midnight prints as the day before for every reader west of Greenwich.
    const instant = Date.parse(`${date}T12:00:00Z`);
    if (!Number.isFinite(instant) || instant < now) {
      continue;
    }
    rows.push({
      key: `mine:${date}:${milestone.label ?? ""}`,
      label: String(milestone.label ?? "").trim() || date,
      instant,
      mine: true,
    });
  }
  return rows
    .toSorted((left, right) => left.instant - right.instant)
    .slice(0, DASHBOARD_DEADLINE_COUNT);
}

function renderNextDeadlines(state: AppViewState) {
  const rows = nextDeadlines(state);
  if (rows.length === 0) {
    return nothing;
  }
  const now = Date.now();
  // The board's own row vocabulary, two rows of it: countdown, name, date. The data-urgency
  // attribute is what resolves the urgency color token, so "3 days left" is the same red here as
  // it is on the board rather than a second scale that drifts from it.
  return html`<section
    class="dashboard__next-deadlines"
    data-testid="dashboard-next-deadlines"
  >
    <div class="dashboard__next-deadlines-head">
      <h3 class="card-title">${t("dashboard.nextDeadlines.title")}</h3>
      <button
        type="button"
        class="dashboard__next-deadlines-open"
        data-testid="dashboard-next-deadlines-open"
        @click=${() => state.setTab("adminbotDeadlines")}
      >
        ${t("dashboard.nextDeadlines.open")}
      </button>
    </div>
    <ol class="dashboard__next-deadlines-list">
      ${rows.map(
        (row) =>
          html`<li
            class="dashboard__next-deadline"
            data-urgency=${urgencyOf(row.instant, now)}
          >
            <span class="dashboard__next-deadline-countdown"
              >${daysLeftLabel(row.instant, now)}</span
            >
            <span class="dashboard__next-deadline-name">
              ${row.label}${
              row.mine
                ? html`<span class="dashboard__next-deadline-tag"
                    >${t("dashboard.nextDeadlines.yours")}</span
                  >`
                : nothing
            }
            </span>
            <span class="dashboard__next-deadline-date">
              ${renderAoeDateTime(new Date(row.instant).toISOString())}
            </span>
          </li>`,
      )}
    </ol>
  </section>`;
}

/**
 * The warning across the top of the page: what has been asked of this member and not answered.
 *
 * The cards below already list every notification. This is not a second copy of them -- it is the
 * one thing the cards cannot do, which is be impossible to scroll past. A nudge that reached Slack
 * and the notification list and was still missed is a nudge that needed to be in the way, and this
 * is the last place the lab gets to say so before it asks the head professor to.
 *
 * Escalated items are called out separately and first. Once the professor is in a group DM about
 * something, "you have three unread reminders" is no longer the news.
 */
function renderNudgeWarning(state: AppViewState, role: AccessRole) {
  if (role === "anonymous") {
    return nothing;
  }
  const unread = (state.adminBotNotifications ?? []).filter(
    (notification) => !notification.read_at,
  );
  if (!unread.length) {
    return nothing;
  }
  const escalated = unread.filter((notification) => notification.escalated_at);
  const important = unread.filter(
    (notification) => notification.important && !notification.escalated_at,
  );
  const tone = escalated.length ? "danger" : important.length ? "warn" : "info";
  const headline = escalated.length
    ? t("dashboard.nudgeWarning.escalated", { count: String(escalated.length) })
    : important.length
      ? t("dashboard.nudgeWarning.important", {
          count: String(important.length),
        })
      : t("dashboard.nudgeWarning.unread", { count: String(unread.length) });
  return html`
    <section
      class="dashboard__nudge-warning"
      data-tone=${tone}
      data-testid="dashboard-nudge-warning"
      role="status"
    >
      <strong>${headline}</strong>
      <ul>
        ${(escalated.length ? escalated : important.length ? important : unread)
          .slice(0, 3)
          .map((notification) => html`<li>${notification.title}</li>`)}
      </ul>
      <button
        class="btn btn--sm"
        type="button"
        data-testid="dashboard-nudge-warning-ack"
        @click=${() => void state.markNotificationsRead?.(unread.map((entry) => entry.id))}
      >
        ${t("dashboard.nudgeWarning.acknowledge")}
      </button>
    </section>
  `;
}

export function renderDashboard(state: AppViewState, role: AccessRole) {
  return html`
    <div class="dashboard">
      ${renderNudgeWarning(state, role)} ${renderAttention(state, role)}
      <section class="dashboard__summaries">
        <div class="dashboard__grid">
          ${renderWorkSummary(state)}
          ${renderMemberMap(state.adminBotMemberMap ?? null)}
        </div>
      </section>
      ${renderNextDeadlines(state)}
    </div>
  `;
}
