import type { AdminBotLabMember } from "../contracts/actions.js";
import { requiresProfileCompletion } from "../contracts/profile-completion.js";

/**
 * Incomplete members can repair their own profile, never another member's record.
 *
 * `isImpersonating` lifts the lock for a "view as" session. The gate exists to make a member
 * complete their own profile on their own login before they use the app; an admin viewing the lab
 * as that member is not that member and is already re-validated as an admin on every request, so
 * holding them to the viewed member's unfinished profile only blanked every page of the person they
 * were trying to inspect. It grants nothing new: admin-only routes stay privilege-checked against
 * the viewed member, and credential changes stay refused while impersonating.
 */
export function isBlockedByProfile(
  member: AdminBotLabMember,
  method: string | undefined,
  pathname: string,
  isImpersonating: boolean,
): boolean {
  // A view-as session is the admin, not the viewed member, so the viewed member's own
  // profile-completion lock does not apply to it.
  if (isImpersonating || !requiresProfileCompletion(member)) return false;
  if (method === "GET" && pathname === "/lab/members/self") return false;
  if (method === "POST" && pathname === "/drive/check-edit-access") return false;
  if (method === "PUT" && pathname === `/lab/members/${encodeURIComponent(member.id)}`)
    return false;
  return true;
}
