// Every nudge campaign built on ./campaign.ts, for the campaigns listing. A new campaign adds its
// info here so admins can see it exists, what it does and when it last went out.
import type { AdminBotNudgeCampaignInfo } from "./campaign.js";
import { PROFILE_PHOTO_NUDGE } from "./profile-photo-nudge.js";

export const ADMINBOT_NUDGE_CAMPAIGNS: readonly AdminBotNudgeCampaignInfo[] = [PROFILE_PHOTO_NUDGE];
