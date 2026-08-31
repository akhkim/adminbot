/**
 * Which onboarding mail a row of the member spreadsheet gets, from its Member Type column.
 *
 * Column S is a comma-separated list -- "full", "alumni, coauthor-discussant-or-designer",
 * "coauthor-minor" -- so a row can carry several roles at once and the mail has to pick one. The
 * order below is that choice, and it is not arbitrary: the most-committed role wins, because that
 * is the one whose onboarding covers the others. Someone who is `full, coauthor-major` needs the
 * full-member setup, which already includes everything the coauthor mail would have said.
 *
 * Three roles send no mail at all. Their onboarding is the access-level algorithm granting the
 * subgroup's access items in the backend (collaborator-subgroups.ts), which is why `acquaintance`
 * and `external_prof` no longer have templates and `coauthor_discussant_designer` never did. A row
 * carrying only those is refused here rather than silently mailed something close enough.
 */
import type { AdminBotMemberType } from "../../contracts/actions.js";

/**
 * Most-committed first. The first token a row carries decides its template.
 *
 * Every token here is one of `adminBotMemberTypes`, which is what the Onboarding grid offers as a
 * dropdown -- a token this file routes on but that list does not offer would be a template nobody
 * could ever select. A test holds the two together.
 */
const TEMPLATE_BY_TYPE: readonly (readonly [token: AdminBotMemberType, templateId: string])[] = [
  ["full", "member"],
  ["alumni", "alumni"],
  ["own-pace-advisee", "own_pace_advisee"],
  ["coauthor-major", "coauthor_major"],
  ["coauthor-minor", "coauthor_minor"],
  ["disappearing-coauthor", "disappearing_coauthor"],
  ["slightly-better-than-emails", "slightly_better_than_emails"],
  ["interviewee", "interviewee"],
];

/** Roles whose whole onboarding happens in the backend, with no mail. */
export const NO_MAIL_MEMBER_TYPES: readonly AdminBotMemberType[] = [
  "acquaintance",
  "coauthor-discussant-or-designer",
  "external-prof",
];

export function memberTypeTokens(memberType: string | undefined): string[] {
  return (memberType ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

export type MemberTypeTemplate =
  | { ok: true; templateId: string; token: string }
  | { ok: false; reason: string };

export function templateForMemberType(memberType: string | undefined): MemberTypeTemplate {
  const tokens = memberTypeTokens(memberType);
  if (tokens.length === 0) {
    return { ok: false, reason: "the Member Type column is empty, so no template applies" };
  }
  for (const [token, templateId] of TEMPLATE_BY_TYPE) {
    if (tokens.includes(token)) {
      return { ok: true, templateId, token };
    }
  }
  // Widened for the lookup: `tokens` is whatever the sheet cell held, which is exactly the case
  // this is checking for, so it must not be narrowed to the known vocabulary first.
  const noMail = tokens.filter((token) =>
    (NO_MAIL_MEMBER_TYPES as readonly string[]).includes(token),
  );
  if (noMail.length > 0) {
    return {
      ok: false,
      reason:
        `${noMail.join(", ")} sends no onboarding mail; the access-level algorithm grants the `
        + "subgroup's access items in the backend and that is the whole onboarding",
    };
  }
  return { ok: false, reason: `no onboarding template for member type "${tokens.join(", ")}"` };
}
