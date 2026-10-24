import { adminBotIsAlumniType } from "../../contracts/actions.js";
import { firstName, type AdminBotNudgeCampaign } from "./campaign.js";

export function hasPersonalWebsite(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const text = value.trim();
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    return ["http:", "https:"].includes(url.protocol) && url.hostname.includes(".");
  } catch {
    return false;
  }
}

export const PERSONAL_WEBSITE_NUDGE: AdminBotNudgeCampaign = {
  key: "personal_website",
  label: "Add your personal webpage",
  description: "Weekly reminders to current members without a personal webpage in their profile.",
  route: "/members/personal-website-reminder/run",
  cooldown_days: 7,
  scheduled: true,
  notification: { kind: "profile", title: "Add your personal webpage", tab: "profile" },
  decide(member) {
    if (member.status === "external" || adminBotIsAlumniType(member.member_type))
      return { skip: "not_current_member" };
    if (hasPersonalWebsite(member.personal_website)) return { skip: "website_present" };
    return {
      message: `Hi ${firstName(member.name)}, please add your personal webpage under Personal website in your AdminBot profile. A simple page with your research interests, projects and contact details helps people find your work. If you don't have one yet, please create one and add the link. These weekly reminders stop once the link is on your profile.`,
    };
  },
};
