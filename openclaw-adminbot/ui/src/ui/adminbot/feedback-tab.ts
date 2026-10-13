// Maps every AdminBot feature tab to the surface id the feedback widget rates and the GitHub URL of
// that function's source file. The "i" button in the widget opens this link so a member who wants
// the function improved can file their own PR. Only AdminBot-owned tabs are listed; native OpenClaw
// surfaces (chat, overview, sessions, ...) do not get the widget.
import type { Tab } from "../navigation.ts";

export type FeedbackConfig = {
  featureId: string;
  githubFile: string;
};

const ADMINBOT_BASE =
  "https://github.com/akhkim/openclaw-adminbot-lab/blob/main/openclaw-adminbot/ui/src/ui/adminbot";

const file = (name: string): string => `${ADMINBOT_BASE}/views/${name}`;

export const FEEDBACK_TABS: Partial<Record<Tab, FeedbackConfig>> = {
  dashboard: { featureId: "dashboard", githubFile: file("dashboard.ts") },
  profile: { featureId: "profile", githubFile: file("profile.ts") },
  adminbotTimeAvailability: {
    featureId: "time-availability",
    githubFile: file("time-availability.ts"),
  },
  // My Projects & Papers is drawn from projects/, not views/; view.ts is its entry point.
  myWork: { featureId: "my-work", githubFile: `${ADMINBOT_BASE}/projects/view.ts` },
  labSharing: { featureId: "lab-sharing", githubFile: file("lab-sharing.ts") },
  adminbotMembers: { featureId: "members", githubFile: file("admin.ts") },
  adminbotReimbursements: { featureId: "reimbursements", githubFile: file("reimbursements.ts") },
  adminbotDeadlines: { featureId: "deadlines", githubFile: file("deadlines.ts") },
  adminbotSignatures: { featureId: "logistics", githubFile: file("logistics.ts") },
  adminbotRecLetters: { featureId: "logistics", githubFile: file("logistics.ts") },
  adminbotMeetingRequests: { featureId: "logistics", githubFile: file("logistics.ts") },
};

export function feedbackConfigForTab(tab: Tab): FeedbackConfig | null {
  return FEEDBACK_TABS[tab] ?? null;
}
