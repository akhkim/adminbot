// The lab records the topbar search (command palette) can jump to: members, papers and projects.
//
// Built from what the dashboard already holds (`adminBotData`), so opening the palette never waits
// on a read. Each item carries the text an admin is likely to type -- an email, an alias, a venue, a
// research topic -- as `keywords`, which match without cluttering the row.
//
// Output order matters: the palette numbers rows in list order and draws them grouped by category,
// so every member comes before every paper, and every paper before every project.
import type { PaletteItem } from "../views/command-palette.ts";
import type { AdminBotLabMember, AdminBotPaperRecord } from "./controllers/admin.ts";

function join(parts: Array<string | null | undefined>, separator = " "): string {
  return parts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(separator);
}

function list(value: unknown): string[] {
  return (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildGlobalSearchRecords(data: {
  members?: readonly AdminBotLabMember[];
  papers?: readonly AdminBotPaperRecord[];
}): PaletteItem[] {
  const members = data.members ?? [];
  const papers = data.papers ?? [];

  const memberItems: PaletteItem[] = members
    .filter((member) => member.name?.trim())
    .map(
      (member): PaletteItem => ({
        id: `member:${member.id}`,
        label: member.name.trim(),
        icon: "user",
        category: "members",
        action: `record:member:${member.id}`,
        description: join([member.role, list(member.projects).join(", ")], " · ") || undefined,
        keywords: join([
          member.id,
          member.email,
          member.correspondence_email,
          member.member_type,
          member.affiliation,
          member.location,
          ...list(member.research_topics),
        ]),
      }),
    )
    .toSorted((a, b) => a.label.localeCompare(b.label));

  const paperItems: PaletteItem[] = papers
    .filter((paper) => paper.title?.trim())
    .map(
      (paper): PaletteItem => ({
        id: `paper:${paper.id}`,
        label: paper.title.trim(),
        icon: "fileText",
        category: "papers",
        action: `record:paper:${paper.id}`,
        description:
          join([paper.accepted_venue || paper.venue, paper.authors?.[0]], " · ") || undefined,
        keywords: join([paper.id, paper.alias, ...(paper.authors ?? [])]),
      }),
    )
    .toSorted((a, b) => a.label.localeCompare(b.label));

  // A project is a paper's alias (its `proj-<alias>` channel) or a name on a member's project
  // list. Aliases open the paper's project page; a free-text project opens the members filtered
  // to it, since there is no page of its own to land on.
  const projects = new Map<string, PaletteItem>();
  for (const paper of papers) {
    const alias = paper.alias?.trim();
    if (!alias || projects.has(alias.toLowerCase())) continue;
    projects.set(alias.toLowerCase(), {
      id: `project:${paper.id}`,
      label: alias,
      icon: "folder",
      category: "projects",
      action: `record:paper:${paper.id}`,
      description: paper.title?.trim() || undefined,
    });
  }
  for (const member of members) {
    for (const name of list(member.projects)) {
      const key = name.toLowerCase();
      const existing = projects.get(key);
      if (existing) {
        existing.keywords = join([existing.keywords, member.name]);
        continue;
      }
      projects.set(key, {
        id: `project:${name}`,
        label: name,
        icon: "folder",
        category: "projects",
        action: `record:project:${name}`,
        keywords: member.name,
      });
    }
  }
  const projectItems = [...projects.values()].toSorted((a, b) => a.label.localeCompare(b.label));

  return [...memberItems, ...paperItems, ...projectItems];
}
