// Moved out of contracts/actions.ts (a grandfathered file) unchanged; actions.ts re-exports it.

/**
 * The Member Type column's vocabulary, in the spreadsheet's own hyphenated spelling.
 *
 * Ordered most-committed first, matching how member-type-template.ts picks a row's onboarding mail
 * when it carries several: the first token that matches wins, because that role's onboarding covers
 * the others. The tail is the roles that send no mail at all -- their onboarding is the access
 * algorithm in collaborator-subgroups.ts -- followed by the operational tags the sheet uses to mark
 * who runs AdminBot itself and who only receives the mailing list.
 *
 * Deliberately not the same list as `adminBotExternalCollaboratorSubgroups`, which is a different
 * question in a different spelling: that one is the access matrix for a single `external_collaborator`
 * privilege level, this one is what the roster spreadsheet says a person *is*.
 *
 * This is the list the Onboarding grid offers as a dropdown. It is a floor, not a ceiling: the grid
 * also offers whatever the sheet already holds, so a value the lab has started using is never
 * unselectable just because it has not been added here yet.
 */
export const adminBotMemberTypes = [
  "full",
  "alumni",
  "own-pace-advisee",
  "coauthor-major",
  "coauthor-minor",
  "disappearing-coauthor",
  "slightly-better-than-emails",
  "interviewee",
  // No onboarding mail; the backend grants their access items instead.
  "acquaintance",
  "coauthor-discussant-or-designer",
  "external-prof",
  "benefit-partner",
  "benefit-direct-relative",
  // Operational tags rather than collaboration shapes.
  "adminbot-admin",
  "adminbot-developer",
  "mailing-list",
] as const;

export type AdminBotMemberType = (typeof adminBotMemberTypes)[number];
