// Which Lab Overview rows a filter shows, and who the Remind button and My Desk count -- one
// definition for both sides.
//
// The page used to download every member and filter in the browser. Now the service pages it, so
// the filter has to run before the page is cut: a search for a name must find somebody who is not
// on the first page, and the Remind button's count has to be over the whole filtered roster rather
// than the twenty rows on screen. The browser still imports these for its types and its tests, and
// because it is the same function, the page and the message can never disagree about who is meant.
//
// Browser-safe: imports nothing that reaches node.
import {
  adminBotIsAlumniMember,
  adminBotTimelineEntryTarget,
  isAdminBotFullMember,
} from "../../contracts/actions.js";

/** What the filter reads off a row. The service's row and the browser's filled-in row both fit. */
export type ProfileOverviewFilterRow = {
  id: string;
  name: string;
  status?: string;
  member_type?: string;
  privilege_level?: string;
  last_login_at?: string;
  missing_fields: readonly string[];
  timeline: { total: number };
  projects: { total: number; self_updated: number };
};

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

export type ProfileReminderInclude = "profile" | "timeline" | "both";

/**
 * One member's types as a set.
 *
 * The column holds a comma-separated list, because people are genuinely more than one thing --
 * "alumni, coauthor-major" is somebody who left and still writes with the lab. Splitting rather
 * than substring-matching is what keeps "coauthor-major" from also matching "coauthor-minor"
 * on a row that carries both.
 */
