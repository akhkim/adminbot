// How much of the lab's own record the lab's own members actually wrote.
//
// The roster looks healthier than it is. Most of it was merged in from the spreadsheet in one pass,
// which means "profile 12/12 complete" and "this person has never opened AdminBot" are the same row
// as far as completeness is concerned. Chasing off that number chases the wrong people: the ones
// with gaps are often the ones who have been here and stopped, and the ones who look finished are
// often the ones who have never arrived.
//
// So adoption is measured against provenance, not against emptiness. A field counts toward adoption
// only when a *member* wrote it -- not an admin correcting it for them, not the importer. Two
// deliberate conservatisms:
//
//   - A field with no provenance entry at all counts as not-self. Everything written before this
//     existed is in that state, so adoption starts low and climbs as people touch their profiles,
//     rather than starting high and being wrong.
//   - Only a *change* stamps. Re-saving a form without editing anything, or an importer merging in
//     the value that is already there, leaves the existing stamp alone -- so a nightly sync cannot
//     launder imported data into member-authored data.
import type {
  AdminBotFieldProvenance,
  AdminBotFieldSource,
  AdminBotLabMember,
} from "../../contracts/actions.js";
import type { AdminBotPaperWeeklyUpdate } from "../../contracts/paper-weekly-updates.js";

/**
 * The provenance map after a write, given what was already stored and what is being stored.
 *
 * Compared by serialized value rather than by identity: several of these fields are arrays and
 * objects (`research_topics`, `availability`, `trips`), and every patch rebuilds them, so reference
 * equality would stamp every field on every save and make the whole thing meaningless.
 */
export function stampFieldProvenance(params: {
  existing: AdminBotLabMember | undefined;
  next: Record<string, unknown>;
  source: AdminBotFieldSource;
  at: string;
  actor?: string;
}): Record<string, AdminBotFieldProvenance> {
  const provenance = { ...params.existing?.field_provenance };
  for (const [field, value] of Object.entries(params.next)) {
    if (SKIP_FIELDS.has(field)) {
      continue;
    }
    // `undefined` in a patch means "not sent", never "clear this". Callers that rebuild the whole
    // record and drop a field on purpose -- updateOwnProfile does exactly that with `availability`,
    // so the stored value survives -- would otherwise have that field stamped as changed by them.
    // Clearing is done with "" or [], both of which are values and do stamp.
    if (value === undefined) {
      continue;
    }
    if (sameValue((params.existing as Record<string, unknown> | undefined)?.[field], value)) {
      continue;
    }
    provenance[field] = {
      source: params.source,
      at: params.at,
      ...(params.actor ? { actor: params.actor } : {}),
    };
  }
  return provenance;
}

// Fields the service stamps on every write regardless of who asked, so they say nothing about who
// filled the record in. Provenance for them would be noise that makes every save look like an edit.
const SKIP_FIELDS = new Set([
  "id",
  "created_at",
  "updated_at",
  "access",
  "onboarding",
  "field_provenance",
  "availability_updated_at",
  "last_login_at",
  "last_login_country",
  "last_login_continent",
  "last_login_city",
  "last_login_timezone",
  "slack_location",
  "slack_location_updated_at",
  "slack_messages_7d",
  "slack_activity_checked_at",
  "profile_photo_review",
  "cv_snapshot",
]);

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  // Both absent, however they are absent: a patch that sends `undefined` for a field the record
  // does not have is not a change.
  if (left == null && right == null) {
    return true;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** Whether this member wrote this field themselves. Unknown provenance is not self. */
export function isSelfFilled(member: AdminBotLabMember, field: string): boolean {
  return member.field_provenance?.[field]?.source === "member";
}

/**
 * How many of `fields` the member both filled in and filled in themselves.
 *
 * Both conditions, not just provenance: a member who typed a value and then cleared it has a stamp
 * on an empty field, and an empty field is not adoption of anything.
 */
export function selfFilledFieldCount(member: AdminBotLabMember, fields: readonly string[]): number {
  return fields.filter((field) => {
    if (!isSelfFilled(member, field)) {
      return false;
    }
    const value = (member as Record<string, unknown>)[field];
    if (Array.isArray(value)) {
      return value.some(Boolean);
    }
    return value !== undefined && value !== null && String(value).trim() !== "";
  }).length;
}

/** When this member last changed anything about themselves, across every field. */
export function lastSelfEditAt(member: AdminBotLabMember): string | undefined {
  let latest: string | undefined;
  for (const entry of Object.values(member.field_provenance ?? {})) {
    if (entry.source === "member" && (!latest || entry.at > latest)) {
      latest = entry.at;
    }
  }
  return latest;
}

/**
 * The My Projects & Papers half of adoption: papers the member is on, and how many of those they
 * have written a weekly update on themselves.
 *
 * The weekly update is the right signal because it is the one thing on that page only the author
 * can supply. A paper's title, venue and step are all things an admin files; "what I did on this
 * last week" is not, so a paper with no update from its own author is a paper nobody has adopted.
 */
export function projectAdoption(params: {
  memberId: string;
  paperIds: readonly string[];
  updates: readonly AdminBotPaperWeeklyUpdate[];
}): { total: number; self_updated: number } {
  const own = new Set(
    params.updates
      .filter((update) => update.member_id === params.memberId && update.body.trim())
      .map((update) => update.paper_id),
  );
  return {
    total: params.paperIds.length,
    self_updated: params.paperIds.filter((paperId) => own.has(paperId)).length,
  };
}

/**
 * The lab-wide numbers, for the one line at the top of the Profile Overview page.
 *
 * Two rates rather than one average of averages: "what fraction of all the mandatory fields across
 * the lab were filled in by their own member" is the number that moves when somebody opens their
 * profile, and "how many members have signed in at all" is the number that says whether the tool
 * has landed. Averaging per-member percentages would let one brand-new member with a blank profile
 * swing the lab's figure as hard as a member with forty fields.
 */
export function adoptionSummary(
  rows: ReadonlyArray<{
    self_filled_field_count: number;
    last_login_at?: string;
    projects: { total: number; self_updated: number };
  }>,
  fieldsPerMember: number,
): {
  members: number;
  /** 0..1. Zero members is 0, not NaN -- this renders as a percentage. */
  profile_rate: number;
  project_rate: number;
  signed_in_ever: number;
} {
  const denominator = rows.length * fieldsPerMember;
  const projectTotal = rows.reduce((sum, row) => sum + row.projects.total, 0);
  return {
    members: rows.length,
    profile_rate: denominator
      ? rows.reduce((sum, row) => sum + row.self_filled_field_count, 0) / denominator
      : 0,
    project_rate: projectTotal
      ? rows.reduce((sum, row) => sum + row.projects.self_updated, 0) / projectTotal
      : 0,
    signed_in_ever: rows.filter((row) => row.last_login_at).length,
  };
}

/** The shape `upsertLabMember` takes to say who is writing. Absent means the importer. */
export type AdminBotWriteOrigin = { source?: AdminBotFieldSource; actor?: string };

/** Narrowing helper so a route can hand through a value it read off a request. */
export function asFieldSource(value: unknown): AdminBotFieldSource | undefined {
  return value === "member" || value === "admin" || value === "import" ? value : undefined;
}
