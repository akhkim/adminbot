import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions/types.js";
import { memberIdFromSessionKey } from "../../sessions/session-key-utils.js";
import type { GatewayRequestHandlerOptions } from "./shared-types.js";

/**
 * chat/session ownership: a persisted session may only be listed, described, or deleted by the
 * member identity that created it, mirroring the live-run ownership pattern in
 * chat.run-abort.ts's resolveChatAbortRequester/canRequesterAbortChatRun but keyed on memberId
 * (the AdminBot identity resolved from the paired device) instead of deviceId/connId.
 *
 * The rule is absolute: owner or nobody.
 *
 *   - Admins get no bypass. A lab admin can govern members, papers and approvals; that is not the
 *     same as reading what someone typed into a private chat, and an admin scope is held by more
 *     people than a "nobody else reads this" promise can survive.
 *   - An unowned session is unreachable, not public. Ownership is stamped at creation and creation
 *     is refused without an identity to stamp (sessions.ts), so a session with no owner is either
 *     a pre-ownership leftover or a bug. Treating either as world-readable is the failure mode this
 *     exists to prevent, so it fails closed.
 *
 * Anything that needs to read across members reads the store directly, server-side, rather than
 * asking for a bypass here.
 */
// Deliberately just the identity: there is no admin flag to consult, because there is no admin
// bypass. Adding one back would need a reason that survives "an admin can read your private chat".
export type SessionAccessRequester = {
  memberId?: string;
};

export function resolveSessionAccessRequester(
  client: GatewayRequestHandlerOptions["client"],
): SessionAccessRequester {
  return {
    memberId: normalizeOptionalString(client?.ownerMemberId),
  };
}

/**
 * Who owns a session: the stamp if there is one, otherwise whatever its key says.
 *
 * The key is the load-bearing half. A member's chat lives at `agent:<agentId>:member-<id>`, so
 * ownership is recoverable from the key alone -- which is what lets sessions created by
 * auto-reply, cron or an agent tool be correctly owned without those paths knowing anything about
 * ownership or carrying an identity down to the store write. The stamp is belt and braces for the
 * one path that does have an identity to record (sessions.create).
 */
export function resolveSessionOwnerMemberId(
  entry: Pick<SessionEntry, "ownerMemberId">,
  sessionKey?: string | null,
): string | undefined {
  return normalizeOptionalString(entry.ownerMemberId) ?? memberIdFromSessionKey(sessionKey);
}

export function canRequesterAccessSession(
  entry: Pick<SessionEntry, "ownerMemberId">,
  requester: SessionAccessRequester,
  sessionKey?: string | null,
): boolean {
  const ownerMemberId = resolveSessionOwnerMemberId(entry, sessionKey);
  // Fails closed on both halves: a session nobody owns matches nobody, and a requester with no
  // identity matches nothing. Neither is widened for admins.
  if (!ownerMemberId || !requester.memberId) {
    return false;
  }
  return ownerMemberId === requester.memberId;
}
