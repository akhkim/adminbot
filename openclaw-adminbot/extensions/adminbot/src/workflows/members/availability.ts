// Reading a member's recorded schedule: what they are committed to, and when they are away.
//
// The schedule itself is stored structure, not text: `availability` rows carry a date range,
// hours per week, and an optional project, and `time_off` rows carry a range plus whether the
// member is fully or partly away (see contracts.ts). Members edit those rows themselves, and the
// Drive importer prefills them. This module holds the questions the rest of the service asks of
// that structure, so the answers cannot drift between the console, the Control UI, and the
// reviewing-cycle automation.

import type {
  AdminBotLabMember,
  AdminBotMemberTrip,
  AdminBotTimeOffRow,
} from "../../contracts/actions.js";

function covers(row: { start?: string; end?: string }, dayIso: string): boolean {
  const start = row.start ?? "";
  const end = row.end ?? "";
  return start !== "" && end !== "" && start <= dayIso && end >= dayIso;
}

// The time-off entry that has the member fully away on `dayIso`, if any. "Partly away" is not
// away: they are still around, just with less time, so only a complete absence answers here —
// which is what gates someone out of emergency-reviewer suggestions.
export function fullyAwayOn(
  member: Pick<AdminBotLabMember, "time_off">,
  dayIso: string,
): AdminBotTimeOffRow | undefined {
  return (member.time_off ?? []).find(
    (row) => row.availability !== "partial" && covers(row, dayIso),
  );
}

/**
 * The trip the member is on for `dayIso`, if any.
 *
 * The last matching row wins where two overlap. Overlapping trips are a data-entry slip rather than
 * a meaningful state -- nobody is in two cities -- and taking the most recently added one means a
 * correction typed today beats a stale row without the member having to find and delete it first.
 */
export function tripOn(
  member: Pick<AdminBotLabMember, "trips">,
  dayIso: string,
): AdminBotMemberTrip | undefined {
  return (member.trips ?? []).findLast((row) => covers(row, dayIso));
}