export function memberTypeTokens(memberType: string | undefined): Set<string> {
  return new Set(
    (memberType ?? "")
      .split(",")
      .map((entry) => entry.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
}

/**
 * Whether a row survives the member-type filter.
 *
 * An empty selection shows everyone. That is the important case: the filter is off by default, and
 * a filter whose "nothing ticked" state hid the whole table would read as a broken page rather
 * than as an unset control. Ticking more than one is a union -- "alumni or major coauthor" --
 * because these are labels a person holds, not a hierarchy to intersect.
 */
export function matchesMemberTypeFilter(
  memberType: string | undefined,
  selected: readonly string[],
): boolean {
  if (selected.length === 0) {
    return true;
  }
  const tokens = memberTypeTokens(memberType);
  return selected.some((value) => tokens.has(value));
}

/** Whether this row is short of the timeline target. Full members only -- see the contract. */
export function hasTimelineGap(row: ProfileOverviewFilterRow): boolean {
  return (
    isAdminBotFullMember({ privilege_level: row.privilege_level }) &&
    row.timeline.total < adminBotTimelineEntryTarget
  );
}

/** The rows a filter shows, in the order they came in. */
export function filterOverviewRows<T extends ProfileOverviewFilterRow>(
  members: readonly T[],
  filter: ProfileOverviewFilter,
): T[] {
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
  members: readonly ProfileOverviewFilterRow[],
  filter: ProfileOverviewFilter,
): { include: ProfileReminderInclude; memberIds: string[] } {
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

const GAPS = new Set<string>(["any", "profile", "timeline", "all"]);
const MEMBERSHIPS = new Set<string>(["everyone", "full"]);
const ACTIVITIES = new Set<string>(["any", "never", "signedIn"]);

/**
 * The filter as a query string carries it: `gap`, `membership`, `q`, `activity` and a
 * comma-separated `member_types`. Absent means the page's default; an unknown value is "invalid",
 * so a typo is a 400 rather than a quietly different list.
 */
export function readProfileOverviewFilter(
  params: URLSearchParams,
): ProfileOverviewFilter | "invalid" {
  const gap = params.get("gap") ?? EMPTY_PROFILE_OVERVIEW_FILTER.gap;
  const membership = params.get("membership") ?? EMPTY_PROFILE_OVERVIEW_FILTER.membership;
  const activity = params.get("activity") ?? EMPTY_PROFILE_OVERVIEW_FILTER.activity;
  const search = params.get("q")?.trim() ?? "";
  const memberTypes = [...memberTypeTokens(params.get("member_types") ?? "")];
  if (
    !GAPS.has(gap) ||
    !MEMBERSHIPS.has(membership) ||
    !ACTIVITIES.has(activity) ||
    search.length > 120 ||
    memberTypes.length > 20
  ) {
    return "invalid";
  }
  return {
    gap: gap as ProfileOverviewGap,
    membership: membership as ProfileOverviewMembership,
    search,
    activity: activity as ProfileOverviewActivity,
    memberTypes,
  };
}

/** The other half: what the browser puts on the URL. Defaults are left off so the URL stays short. */
export function profileOverviewFilterParams(filter: ProfileOverviewFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.gap !== EMPTY_PROFILE_OVERVIEW_FILTER.gap) {
    params.set("gap", filter.gap);
  }
  if (filter.membership !== EMPTY_PROFILE_OVERVIEW_FILTER.membership) {
    params.set("membership", filter.membership);
  }
  if (filter.search.trim()) {
    params.set("q", filter.search.trim());
  }
  if (filter.activity !== EMPTY_PROFILE_OVERVIEW_FILTER.activity) {
    params.set("activity", filter.activity);
  }
  if (filter.memberTypes.length) {
    params.set("member_types", filter.memberTypes.join(","));
  }
  return params;
}

// --- My Desk's adoption columns ---

/**
 * Who is still on the hook for using AdminBot themselves.
 *
 * Alumni are out of every adoption column: they have left, so a row of theirs that stays blank is
 * not a reminder anybody is going to send. Everyone else stays, external collaborators included --
 * the lab does chase them, and dropping them would quietly shrink the count this section exists to
 * show.
 *
 * Asked through `adminBotIsAlumniMember`, which reads `member_type` as well as `status`. Testing
 * `status` alone let 22 of the lab's 24 alumni back into the list: the roster was imported from a
 * spreadsheet that spells it in the type, and those 22 carry no status at all.
 */
export function adoptionCandidates<T extends ProfileOverviewFilterRow>(
  profiles: readonly T[],
): T[] {
  return profiles.filter((row) => !adminBotIsAlumniMember(row));
}

/** Members with mandatory profile fields still blank, emptiest record first. */
export function incompleteProfiles<T extends ProfileOverviewFilterRow>(
  profiles: readonly T[],
): T[] {
  return adoptionCandidates(profiles)
    .filter((row) => row.missing_fields.length > 0)
    .toSorted((left, right) => right.missing_fields.length - left.missing_fields.length);
}

/** Members whose timeline is thinner than the lab asks for. The list Time Availability is for. */
export function thinTimelines<T extends ProfileOverviewFilterRow>(profiles: readonly T[]): T[] {
  return adoptionCandidates(profiles)
    .filter((row) => row.timeline.total < adminBotTimelineEntryTarget)
    .toSorted((left, right) => left.timeline.total - right.timeline.total);
}

/**
 * Members with a paper carrying no update they wrote themselves.
 *
 * Somebody with no papers at all is not behind on anything, so they are not in this column.
 */
export function unattendedProjects<T extends ProfileOverviewFilterRow>(
  profiles: readonly T[],
): T[] {
  const behind = (row: T) => row.projects.total - row.projects.self_updated;
  return adoptionCandidates(profiles)
    .filter((row) => row.projects.total > 0 && behind(row) > 0)
    .toSorted((left, right) => behind(right) - behind(left));
}

/** How long each desk column is over the whole roster, and how many people that is in all. */
export type DeskAdoptionCounts = {
  profile: number;
  timeline: number;
  papers: number;
  /** Somebody short on two counts is one person to remind, so this is not the sum. */
  people: number;
};

/**
 * What My Desk needs from the roster: the head of each column, and each column's true length.
 *
 * The desk draws at most `limit` rows a column, so it is sent each column's first `limit` and no
 * more -- as one list in roster order, since a member short on two counts would otherwise travel
 * twice. Re-running the column functions over that list gives back the same heads: every row of a
 * column's true head is in it, and anything else it holds sorts after them. The counts are taken
 * here, over everybody, because the heads cannot say how long the columns are.
 */
export function deskAdoption<T extends ProfileOverviewFilterRow>(
  profiles: readonly T[],
  limit: number,
): { members: T[]; counts: DeskAdoptionCounts } {
  const columns = [incompleteProfiles, thinTimelines, unattendedProjects].map((column) =>
    column(profiles),
  );
  const people = new Set(columns.flatMap((rows) => rows.map((row) => row.id)));
  const heads = new Set(columns.flatMap((rows) => rows.slice(0, limit).map((row) => row.id)));
  const [profile, timeline, papers] = columns;
  return {
    members: profiles.filter((row) => heads.has(row.id)),
    counts: {
      profile: profile.length,
      timeline: timeline.length,
      papers: papers.length,
      people: people.size,
    },
  };
}
