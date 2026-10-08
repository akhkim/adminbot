/**
 * Bookkeeping on the record that only the member and the admins have any use for.
 *
 * `onboarding` is the member's own checklist progress, `field_provenance` says who last wrote each
 * field and from where, and `access` is the resolved grant list. None of it is roster data: a peer
 * reading it learns how far somebody got through their welcome screen, which admin edited their
 * profile last, and which systems they can reach. It is also most of the bytes on a record, so
 * stripping it is what keeps a lab-wide roster read small.
 *
 * Unlike the schedule fields this is stripped for every caller who is neither the member nor an
 * admin, the service principal included: no agent tool reads it, and the principal speaks for
 * whoever is chatting.
 */
export const adminBotOwnerOnlyMemberFields = ["onboarding", "field_provenance", "access"] as const;
