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

export function memberRosterPage(
  members: readonly AdminBotLabMember[],
  papers: readonly AdminBotPaperRecord[],
  query: MemberRosterQuery,
  meetingMembers?: ReadonlySet<string>,
) {
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
    const row = {
      ...member,
      research_topics: strings(member.research_topics),
      projects: strings(member.projects),
      location: member.location?.trim() || note(member.notes, "Location"),
      joined_month: member.joined_month?.trim() || note(member.notes, "Joined month"),
    };
    const linked = [
      ...new Set(
        [member.id, member.name, member.email].flatMap(
          (value) => byAuthor.get(value?.toLowerCase() ?? "") ?? [],
        ),
      ),
    ];
    const facets: MemberRosterOptions = {
      status: [adminBotIsAlumniMember(member) ? "alumni" : (member.status ?? "active")],
      project: row.projects ?? [],
      paper: linked.map((p) => p.title),
      conference: linked.map((p) => {
        const a = (p.artifacts ?? {}) as Record<string, string | undefined>;
        return (
          (
            a.conference ??
            a.conference_name ??
            a.venue ??
            a.target_venue ??
            (note(p.notes, "Conference") || note(p.notes, "Venue"))
          ).trim() || "Unspecified"
        );
      }),
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
    return { row, facets, search };
  });
  for (const key of Object.keys(options) as (keyof MemberRosterOptions)[]) {
    options[key] = [...new Set(options[key])].toSorted();
  }
  const filters = { ...query.filters };
  // A deleted option resets that selection; options themselves never shrink with the current filter.
  for (const key of Object.keys(options) as (keyof MemberRosterOptions)[]) {
    if (filters[key] && !options[key].includes(filters[key]!)) {
      delete filters[key];
    }
  }
  const matched = rows
    .filter(({ row, facets, search }) =>
      memberRosterFilterKeys.every((key) => {
        const value = filters[key];
        return (
          !value ||
          (key === "q"
            ? search.includes(value.trim().toLocaleLowerCase())
            : key === "meeting"
              ? meetingMembers?.has(row.id)
              : facets[key].includes(value))
        );
      }),
    )
    .toSorted(
      (a, b) =>
        (a.row.joined_month || "9999").localeCompare(b.row.joined_month || "9999") ||
        a.row.id.localeCompare(b.row.id),
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
