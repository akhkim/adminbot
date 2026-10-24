// The shared roster row: what GET /lab/members?view=summary sends for each member.
//
// The summary is the roster every list cell and picker in the console reads, so it carries only
// what those cells show and the small flags their filters test. Everything else -- schedules,
// links, prose, provenance -- is read for one member when a view opens it
// (GET /lab/members/:id/detail), and the caller's own full record travels beside the rows as `self`.
//
// A whitelist rather than a list of things to drop: a field added to the record later stays out of
// a 200-member payload until a reader asks for it. It runs after redaction, so it can only ever
// narrow what the viewer was already entitled to.

/** Bumped whenever the row's shape changes, so a cached 304 never answers with the old shape. */
export const MEMBER_SUMMARY_PROJECTION = "summary-row.2";

// Every viewer: names and addresses for pickers and coauthor mail, the type flags the nudge and
// alumni checks read, the credit dropdown's handle and affiliation, and badges for the badge views.
const PEER_ROW_FIELDS = [
  "id",
  "name",
  "email",
  "correspondence_email",
  "slack_user_id",
  "privilege_level",
  "member_type",
  "status",
  "twitter_url",
  "affiliation",
  "assigned_badges",
] as const;

// Admins also plan with the roster: the Calendar tab places and invites people (addresses, cities,
// time zones, trips, sign-in location), and Announcements filters and searches recipients.
const ADMIN_ROW_FIELDS = [
  ...PEER_ROW_FIELDS,
  "calendar_email",
  "research_branch",
  "research_topics",
  "projects",
  "onboarding",
  "timezone",
  "location",
  "current_city",
  "slack_location",
  "last_login_at",
  "last_login_city",
  "last_login_timezone",
  "trips",
] as const;

// Absent reads as this value; the console fills it back in when the roster loads.
const DEFAULT_PRIVILEGE_LEVEL = "member";

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

// Announcements' "not joined" shortcut asks only whether a step is complete, so a row carries its
// completed step ids and nothing else of the checklist.
function completedOnboarding(
  value: unknown,
): { steps: { id: string; status: "complete" }[] } | null {
  const steps = (value as { steps?: unknown } | null | undefined)?.steps;
  if (!Array.isArray(steps)) {
    return null;
  }
  const complete = steps.flatMap((step) => {
    const { id, status } = (step ?? {}) as { id?: unknown; status?: unknown };
    return typeof id === "string" && status === "complete"
      ? [{ id, status: "complete" as const }]
      : [];
  });
  return complete.length ? { steps: complete } : null;
}

/** One member as the shared roster sends it: role-scoped, and without null, empty or default fields. */
export function memberSummaryRow(
  member: Record<string, unknown>,
  viewer: { isAdmin: boolean },
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const field of viewer.isAdmin ? ADMIN_ROW_FIELDS : PEER_ROW_FIELDS) {
    const value = field === "onboarding" ? completedOnboarding(member[field]) : member[field];
    if (isEmpty(value) || (field === "privilege_level" && value === DEFAULT_PRIVILEGE_LEVEL)) {
      continue;
    }
    row[field] = value;
  }
  return row;
}
