// Profile Overview: how far along every member's own record is, as a spreadsheet.
//
// The question this answers is the one Zhijing asks on a sweep -- who has not filled their profile
// in, and who has not told us when they are working. Both are things only the member can do, so
// the output of this page is a list of names to talk to, not a number to watch.
//
// A page of its own rather than a section of Lab Members: that page is for looking one person up
// and editing their record, and a scoreboard buried inside it is a scoreboard nobody sweeps.
//
// Read-only. The single button runs the reminder the daily cron already sends; it composes nothing
// and picks nobody -- the service does both.
import { html, nothing } from "lit";
import {
  adminBotTimelineEntryTarget,
  isAdminBotFullMember,
} from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { t } from "../../../i18n/index.ts";
import { icons } from "../../icons.ts";
import {
  matchesMemberTypeFilter,
  renderMemberTypeFilter,
} from "../member-type-filter.ts";
import type {
  MemberActivityCounts,
  MemberAdoptionSummary,
  MemberProfileOverviewRow,
} from "../auth/session.ts";

/** Zero counts render as an em dash rather than "0", which reads as a measurement. */
const countOrDash = (value: number) => (value > 0 ? String(value) : "—");

/** What a row from a server that predates the activity counts renders as. */
const NO_ACTIVITY: MemberActivityCounts = { logins: 0, profile_edits: 0, paper_updates: 0 };

/**
 * Which gap the page is looking at.
 *
 * `any` is the working view -- somebody owes something. The two narrow values exist because the
 * two gaps are chased with different sentences and often on different days: a profile sweep before
 * a grant report, a timeline sweep before term planning. `all` turns the filter off.
 */
export type ProfileOverviewGap = "any" | "profile" | "timeline" | "all";

/** Who the page is looking at. See isAdminBotFullMember for why the distinction matters. */
export type ProfileOverviewMembership = "everyone" | "full";

/**
 * Whether they have ever been here.
 *
 * Its own filter rather than a column to squint at, because "never signed in" is a different
 * conversation from "signed in and has not finished": one is an account nobody has opened, the
 * other is a person who needs reminding. Chasing them with the same message wastes both.
 */
export type ProfileOverviewActivity = "any" | "never" | "signedIn";

export type ProfileOverviewFilter = {
  gap: ProfileOverviewGap;
  membership: ProfileOverviewMembership;
  /** Matches on name. Blank shows everyone the other filters left. */
  search: string;
  activity: ProfileOverviewActivity;
  /**
   * Roster member types to show, as a union. Empty means every type -- see
   * matchesMemberTypeFilter for why the unset state must not hide the table.
   */
  memberTypes: string[];
};

export const EMPTY_PROFILE_OVERVIEW_FILTER: ProfileOverviewFilter = {
  gap: "any",
  membership: "everyone",
  search: "",
  activity: "any",
  memberTypes: [],
};

export type AdminBotProfileOverviewProps = {
  members: MemberProfileOverviewRow[];
  mandatoryFieldCount: number;
  /** The lab-wide roll-up. Null before the first read answers. */
  adoption: MemberAdoptionSummary | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  reminding: boolean;
  /**
   * Nudges exactly the rows the filter is showing, and only about the gap it is filtering on.
   * The page and the message cannot disagree about who is being chased for what, because the
   * filter decides both.
   */
  onRemind: (scope: { include: "profile" | "timeline" | "both"; memberIds: string[] }) => void;
  /**
   * Populates the nudge list from the roster's member types. Sends no names -- the service picks,
   * and it only ever adds people already marked as full members.
   */
  onSeedNudgeList: () => void;
  onOpenMember: (memberId: string) => void;
  filter: ProfileOverviewFilter;
  onFilterChange: (filter: ProfileOverviewFilter) => void;
};

/** Whether this row is short of the timeline target. Full members only -- see the contract. */
export function hasTimelineGap(row: MemberProfileOverviewRow): boolean {
  return (
    isAdminBotFullMember({ privilege_level: row.privilege_level }) &&
    row.timeline.total < adminBotTimelineEntryTarget
  );
}

/** The rows a filter shows. Exported so the page and its tests agree on one definition. */
export function filterOverviewRows(
  members: MemberProfileOverviewRow[],
  filter: ProfileOverviewFilter,
): MemberProfileOverviewRow[] {
  const search = filter.search.trim().toLocaleLowerCase();
  return members.filter((row) => {
    if (
      filter.membership === "full" &&
      !isAdminBotFullMember({ privilege_level: row.privilege_level })
    ) {
      return false;
    }
    if (search && !row.name.toLocaleLowerCase().includes(search)) {
      return false;
    }
    if (!matchesMemberTypeFilter(row.member_type, filter.memberTypes)) {
      return false;
    }
    if (filter.activity === "never" && row.last_login_at) {
      return false;
    }
    if (filter.activity === "signedIn" && !row.last_login_at) {
      return false;
    }
    switch (filter.gap) {
      case "profile":
        return row.missing_fields.length > 0;
      case "timeline":
        return hasTimelineGap(row);
      case "any":
        return row.missing_fields.length > 0 || hasTimelineGap(row);
      default:
        return true;
    }
  });
}

