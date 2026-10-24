// What a member-id rename refuses, shared by the service and both stores.
//
// The stores re-key a member by matching the old id as a whole value in every table, which is what
// lets the rename keep up with tables added after it was written. The price is that it cannot tell
// a member reference from the same word used for something else, so the ids that are also words
// the records store are refused outright rather than renamed half-right.
import {
  adminBotExternalCollaboratorSubgroups,
  adminBotMemberStatuses,
  adminBotMemberTypes,
  adminBotPrivilegeLevels,
  adminBotRegistrationStatuses,
} from "../contracts/actions.js";

/**
 * Ids a rename may not start from or land on. A member whose id is "member" -- the fallback
 * `newMemberIdentity` gives a name with no ASCII letters -- would otherwise take every member's
 * `privilege_level: "member"` with them. The actor stamps are the principals and write origins
 * the service records next to member ids ("service", "admin", "cron", ...).
 */
export const MEMBER_RENAME_RESERVED_IDS: ReadonlySet<string> = new Set<string>([
  ...adminBotPrivilegeLevels,
  ...adminBotMemberStatuses,
  ...adminBotMemberTypes,
  ...adminBotExternalCollaboratorSubgroups,
  ...adminBotRegistrationStatuses,
  "service",
  "anonymous",
  "system",
  "cron",
  "roster",
  "manual",
  "import",
  "profile",
  "slack",
  "login",
  "self",
  "none",
  "unknown",
  "true",
  "false",
  "null",
]);

/**
 * A rename refused because actions still waiting on approval or execution name the member.
 *
 * Their payloads are bound to an approval by hash, so the rename may not rewrite them, and leaving
 * them on an id that no longer exists would have them act on nobody. The admin settles them first.
 */
export class MemberRenameBlockedError extends Error {
  constructor(readonly proposalIds: readonly string[]) {
    super(
      `pending actions still name this member (${proposalIds.join(", ")}); approve and run them, or remove them, first`,
    );
    this.name = "MemberRenameBlockedError";
  }
}
