// Members who have asked, through their own record, not to be reached or shown.
//
// There is no opt-out field on the roster yet, so people use the one field they can edit: their
// name. Production has a member who renamed themselves to "Null,do not contact" -- a real,
// active person, not a test row -- and a sweep that only looked for test data would keep
// advertising them. Reading the name is a stopgap until an explicit opt-out field exists; it is
// kept in one place so that field can replace it without hunting down every caller.
import type { AdminBotLabMember } from "../../contracts/actions.js";

// "do not contact", "do-not-contact", "Do_Not_Contact", "donotcontact", and the "DNC" shorthand
// as a whole word, so a name that merely contains those letters (a "Dncan") is untouched.
const DO_NOT_CONTACT = /do[\s_-]*not[\s_-]*contact|(^|[^a-z0-9])dnc([^a-z0-9]|$)/i;
// A name that is only "null": the same member first blanked their name this way, so it reads as
// the opt-out it was, never as a test row to clean up.
const BARE_NULL = /^\s*null\s*$/i;

/** Whether a display name carries a do-not-contact request. */
export function isDoNotContactName(name: string | null | undefined): boolean {
  return typeof name === "string" && (DO_NOT_CONTACT.test(name) || BARE_NULL.test(name));
}

/**
 * Whether this member has opted out by name. Reads `name` and `preferred_name`, since either is
 * self-editable and the request is as valid written in one as in the other.
 */
export function isDoNotContact(
  member: Pick<AdminBotLabMember, "name" | "preferred_name">,
): boolean {
  return isDoNotContactName(member.name) || isDoNotContactName(member.preferred_name);
}
