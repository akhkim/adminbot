import type { AdminBotLabMember } from "../contracts/actions.js";
import { requiresProfileCompletion } from "../contracts/profile-completion.js";

/** Incomplete members can repair their own profile, never another member's record. */
export function isBlockedByProfile(
  member: AdminBotLabMember,
  method: string | undefined,
  pathname: string,
): boolean {
  if (!requiresProfileCompletion(member)) return false;
  if (method === "GET" && pathname === "/lab/members/self") return false;
  if (method === "POST" && pathname === "/drive/check-edit-access") return false;
  if (method === "PUT" && pathname === `/lab/members/${encodeURIComponent(member.id)}`)
    return false;
  return true;
}
