import type { AdminBotMemberProfileOverviewRow } from "../../contracts/actions.js";

/**
 * A Lab Overview row as GET /members/profile-overview sends it: the counts that are not zero.
 *
 * The page lists every member, and in a large lab most rows are people who have never signed in --
 * a row of zeroed counters, an empty gap list and the default privilege, repeated a thousand times.
 * The client already fills each of these in when absent (it has to, since an older service does
 * not send them), so leaving out a value that equals that fill-in draws the same row. A counter
 * group is dropped only when every number in it is zero, so a row never mixes sent and filled
 * parts of one group.
 */
export type AdminBotProfileOverviewWireRow = Partial<AdminBotMemberProfileOverviewRow> &
  Pick<AdminBotMemberProfileOverviewRow, "id" | "name">;

function allZero(counts: object): boolean {
  return Object.values(counts).every((value) => value === 0);
}

export function profileOverviewWireRow(
  row: AdminBotMemberProfileOverviewRow,
): AdminBotProfileOverviewWireRow {
  const {
    privilege_level,
    missing_fields,
    filled_field_count,
    self_filled_field_count,
    projects,
    timeline,
    activity,
    ...rest
  } = row;
  return {
    ...rest,
    ...(privilege_level !== "member" ? { privilege_level } : {}),
    ...(missing_fields.length ? { missing_fields } : {}),
    ...(filled_field_count ? { filled_field_count } : {}),
    ...(self_filled_field_count ? { self_filled_field_count } : {}),
    ...(allZero(projects) ? {} : { projects }),
    ...(allZero(timeline) ? {} : { timeline }),
    // `last_active_at` is a string, so a member with a stamp is never "all zero".
    ...(allZero(activity) ? {} : { activity }),
  };
}
