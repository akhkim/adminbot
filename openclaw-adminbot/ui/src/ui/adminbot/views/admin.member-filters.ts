import {
  adminBotIsAlumniMember,
  adminBotMemberTypeTokens,
} from "../../../../../extensions/adminbot/src/contracts/actions.js";
import { parseAdminBotMemberRoles } from "../../../../../extensions/adminbot/src/contracts/member-roles.js";
import type { AdminBotLabMember, AdminBotStandingMeetingsState } from "../controllers/admin.ts";
import { parseMemberNotes } from "../data/member-notes.ts";

export const memberFacetLabels = {
  location: "Location",
  career: "Career status",
  membership: "Membership",
  meeting: "Meeting invitation",
};

export function memberJoinedMonth(member: AdminBotLabMember): string {
  return member.joined_month?.trim() || parseMemberNotes(member.notes).joinedMonth || "";
}

export function memberFacets(
  member: AdminBotLabMember,
  standing?: AdminBotStandingMeetingsState,
): Record<keyof typeof memberFacetLabels, string[]> {
  const emails = new Set(
    [member.calendar_email, member.email, member.correspondence_email]
      .map((email) => email?.trim().toLowerCase())
      .filter(Boolean),
  );
  const types = adminBotMemberTypeTokens(member.member_type).filter(Boolean);
  if (adminBotIsAlumniMember(member) && !types.includes("alumni")) types.push("alumni");
  const location = member.location?.trim() || parseMemberNotes(member.notes).location;
  return {
    location: location ? [location] : [],
    career: parseAdminBotMemberRoles(member.role),
    membership: types,
    meeting: (standing?.meetings ?? [])
      .filter((meeting) =>
        meeting.attendees.some((email) => emails.has(email.trim().toLowerCase())),
      )
      .map((meeting) => meeting.id),
  };
}