/** What the Remind button would send, given the filter. `all` chases both gaps, like `any`. */
export function remindScopeFor(
  members: MemberProfileOverviewRow[],
  filter: ProfileOverviewFilter,
): { include: "profile" | "timeline" | "both"; memberIds: string[] } {
  const include =
    filter.gap === "profile" ? "profile" : filter.gap === "timeline" ? "timeline" : "both";
  const memberIds = filterOverviewRows(members, {
    ...filter,
    gap: filter.gap === "all" ? "any" : filter.gap,
  })
    .filter((row) =>
      include === "profile"
        ? row.missing_fields.length > 0
        : include === "timeline"
          ? hasTimelineGap(row)
          : row.missing_fields.length > 0 || hasTimelineGap(row),
    )
    .map((row) => row.id);
  return { include, memberIds };
}

/**
 * Whether the filter is narrowing to a subset rather than asking about the whole roster.
 *
 * It decides what an empty table says. "Everyone is caught up" is a claim about the lab, and saying
 * it because somebody typed a name that matches nobody is simply false.
 */
function narrowedBySearch(filter: ProfileOverviewFilter): boolean {
  return Boolean(filter.search.trim()) || filter.activity !== "any";
}

function completionPercent(row: MemberProfileOverviewRow, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((row.filled_field_count / total) * 100);
}

/**
 * The plain-English name of a field, from its key.
 *
 * Derived rather than translated: these are the same keys the profile form uses, and a locale
 * table that had to be kept in step with the mandatory-field list would be one more thing to
 * forget when a field is added.
 */
function fieldLabel(key: string): string {
  return key
    .replace(/_url$/u, "")
    .replace(/_/gu, " ")
    .replace(/\burn\b/u, "URN")
    .replace(/^\w/u, (first) => first.toUpperCase());
}

