// Which of a member's addresses the lab writes to.
//
// The roster carries three, and they answer three different questions. `email` is the departmental
// identity the account is keyed by and the one governance requires to be @cs.toronto.edu;
// `calendar_email` is the Google identity an invite has to name to become an ACL; and
// `correspondence_email` is, in the field's own words, the address the lab writes to for outreach.
// They are routinely different -- on the current roster 65 of the 132 members who carry a
// correspondence address wrote a different one from their login, and several members who have no
// departmental mailbox at all have only this one.
//
// So a message *to a person* resolves here, while an invite or a sign-in does not. Pure, and in
// contracts/ rather than inside the service, because "where does mail to this member go" is a fact
// about the record that more than one sweep has to agree on.

/** Only the address fields matter; this takes any record that carries them. */
export type AdminBotAddressableMember = {
  email?: string;
  correspondence_email?: string;
};

/**
 * The roster field is free text filled in by hand, so a member with two addresses writes both into
 * it: "Arian.Khorasani@umontreal.ca / Ariankhorasani1@gmail.com" is a live value. Split on the
 * separators people actually use and take the first address that parses.
 *
 * First rather than all of them: the proposal, the approval card and the audit row each name one
 * recipient, and fanning one nudge out to two mailboxes would make "did we tell them" a question
 * with two answers. The preview prints what this resolved to, so a wrong pick shows up as a roster
 * fix rather than as a silent misdelivery.
 */
function firstAddress(value: string | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  for (const candidate of value.split(/[/,;\s]+/u)) {
    const trimmed = candidate.trim();
    // Deliberately not a validator: whatever reaches here is already on the roster, and a stricter
    // rule would silently drop an address the lab has been writing to by hand for months.
    if (trimmed.includes("@") && !trimmed.startsWith("@") && !trimmed.endsWith("@")) {
      return trimmed;
    }
  }
  return "";
}

/**
 * Where outreach to this member goes: the correspondence address, else the login address.
 *
 * Empty when neither is usable, which is a member the lab cannot mail -- the caller reports that as
 * a skip rather than inventing a destination.
 */
export function adminBotOutreachEmail(member: AdminBotAddressableMember): string {
  return firstAddress(member.correspondence_email) || firstAddress(member.email);
}
