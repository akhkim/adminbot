// Maps every AdminBot feature tab to the surface id the feedback widget rates and the GitHub URL of
// that function's source file. The "i" button in the widget opens this link so a member who wants
// the function improved can file their own PR. Only AdminBot-owned tabs are listed; native OpenClaw
// surfaces (chat, overview, sessions, ...) do not get the widget.
import type { Tab } from "../navigation.ts";

export type FeedbackConfig = {
  featureId: string;
  githubFile: string;
};

const REPO_BASE =
  "https://github.com/akhkim/openclaw-adminbot-lab/blob/main/openclaw-adminbot/ui/src/ui/adminbot/views";

const file = (name: string): string => `${REPO_BASE}/${name}`;

export const FEEDBACK_TABS: Partial<Record<Tab, FeedbackConfig>> = {
  dashboard: { featureId: "dashboard", githubFile: file("dashboard.ts") },
  profile: { featureId: "profile", githubFile: file("profile.ts") },
  adminbotTimeAvailability: {
    featureId: "time-availability",
    githubFile: file("time-availability.ts"),
  },
  myWork: { featureId: "my-work", githubFile: file("my-work.ts") },
  labSharing: { featureId: "lab-sharing", githubFile: file("lab-sharing.ts") },
  adminbotMembers: { featureId: "members", githubFile: file("admin.ts") },
  adminbotReimbursements: { featureId: "reimbursements", githubFile: file("reimbursements.ts") },
  adminbotDeadlines: { featureId: "deadlines", githubFile: file("deadlines.ts") },
  adminbotLogistics: { featureId: "logistics", githubFile: file("logistics.ts") },
};

export function feedbackConfigForTab(tab: Tab): FeedbackConfig | null {
  return FEEDBACK_TABS[tab] ?? null;
}