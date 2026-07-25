import type { AdminBotMemberOnboarding, AdminBotMemberOnboardingStep } from "./contracts.js";

// Static onboarding checklist handed to every newly approved member. Content mirrors the lab's
// standing onboarding doc; update this list (not per-member state) when the doc changes, since
// `service-core.ts` only generates it once at first `upsertLabMember` and never regenerates it.
function buildOnboardingStepDefinitions(): Array<Omit<AdminBotMemberOnboardingStep, "status">> {
  return [
    {
      id: "calendar_invite",
      label: "Lab calendar access",
      required: true,
      detail:
        "You've been added as a view-only guest on the Jinesis Lab calendar " +
        "(jinesis.lab@gmail.com, America/Toronto timezone) automatically — no action needed.",
    },
    {
      id: "profile_photo",
      label: "Upload a professional profile photo",
      required: true,
      detail: "Add a professional headshot to your Lab Members profile.",
    },
    {
      id: "calendar_conventions",
      label: "Learn our calendar and meeting conventions",
      required: true,
      detail:
        "If an event is mandatory and directly relevant to your research, you'll typically get a " +
        "personal email invite (e.g. our Monday big group meeting). For every other event on the " +
        "lab calendar, everyone is welcome to join any session that interests them. Each themed " +
        "topic may also have a Slack group chat (#meeting-xxx) you can join.",
    },
    {
      id: "linkedin",
      label: "Connect on LinkedIn",
      required: true,
      detail:
        "Connect with Zhijing's personal account (linkedin.com/in/zhijing-jin). Update your own " +
        "LinkedIn entry to show you joined as a Research Assistant at the Jinesis Lab organization " +
        "page (linkedin.com/company/jinesis-lab). If you work on democracy or are based in Europe, " +
        "you're welcome to also join EuroSafeAI as a parallel org (linkedin.com/company/eurosafeai).",
    },
    {
      id: "twitter",
      label: "Follow the lab on X/Twitter",
      required: false,
      detail: "Feel free to follow x.com/ZhijingJin, x.com/JinesisLab, and x.com/EuroSafeAI.",
    },
    {
      id: "luma",
      label: "Follow the Luma calendar for in-person events",
      required: false,
      detail: "luma.com/jinesis",
    },
    {
      id: "youtube",
      label: "Subscribe to the lab YouTube for talk recordings",
      required: false,
      detail: "youtube.com/@Zhijing",
    },
    {
      id: "compute_canada",
      label: "Apply for a Compute Canada (Alliance) account",
      required: true,
      detail:
        "Apply at alliancecan.ca/en/our-services/advanced-research-computing/account-management/apply-account, " +
        "sponsored by Zhijing's CCID hqw-052-01 for default cases. An institutional email is " +
        "preferred (current or previous university/company email); a personal email works too, but " +
        "affiliation and email domain must look consistent or the admin approval may be rejected " +
        '(e.g. "University of Toronto" + a utoronto.ca-style email is fine; "University of ' +
        'Toronto" + a personal gmail address is not). "External Collaborator" applies to people ' +
        "not directly paid by Zhijing (independent researchers, or those with a primary appointment " +
        "elsewhere). Approval is handled by a lab admin — if you don't hear back in 3 business days, " +
        "ping Andrew Kim or Yongjin Yang on Slack or email. Anyone can also apply for the Killarney " +
        "H100 cluster under Roger's CCID (vxq-872-01) via My Account -> Apply for a New Role (leave " +
        "the checkboxes unticked, put the CCID in the sponsor field), but this is invite-only for " +
        "selected large-compute projects — always ask before proceeding. Generate and register an " +
        "SSH key (docs.alliancecan.ca/wiki/SSH_Keys) since Killarney doesn't use password login. " +
        "Some compute nodes aren't internet-connected, so pre-download Python wheels " +
        "(docs.alliancecan.ca/wiki/Available_Python_wheels) and install your environment in " +
        "$SLURM_TMPDIR; if a wheel is missing, email support@tech.alliancecan.ca. Support: " +
        "docs.alliancecan.ca/wiki/Technical_support.",
    },
    {
      id: "slack_channels",
      label: "Join the right Slack channels",
      required: true,
      detail:
        "Join #discussion-gpu-canada for Compute Canada/Killarney help (Punya and Keenan know the " +
        "workflow best), plus any #meeting-xxx channels for topics you're interested in.",
    },
    {
      id: "google_drive",
      label: "Set up your Google Drive project folder",
      required: true,
      detail:
        "Copy the Zhijing-StudentName prototype folder and rename it with your name; set access to " +
        '"Editable to everyone". Add your CV as a PDF as your first file. Keep docs "Pageless" ' +
        "(File > Page setup > Pageless) with one long doc using headings rather than multiple tabs. " +
        "Prefix document names with the creation date (yyyymmdd). Keep the folder flat (avoid deep " +
        "nesting) so files sort cleanly by last-modified date. Installing Google Drive for desktop " +
        "keeps the folder synced locally.",
    },
    {
      id: "communication_norms",
      label: "Review our meeting and communication norms",
      required: true,
      detail:
        "Prefer docs > Slack > a 30-min Zoom, in that order of speed. Pass-by-reference in Slack " +
        "messages, keep detailed updates in a google doc section. Send a doc link 1 day before each " +
        "meeting with your progress and what you plan to discuss. Meetings are usually scheduled " +
        "after every 20-40 hours of work; ping a progress update roughly every 10 hours of work.",
    },
    {
      id: "questions",
      label: "Questions?",
      required: false,
      detail: "Ask our lab admin Andrew Kim anytime.",
    },
  ];
}

// The calendar invite is granted automatically at approval time (see auth.ts
// `approveRegistration`), so it starts pre-completed; every other step starts "remaining" with the
// first required one promoted to "current".
export function buildOnboardingSteps(): AdminBotMemberOnboardingStep[] {
  let promotedCurrent = false;
  return buildOnboardingStepDefinitions().map((definition) => {
    if (definition.id === "calendar_invite") {
      return { ...definition, status: "complete" };
    }
    if (!promotedCurrent && definition.required) {
      promotedCurrent = true;
      return { ...definition, status: "current" };
    }
    return { ...definition, status: "remaining" };
  });
}

export function buildInitialOnboarding(): AdminBotMemberOnboarding {
  const steps = buildOnboardingSteps();
  return {
    current_step: steps.find((step) => step.status === "current"),
    completed: steps.filter((step) => step.status === "complete"),
    remaining: steps.filter((step) => step.status !== "complete"),
    steps,
  };
}
