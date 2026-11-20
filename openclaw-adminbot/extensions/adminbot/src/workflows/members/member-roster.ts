// Read model for the Lab Members table: filter/sort cached records before selecting one page.
import {
  adminBotIsAlumniMember,
  adminBotMemberTypes,
  adminBotMemberTypeTokens,
  type AdminBotLabMember,
  type AdminBotPaperRecord,
} from "../../contracts/actions.js";
import { parseAdminBotMemberRoles } from "../../contracts/member-roles.js";
import {
  memberRosterFilterKeys,
  type MemberRosterOptions,
  type MemberRosterQuery,
} from "../../contracts/member-roster.js";
import { holdsActiveChannels } from "./active-channel-audit.js";

function strings(value: unknown): string[] {
  return (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}
function note(notes: string | undefined, key: string): string {
  const found = (notes ?? "")
    .split("\n")
    .find((line) => line.split(":", 1)[0]?.trim().toLowerCase() === key.toLowerCase());
  return found?.slice(found.indexOf(":") + 1).trim() ?? "";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A joined month as a number that orders by time, or null when it does not name one.
 *
 * The field is free text, and the roster holds every way a month has been typed into a sheet:
 * "2026-01", "2025-01-01", "Jan-25", "25-Sep", "June 2025", "Sept 2024", a bare "2025". Compared
 * as strings those fall into separate runs -- digits first, then names by letter -- which is why
 * the end of the list read as alphabetical. A two-digit number beside a month name is the year:
 * this is a month field, and "26-Jun" was written by the same hands as "Jun-26".
 */
export function joinedMonthOrder(value: string | undefined): number | null {
  const text = (value ?? "").trim().toLowerCase();
  const iso = /^(\d{4})(?:-(\d{1,2}))?(?:-\d{1,2})?$/.exec(text);
  const named = /^([a-z]{3,})\.?[\s,-]+(\d{4}|\d{2})$/.exec(text);
  const reversed = /^(\d{4}|\d{2})[\s,-]+([a-z]{3,})\.?$/.exec(text);
  const year = Number(iso?.[1] ?? named?.[2] ?? reversed?.[1]);
  const month = iso
    ? Number(iso[2] ?? 1)
    : MONTHS.indexOf((named?.[1] ?? reversed?.[2] ?? "").slice(0, 3)) + 1;
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;
  return (year < 100 ? 2000 + year : year) * 12 + month;
}

/**
 * Whether someone counts as an active member: their Member Type holds the active channels
 * (`full`, `own-pace-advisee`, `coauthor-major` -- the same predicate the #jinesis-active sweep
 * uses) and they are not alumni, inactive or removed. A yes/no, because that is how the list is
 * read: the active pool first, everybody else after.
 */
export function memberRosterActive(member: AdminBotLabMember, status: string | undefined): boolean {
  return (
    holdsActiveChannels(member.member_type) &&
    !["alumni", "inactive", "removed"].includes(status ?? "")
  );
}

/** One linked paper as the Lab Members row draws it: a tag and the conference it counts under. */
export type MemberRosterPaper = { title: string; conference: string };

/**
 * Record fields the Lab Members table never draws, filters or searches on, dropped from each row.
 *
 * A page of 50 whole records ran to about 700 KB, most of it per-field provenance, CV snapshots,
 * onboarding checklists, schedules, trips and Slack channel lists. The table, its edit forms and
 * the global search read none of these; the one place that does (the self-edit card's schedule)
 * reads the signed-in member's own full record instead.
 */
export const memberRosterOmittedFields = [
  "field_provenance",
  "cv_snapshot",
  "slack_channels",
  "onboarding",
  "milestones",
  "availability",
  "time_off",
  "trips",
  "financial_support_needs",
  "dismissed_deadlines",
  "access",
  "access_overrides",
  "former_member_ids",
  "alternate_emails",
  "alternate_slack_user_ids",
  "city_channels_invited",
] as const;

type MemberRosterEntry = {
  row: AdminBotLabMember & { roster_papers?: MemberRosterPaper[] };
  facets: MemberRosterOptions;
  search: string;
};

/**
 * Everything about the roster that does not depend on the query: each row with its linked papers,
 * facets and search text, the whole-roster options, and the display order.
 *
 * Built from every member and every paper, so it is the expensive half. The service keeps it until
 * the members or papers tables change, and each request only filters and slices it. Shared between
 * requests: never edit what it holds.
 */
export type MemberRosterIndex = {
  entries: readonly MemberRosterEntry[];
  options: MemberRosterOptions;
};

function paperConference(paper: AdminBotPaperRecord): string {
  const a = (paper.artifacts ?? {}) as Record<string, string | undefined>;
  return (
    (
      a.conference ??
      a.conference_name ??
      a.venue ??
      a.target_venue ??
      (note(paper.notes, "Conference") || note(paper.notes, "Venue"))
    ).trim() || "Unspecified"
  );
}

export function buildMemberRosterIndex(
  members: readonly AdminBotLabMember[],
  papers: readonly AdminBotPaperRecord[],
): MemberRosterIndex {
  // Index author identities once, rather than scanning every paper for every member.
  const byAuthor = new Map<string, AdminBotPaperRecord[]>();
  for (const paper of papers) {
    for (const author of strings(paper.authors)) {
      const key = author.toLowerCase();
      const found = byAuthor.get(key) ?? [];
      found.push(paper);
      byAuthor.set(key, found);
    }
  }
  const options: MemberRosterOptions = {
    status: [],
    project: [],
    paper: [],
    conference: [],
    location: [],
    career: [],
    membership: [...adminBotMemberTypes],
  };
  const rows = members.map((member) => {
    const linked = [
      ...new Set(
        [member.id, member.name, member.email].flatMap(
          (value) => byAuthor.get(value?.toLowerCase() ?? "") ?? [],
        ),
      ),
    ];
    const rosterPapers = linked.map((p) => ({
      title: p.title,
      conference: paperConference(p),
    }));
    const row: MemberRosterEntry["row"] = {
      ...member,
      research_topics: strings(member.research_topics),
      projects: strings(member.projects),
      location: member.location?.trim() || note(member.notes, "Location"),
      joined_month: member.joined_month?.trim() || note(member.notes, "Joined month"),
      // The row's paper tags and count, so the table needs no lab-wide paper list of its own.
      ...(rosterPapers.length ? { roster_papers: rosterPapers } : {}),
    };
    for (const field of memberRosterOmittedFields) {
      delete (row as Record<string, unknown>)[field];
    }
    const facets: MemberRosterOptions = {
      status: [adminBotIsAlumniMember(member) ? "alumni" : (member.status ?? "active")],
      project: row.projects ?? [],
      paper: rosterPapers.map((p) => p.title),
      conference: rosterPapers.map((p) => p.conference),
      location: row.location ? [row.location] : [],
      career: parseAdminBotMemberRoles(member.role),
      membership: [
        ...new Set([
          ...adminBotMemberTypeTokens(member.member_type).filter(Boolean),
          ...(adminBotIsAlumniMember(member) ? ["alumni"] : []),
        ]),
      ],
    };
    for (const key of Object.keys(options) as (keyof MemberRosterOptions)[]) {
      options[key].push(...facets[key]);
    }
    const search = [
      row.name,
      row.email,
      row.role,
      row.affiliation,
      row.location,
      row.timezone,
      row.slack_user_id,
      row.joined_month,
      row.calendar_email,
      row.github_url,
      row.personal_website,
      ...(row.research_topics ?? []),
      ...facets.project,
      ...facets.paper,
      ...facets.conference,
    ]
      .join(" ")
      .toLocaleLowerCase();
    const joined = joinedMonthOrder(row.joined_month) ?? Infinity;
    return {
      entry: { row, facets, search },
      joined,
      // Only for rows with no readable joined month: when the record itself was created.
      added: (row.created_at ?? "").slice(0, 7),
      inactive: memberRosterActive(row, facets.status[0]) ? 0 : 1,
    };
  });
  for (const key of Object.keys(options) as (keyof MemberRosterOptions)[]) {
    options[key] = [...new Set(options[key])].toSorted();
  }
  // Active members first, then earliest joiner first: the list is read top-down to recommend
  // people for positions, and the active ones lean on that most, senior ones ahead. A month
  // nobody can read, or none at all, ends each group rather than being guessed into the middle,
  // in the order those records were created -- the same rule the PeopleList sheet export uses.
  // Sorting here once keeps every filtered page in the same order, since filtering preserves it.
  const entries = rows
    .toSorted(
      (a, b) =>
        a.inactive - b.inactive ||
        (a.joined === b.joined ? 0 : a.joined < b.joined ? -1 : 1) ||
        (a.joined === Infinity ? a.added.localeCompare(b.added) : 0) ||
        a.entry.row.id.localeCompare(b.entry.row.id),
    )
    .map(({ entry }) => entry);
  return { entries, options };
}

/** The per-request half: apply the filters to a built index and cut out one page. */
export function selectMemberRosterPage(
  index: MemberRosterIndex,
  query: MemberRosterQuery,
  meetingMembers?: ReadonlySet<string>,
) {
  const { options } = index;
  const filters = { ...query.filters };
  // A deleted option resets that selection; options themselves never shrink with the current filter.
  for (const key of Object.keys(options) as (keyof MemberRosterOptions)[]) {
    if (filters[key] && !options[key].includes(filters[key]!)) {
      delete filters[key];
    }
  }
  const needle = filters.q?.trim().toLocaleLowerCase();
  const matched = index.entries.filter(({ row, facets, search }) =>
    memberRosterFilterKeys.every((key) => {
      const value = filters[key];
      return (
        !value ||
        (key === "q"
          ? search.includes(needle ?? "")
          : key === "meeting"
            ? meetingMembers?.has(row.id)
            : facets[key].includes(value))
      );
    }),
  );
  const offset = Math.min(
    query.offset,
    Math.max(0, Math.ceil(matched.length / query.limit) - 1) * query.limit,
  );
  return {
    members: matched.slice(offset, offset + query.limit).map(({ row }) => row),
    total: matched.length,
    limit: query.limit,
    offset,
    filters,
    options,
  };
}

export function memberRosterPage(
  members: readonly AdminBotLabMember[],
  papers: readonly AdminBotPaperRecord[],
  query: MemberRosterQuery,
  meetingMembers?: ReadonlySet<string>,
) {
  return selectMemberRosterPage(buildMemberRosterIndex(members, papers), query, meetingMembers);
}