function formatDay(instant: string | undefined): string {
  if (!instant) {
    return "";
  }
  const parsed = new Date(instant);
  return Number.isNaN(parsed.getTime())
    ? instant
    : parsed.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderProgressCell(row: MemberProfileOverviewRow, total: number) {
  const percent = completionPercent(row, total);
  const complete = row.missing_fields.length === 0;
  return html`
    <div class="profile-overview__progress" title=${`${row.filled_field_count}/${total}`}>
      <div
        class="profile-overview__bar ${complete ? "is-complete" : ""}"
        role="img"
        aria-label=${t("profileOverview.progressLabel", {
          filled: String(row.filled_field_count),
          total: String(total),
        })}
      >
        <span class="profile-overview__bar-fill" style="width: ${percent}%"></span>
      </div>
      <span class="profile-overview__percent ab-num">${percent}%</span>
    </div>
  `;
}

/**
 * The adoption cell: how much of this record its own member wrote.
 *
 * Deliberately next to the completeness bar rather than instead of it. The two disagreeing is the
 * whole signal -- a row that is 12/12 complete and 0/12 self-filled is somebody whose profile the
 * spreadsheet filled in and who has never been here, and that is not visible from either number
 * alone. "Never signed in" is called out in words because it is the strongest version of the same
 * finding and the one worth reading across a table at a glance.
 */
function renderAdoptionCell(row: MemberProfileOverviewRow, total: number) {
  const percent = total > 0 ? Math.round((row.self_filled_field_count / total) * 100) : 0;
  const neverSignedIn = !row.last_login_at;
  return html`
    <div
      class="profile-overview__adoption"
      title=${t("profileOverview.adoption.breakdown", {
        self: String(row.self_filled_field_count),
        total: String(total),
        filled: String(row.filled_field_count),
        lastLogin: row.last_login_at
          ? formatDay(row.last_login_at)
          : t("profileOverview.adoption.never"),
        lastSelfEdit: row.last_self_edit_at
          ? formatDay(row.last_self_edit_at)
          : t("profileOverview.adoption.never"),
        updated: row.updated_at ? formatDay(row.updated_at) : "—",
      })}
    >
      <span class="profile-overview__percent ab-num ${percent === 0 ? "is-zero" : ""}"
        >${percent}%</span
      >
      <span class="profile-overview__adoption-detail muted">
        ${t("profileOverview.adoption.projects", {
          done: String(row.projects.self_updated),
          total: String(row.projects.total),
        })}
      </span>
      ${neverSignedIn
        ? html`<span class="profile-overview__flag" data-testid="profile-overview-never-signed-in"
            >${t("profileOverview.adoption.neverSignedIn")}</span
          >`
        : nothing}
    </div>
  `;
}

/**
 * The activity cell: what this member has actually done.
 *
 * Next to the adoption cell for the same reason adoption sits next to completeness -- the pair
 * disagreeing is the signal. A member with 0% adoption and twenty sign-ins is somebody the
 * importer wrote over, not somebody who has never been here, and chasing them to "fill in your
 * profile" when they already have is how a roster sweep loses trust.
 *
 * Counts are floors: the audit trail is pruned on a rolling window, so activity older than that
 * is gone. The tooltip says so rather than letting a floor read as a total.
 */
function renderActivityCell(row: MemberProfileOverviewRow) {
  const activity = row.activity ?? NO_ACTIVITY;
  const silent = activity.logins + activity.profile_edits + activity.paper_updates === 0;
  return html`
    <div
      class="profile-overview__activity"
      data-testid="profile-overview-activity"
      title=${t("profileOverview.activity.breakdown", {
        logins: String(activity.logins),
        edits: String(activity.profile_edits),
        papers: String(activity.paper_updates),
        lastActive: activity.last_active_at
          ? formatDay(activity.last_active_at)
          : t("profileOverview.adoption.never"),
      })}
    >
      <span class="profile-overview__activity-counts ab-num ${silent ? "is-zero" : ""}">
        ${t("profileOverview.activity.counts", {
          logins: countOrDash(activity.logins),
          edits: countOrDash(activity.profile_edits),
          papers: countOrDash(activity.paper_updates),
        })}
      </span>
      ${activity.last_active_at
        ? html`<span class="profile-overview__activity-detail muted"
            >${t("profileOverview.activity.lastActive", {
              day: formatDay(activity.last_active_at),
            })}</span
          >`
        : nothing}
    </div>
  `;
}

/**
 * The one line at the top: what fraction of the lab's own record the lab's own members wrote.
 *
 * Over every field of every member rather than an average of per-member percentages, so one
 * brand-new member with a blank profile does not move the lab figure as much as somebody with a
 * full one -- see adoptionSummary service-side, which is where the arithmetic lives.
 */
function renderAdoptionSummary(adoption: MemberAdoptionSummary) {
  const pct = (rate: number) => `${Math.round(rate * 100)}%`;
  return html`
    <div class="profile-overview__adoption-summary" data-testid="profile-overview-adoption">
      <div>
        <span class="profile-overview__adoption-figure ab-num">${pct(adoption.profile_rate)}</span>
        <span class="muted">${t("profileOverview.adoption.summaryProfile")}</span>
      </div>
      <div>
        <span class="profile-overview__adoption-figure ab-num">${pct(adoption.project_rate)}</span>
        <span class="muted">${t("profileOverview.adoption.summaryProjects")}</span>
      </div>
      <div>
        <span class="profile-overview__adoption-figure ab-num"
          >${adoption.signed_in_ever}/${adoption.members}</span
        >
        <span class="muted">${t("profileOverview.adoption.summarySignedIn")}</span>
      </div>
      ${adoption.active_ever === undefined
        ? nothing
        : html`<div>
            <span
              class="profile-overview__adoption-figure ab-num"
              data-testid="profile-overview-active-ever"
              >${adoption.active_ever}/${adoption.members}</span
            >
            <span class="muted">${t("profileOverview.activity.summaryActive")}</span>
          </div>`}
    </div>
  `;
}

function renderMissingCell(row: MemberProfileOverviewRow) {
  if (!row.missing_fields.length) {
    return html`<span class="profile-overview__done">${t("profileOverview.allFilled")}</span>`;
  }
  return html`
    <ul class="profile-overview__missing">
      ${row.missing_fields.map((field) => html`<li>${fieldLabel(field)}</li>`)}
    </ul>
  `;
}

/**
 * The timeline column: the total, and what it is made of.
 *
 * The breakdown is in the tooltip rather than four more columns -- the number is what gets scanned,
 * and "which kind" only matters once somebody has stopped on a row.
 */
function renderTimelineCell(row: MemberProfileOverviewRow) {
  const short = row.timeline.total < adminBotTimelineEntryTarget;
  return html`
    <span
      class="profile-overview__timeline ${short ? "is-short" : ""}"
      title=${t("profileOverview.timelineBreakdown", {
        availability: String(row.timeline.availability),
        timeOff: String(row.timeline.time_off),
        milestones: String(row.timeline.milestones),
        trips: String(row.timeline.trips),
      })}
    >
      <span class="ab-num">${row.timeline.total}</span>
      ${short
        ? html`<span class="profile-overview__flag">${t("profileOverview.timelineShort")}</span>`
        : nothing}
    </span>
  `;
}

function renderRow(props: AdminBotProfileOverviewProps, row: MemberProfileOverviewRow) {
  return html`
    <tr class="profile-overview__row" data-complete=${row.missing_fields.length === 0}>
      <td class="profile-overview__cell">
        <button
          class="logistics-requests__open"
          type="button"
          @click=${() => props.onOpenMember(row.id)}
        >
          ${row.name}
        </button>
        ${row.status ? html`<span class="profile-overview__status">${row.status}</span>` : nothing}
      </td>
      <td class="profile-overview__cell">${renderProgressCell(row, props.mandatoryFieldCount)}</td>
      <td class="profile-overview__cell">${renderAdoptionCell(row, props.mandatoryFieldCount)}</td>
      <td class="profile-overview__cell">${renderActivityCell(row)}</td>
      <td class="profile-overview__cell profile-overview__cell--missing">
        ${renderMissingCell(row)}
      </td>
      <td class="profile-overview__cell">${renderTimelineCell(row)}</td>
      <td class="profile-overview__cell ab-num">
        ${row.last_reminded_at
          ? formatDay(row.last_reminded_at)
          : html`<span class="muted">${t("profileOverview.neverReminded")}</span>`}
      </td>
    </tr>
  `;
}

const GAP_OPTIONS: Array<{ value: ProfileOverviewGap; labelKey: string }> = [
  { value: "any", labelKey: "profileOverview.filters.any" },
  { value: "profile", labelKey: "profileOverview.filters.profile" },
  { value: "timeline", labelKey: "profileOverview.filters.timeline" },
  { value: "all", labelKey: "profileOverview.filters.all" },
];

const MEMBERSHIP_OPTIONS: Array<{ value: ProfileOverviewMembership; labelKey: string }> = [
  { value: "everyone", labelKey: "profileOverview.filters.everyone" },
  { value: "full", labelKey: "profileOverview.filters.fullMembers" },
];

const ACTIVITY_OPTIONS: Array<{ value: ProfileOverviewActivity; labelKey: string }> = [
  { value: "any", labelKey: "profileOverview.filters.anyActivity" },
  { value: "never", labelKey: "profileOverview.filters.neverSignedIn" },
  { value: "signedIn", labelKey: "profileOverview.filters.hasSignedIn" },
];

export function renderAdminBotProfileOverview(props: AdminBotProfileOverviewProps) {
  const rows = filterOverviewRows(props.members, props.filter);
  const scope = remindScopeFor(props.members, props.filter);
  const outstanding = scope.memberIds.length;
  return html`
    <section class="adminbot-shell profile-overview" data-testid="adminbot-profile-overview">
      <div class="card adminbot-card adminbot-card--wide">
        <div class="profile-overview__heading">
          <div>
            <div class="card-title">${t("profileOverview.title")}</div>
            <div class="card-sub">${t("profileOverview.sub")}</div>
          </div>
          <div class="profile-overview__actions">
            <!-- Two filters rather than one checkbox. The two gaps are chased with different
                 sentences and usually on different days -- a profile sweep before a report, a
                 timeline sweep before term planning -- and the membership filter is what makes
                 "full members who have not planned their term" a view rather than a squint. The
                 Remind button follows the filter, so the page and the message can never disagree
                 about who is being chased for what. -->
            <label class="profile-overview__filter">
              <span class="sr-only">${t("profileOverview.filters.searchLabel")}</span>
              <input
                class="input"
                type="search"
                data-testid="profile-overview-search"
                placeholder=${t("profileOverview.filters.searchPlaceholder")}
                .value=${props.filter.search}
                @input=${(event: Event) =>
                  props.onFilterChange({
                    ...props.filter,
                    search: (event.target as HTMLInputElement).value,
                  })}
              />
            </label>
            <label class="profile-overview__filter">
              <span class="sr-only">${t("profileOverview.filters.gapLabel")}</span>
              <select
                class="target__select"
                data-testid="profile-overview-filter-gap"
                @change=${(event: Event) =>
                  props.onFilterChange({
                    ...props.filter,
                    gap: (event.target as HTMLSelectElement).value as ProfileOverviewGap,
                  })}
              >
                ${GAP_OPTIONS.map(
                  (option) => html`
                    <option value=${option.value} ?selected=${option.value === props.filter.gap}>
                      ${t(option.labelKey)}
                    </option>
                  `,
                )}
              </select>
            </label>
            <label class="profile-overview__filter">
              <span class="sr-only">${t("profileOverview.filters.membershipLabel")}</span>
              <select
                class="target__select"
                data-testid="profile-overview-filter-membership"
                @change=${(event: Event) =>
                  props.onFilterChange({
                    ...props.filter,
                    membership: (event.target as HTMLSelectElement)
                      .value as ProfileOverviewMembership,
                  })}
              >
                ${MEMBERSHIP_OPTIONS.map(
                  (option) => html`
                    <option
                      value=${option.value}
                      ?selected=${option.value === props.filter.membership}
                    >
                      ${t(option.labelKey)}
                    </option>
                  `,
                )}
              </select>
            </label>
            <label class="profile-overview__filter">
              <span class="sr-only">${t("profileOverview.filters.activityLabel")}</span>
              <select
                class="target__select"
                data-testid="profile-overview-filter-activity"
                @change=${(event: Event) =>
                  props.onFilterChange({
                    ...props.filter,
                    activity: (event.target as HTMLSelectElement).value as ProfileOverviewActivity,
                  })}
              >
                ${ACTIVITY_OPTIONS.map(
                  (option) => html`
                    <option
                      value=${option.value}
                      ?selected=${option.value === props.filter.activity}
                    >
                      ${t(option.labelKey)}
                    </option>
                  `,
                )}
              </select>
            </label>
            ${renderMemberTypeFilter({
              selected: props.filter.memberTypes,
              onChange: (memberTypes) => props.onFilterChange({ ...props.filter, memberTypes }),
              testIdPrefix: "profile-overview",
              label: t("profileOverview.filters.memberTypeLabel"),
            })}
            <button
              class="btn btn--sm"
              type="button"
              data-testid="profile-overview-remind"
              ?disabled=${props.reminding || outstanding === 0}
              @click=${() => props.onRemind(scope)}
            >
              <span aria-hidden="true">${icons.send}</span>
              ${props.reminding
                ? t("profileOverview.reminding")
                : props.filter.gap === "timeline"
                  ? t("profileOverview.remindTimeline", { count: String(outstanding) })
                  : t("profileOverview.remind", { count: String(outstanding) })}
            </button>
            <!-- Next to the reminder button because it decides who that button can reach: nothing
                 goes to anybody who is not on the nudge list. -->
            <button
              class="btn btn--sm"
              type="button"
              data-testid="profile-overview-seed-nudge-list"
              title=${t("profileOverview.nudgeList.seedHint")}
              ?disabled=${props.reminding}
              @click=${() => props.onSeedNudgeList()}
            >
              ${t("profileOverview.nudgeList.seed")}
            </button>
          </div>
        </div>

        ${props.adoption ? renderAdoptionSummary(props.adoption) : nothing}
        ${props.notice
          ? html`<p class="profile-overview__notice" role="status">${props.notice}</p>`
          : nothing}
        ${props.error
          ? html`<p class="logistics-requests__error" role="alert">${props.error}</p>`
          : nothing}
        ${props.loading
          ? html`<p class="logistics-requests__empty">${t("profileOverview.loading")}</p>`
          : rows.length
            ? html`
                <div class="profile-overview__scroll">
                  <table class="profile-overview__table">
                    <thead>
                      <tr>
                        <th scope="col" class="profile-overview__head">
                          ${t("profileOverview.member")}
                        </th>
                        <th scope="col" class="profile-overview__head">
                          ${t("profileOverview.profile")}
                        </th>
                        <th scope="col" class="profile-overview__head">
                          ${t("profileOverview.adoption.column")}
                        </th>
                        <th scope="col" class="profile-overview__head">
                          ${t("profileOverview.activity.column")}
                        </th>
                        <th scope="col" class="profile-overview__head">
                          ${t("profileOverview.missing")}
                        </th>
                        <th scope="col" class="profile-overview__head">
                          ${t("profileOverview.timeline")}
                        </th>
                        <th scope="col" class="profile-overview__head">
                          ${t("profileOverview.lastReminded")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      ${rows.map((row) => renderRow(props, row))}
                    </tbody>
                  </table>
                </div>
              `
            : html`<p class="logistics-requests__empty">
                ${narrowedBySearch(props.filter)
                  ? t("profileOverview.noMatches")
                  : props.filter.gap === "all"
                    ? t("profileOverview.empty")
                    : t("profileOverview.allCaughtUp")}
              </p>`}
      </div>
    </section>
  `;
}
