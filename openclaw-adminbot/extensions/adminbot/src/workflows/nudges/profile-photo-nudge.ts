// The profile-photo guideline DM as a nudge campaign. Behaviour is the original's: every member the
// review marks non-compliant is messaged on every run (no cooldown), members without a Slack ID
// still get the portal notification, and the message has the portal link appended.
import type { AdminBotNudgeCampaign, AdminBotNudgeCampaignInfo } from "./campaign.js";

export const PROFILE_PHOTO_NUDGE: AdminBotNudgeCampaignInfo = {
  key: "profile_photo",
  label: "Profile photo guidelines",
  description:
    "Reviews active members' Slack profile photos and DMs the photo guidelines to everyone whose photo does not meet them.",
  route: "/profile-photo/review/run",
  cooldown_days: 0,
  scheduled: true,
};

export function profilePhotoCampaign(params: {
  nonCompliantMemberIds: ReadonlySet<string>;
  message: string;
}): AdminBotNudgeCampaign {
  return {
    ...PROFILE_PHOTO_NUDGE,
    notification: {
      kind: "profile_photo",
      title: "Your profile photo needs replacing",
      tab: "profile",
      // Not important: nothing downstream is blocked on it, and a group DM about somebody's
      // headshot is the escalation that would make every other one easy to ignore.
    },
    requireSlack: false,
    decide: (member) =>
      params.nonCompliantMemberIds.has(member.id)
        ? { message: params.message }
        : { skip: "compliant" },
  };
}
