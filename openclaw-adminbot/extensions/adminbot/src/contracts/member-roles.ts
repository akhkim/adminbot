// How a member's roles are stored and read back.
//
// Its own module rather than more of actions.ts, which is already 460 lines past the max-lines cap
// (ADR-0006) and is the file both the service and the Control UI import from most.
import { adminBotMemberRoles } from "./actions.js";

/**
 * A member may hold more than one role at once, and the record keeps them in one string.
 *
 * People in this lab are routinely two things -- a PhD student who is also the lab manager, a
 * research assistant finishing a master's -- and a single-choice dropdown made each of them pick
 * which half of their answer to throw away. The column stays one free-text field (158 imported
 * profiles predate the vocabulary entirely), so the several roles are joined rather than migrated
 * to an array: nothing that already reads `member.role` for display has to change, and the value
 * still reads correctly in a spreadsheet cell and in an email.
 *
 * ", " and not "/" or ";" because it is what the existing rows and the reports already use, and
 * because no entry in the vocabulary contains a comma -- which is what makes the split lossless.
 */
export const ADMINBOT_MEMBER_ROLE_SEPARATOR = ", ";

/** The roles held, split out of the stored string. Order is preserved; blanks and repeats are not. */
export function parseAdminBotMemberRoles(value: string | null | undefined): string[] {
  if (typeof value !== "string") {
    return [];
  }
  const seen = new Set<string>();
  const roles: string[] = [];
  for (const part of value.split(",")) {
    const role = part.trim();
    if (!role || seen.has(role.toLowerCase())) {
      continue;
    }
    seen.add(role.toLowerCase());
    roles.push(role);
  }
  return roles;
}

/** The stored string for a set of roles, in the vocabulary's own order rather than click order. */
export function formatAdminBotMemberRoles(roles: readonly string[]): string {
  const held = new Set(roles.map((role) => role.trim().toLowerCase()).filter(Boolean));
  const known = adminBotMemberRoles.filter((role) => held.has(role.toLowerCase()));
  // Anything outside the vocabulary keeps its own spelling and goes last: an imported "PhD Mentee /
  // MSc" is a real answer, and dropping it here would quietly rewrite the roster.
  const unknown = roles
    .map((role) => role.trim())
    .filter(
      (role) =>
        role && !adminBotMemberRoles.some((entry) => entry.toLowerCase() === role.toLowerCase()),
    );
  return [...known, ...new Set(unknown)].join(ADMINBOT_MEMBER_ROLE_SEPARATOR);
}
