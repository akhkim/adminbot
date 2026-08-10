import type { SessionEntry } from "../../config/sessions/types.js";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ADMIN_SCOPE } from "../method-scopes.js";
import type { GatewayRequestHandlerOptions } from "./shared-types.js";

/**
 * chat/session ownership: a persisted session may only be listed, described, or deleted by the
 * member identity that created it, mirroring the live-run ownership pattern in
 * chat.run-abort.ts's resolveChatAbortRequester/canRequesterAbortChatRun but keyed on memberId
 * (the AdminBot identity resolved from the paired device) instead of deviceId/connId.
 */
export type SessionAccessRequester = {
  memberId?: string;
  isAdmin: boolean;
};

export function resolveSessionAccessRequester(
  client: GatewayRequestHandlerOptions["client"],
): SessionAccessRequester {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return {
    memberId: normalizeOptionalString(client?.ownerMemberId),
    isAdmin: scopes.includes(ADMIN_SCOPE),
  };
}

export function canRequesterAccessSession(
  entry: Pick<SessionEntry, "ownerMemberId">,
  requester: SessionAccessRequester,
): boolean {
  if (requester.isAdmin) {
    return true;
  }
  const ownerMemberId = normalizeOptionalString(entry.ownerMemberId);
  if (!ownerMemberId) {
    // No owner recorded (connection had no paired-device identity, or the session predates
    // this field) -- unscoped, same fallback as canRequesterAbortChatRun.
    return true;
  }
  return Boolean(requester.memberId && ownerMemberId === requester.memberId);
}
