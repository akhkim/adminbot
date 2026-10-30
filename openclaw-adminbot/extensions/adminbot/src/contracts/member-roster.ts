/** Filters for the paginated Lab Members table. Options always describe the whole roster. */
export const memberRosterFilterKeys = [
  "q",
  "status",
  "project",
  "paper",
  "conference",
  "location",
  "career",
  "membership",
  "meeting",
] as const;
export type MemberRosterFilters = Partial<Record<(typeof memberRosterFilterKeys)[number], string>>;
export type MemberRosterOptions = Record<
  Exclude<(typeof memberRosterFilterKeys)[number], "q" | "meeting">,
  string[]
>;
export type MemberRosterQuery = { limit: number; offset: number; filters: MemberRosterFilters };
