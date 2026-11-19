// The heads-up a member gets when an admin schedules a change that takes them out of the active
// channels: "a week, then acquaintance" is only a grace period if the person knows about it.
//
// Sent once, when the change is scheduled, from AdminBot and in the lab's name. The text is
// composed here from the record alone, so no caller chooses what it says or who receives it --
// the same reason a hand-written nudge may auto-execute behind an admin session.
import type { AdminBotLabMember } from "../contracts/actions.js";
import type { AdminBotScheduledMemberChange } from "../contracts/scheduled-member-changes.js";
import { isActiveChannelEligible } from "../kernel/service.active-channels.js";
import { privilegeForMemberTypeChange } from "../workflows/members/member-type-access.js";

export const SCHEDULED_CHANGE_NOTICE_TITLE = "Jinesis Lab membership update";

const TYPE_LABELS: Record<string, string> = {
  acquaintance: "Acquaintance",
  alumni: "Alumni",
  "coauthor-minor": "Minor coauthor",
  "coauthor-major": "Major coauthor",
  full: "Full member",
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** True when the member keeps the active channels today and would lose them on the new type. */
export function scheduledChangeRemovesActiveAccess(
  member: AdminBotLabMember,
  memberType: string,
): boolean {
  // The record as the save will leave it: a new type also moves the access level and the stored
  // subgroup, and a stale subgroup would otherwise keep a departing coauthor "eligible".
  const implied = privilegeForMemberTypeChange(member, memberType);
  const after: AdminBotLabMember = { ...member, member_type: memberType };
  if (implied) {
    after.privilege_level = implied.privilege_level;
    if (implied.collaborator_subgroup) {
      after.collaborator_subgroup = implied.collaborator_subgroup;
    } else {
      delete after.collaborator_subgroup;
    }
  }
  return isActiveChannelEligible(member) && !isActiveChannelEligible(after);
}

function longDate(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return `${date} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

function typeLabel(memberType: string): string {
  return memberType
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => TYPE_LABELS[token] ?? token)
    .join(", ");
}

/** The formal notice, in Slack mrkdwn. `today` is YYYY-MM-DD (UTC). */
export function composeScheduledChangeNotice(
  member: Pick<AdminBotLabMember, "name">,
  change: Pick<AdminBotScheduledMemberChange, "member_type" | "due_on">,
  today: string,
): string {
  const firstName = member.name.trim().split(/\s+/u)[0] || member.name.trim();
  const when = longDate(change.due_on);
  const days = Math.round(
    (Date.parse(`${change.due_on}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  const grace =
    days > 1
      ? `This notice gives you ${days} days before the change takes effect.`
      : days === 1
        ? "This change takes effect tomorrow."
        : "This change takes effect today.";
  return [
    `Dear ${firstName},`,
    "",
    `This is a formal notice from Jinesis Lab administration. As part of a regular review of active lab membership, your status will change from active member to *${typeLabel(change.member_type)}* on *${when}*.`,
    "",
    "From that date:",
    "• You will be removed from #jinesis-active and #random-active.",
    "• You will no longer receive the invitation to the weekly Monday lab meeting.",
    "",
    `${grace} If you are currently working on a lab project or paper, or plan to collaborate with the lab again, please reply to this message or contact the lab administrators before ${when}, and your membership will be reviewed. Access can be restored at any time if your involvement resumes.`,
    "",
    "Thank you for your contributions to the lab.",
    "",
    "Jinesis Lab Administration (sent via AdminBot)",
  ].join("\n");
}
