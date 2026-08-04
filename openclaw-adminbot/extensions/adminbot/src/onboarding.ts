import type { AdminBotMemberOnboarding, AdminBotMemberOnboardingStep } from "./contracts.js";

// Static onboarding checklist handed to every newly approved member. Content mirrors the lab's
// standing onboarding doc; update this list (not per-member state) when the doc changes, since
// `service-core.ts` only generates it once at first `upsertLabMember` and never regenerates it.
function buildOnboardingStepDefinitions(): Array<Omit<AdminBotMemberOnboardingStep, "status">> {
  return [
    {
      id: "calendar_invite",
      label: "Lab calendar access",
      category: "Getting started",
      required: true,
      detail:
        "You've been added as a view-only guest on the Jinesis Lab calendar " +
        "(America/Toronto timezone) automatically — no action needed.",
      links: [
        {
          label: "Open the lab calendar",
          url: "https://calendar.google.com/calendar/embed?src=jinesis.lab%40gmail.com&ctz=America%2FToronto",
        },
      ],
    },
    {
      id: "profile_photo",
      label: "Upload a professional profile photo",
      category: "Getting started",
      required: true,
      detail: "Add a professional headshot to your Lab Members profile.",
    },
    {
      id: "calendar_conventions",
      label: "Learn our calendar and meeting conventions",
      category: "Getting started",
      required: true,
      detail: "Know which lab events you should attend.",
      bullets: [
        "Mandatory events directly relevant to your research (e.g. our Monday big group meeting) come with a personal email invite.",
        "Every other event on the lab calendar is open — join any session that interests you.",
        "Each themed topic may have its own Slack group chat (#meeting-xxx) you're welcome to join.",
      ],
    },
    {
      id: "linkedin",
      label: "Connect on LinkedIn",
      category: "Social media",
      required: true,
      detail: "Build your professional presence with the lab.",
      bullets: [
        "Update your own LinkedIn to show you joined as a Research Assistant at the Jinesis Lab.",
        "Working on democracy or based in Europe? Also welcome to join EuroSafeAI as a parallel org.",
      ],
      links: [
        { label: "Connect with Zhijing", url: "https://linkedin.com/in/zhijing-jin/" },
        { label: "Jinesis Lab", url: "https://www.linkedin.com/company/jinesis-lab/" },
        { label: "EuroSafeAI", url: "https://www.linkedin.com/company/eurosafeai/" },
      ],
    },
    {
      id: "twitter",
      label: "Follow the lab on X/Twitter",
      category: "Social media",
      required: false,
      detail: "Feel free to follow along.",
      links: [
        { label: "Zhijing Jin", url: "https://x.com/ZhijingJin" },
        { label: "Jinesis Lab", url: "https://x.com/JinesisLab" },
        { label: "EuroSafeAI", url: "https://x.com/EuroSafeAI" },
      ],
    },
    {
      id: "luma",
      label: "Follow the Luma calendar for in-person events",
      category: "Social media",
      required: false,
      links: [{ label: "Luma — Jinesis", url: "https://luma.com/jinesis" }],
    },
    {
      id: "youtube",
      label: "Subscribe to the lab YouTube for talk recordings",
      category: "Social media",
      required: false,
      links: [{ label: "YouTube — Zhijing", url: "https://www.youtube.com/@Zhijing" }],
    },
    {
      id: "compute_canada",
      label: "Apply for a Compute Canada (Alliance) account",
      category: "Compute access",
      required: true,
      detail: "Set up compute access for research, sponsored by Zhijing's CCID hqw-052-01.",
      bullets: [
        "An institutional email is preferred (current or previous university/company email); a " +
          "personal email works too, but affiliation and email domain must look consistent or " +
          'approval may be rejected (e.g. "University of Toronto" needs a utoronto.ca-style ' +
          "email, not a personal gmail address).",
        '"External Collaborator" applies to people not directly paid by Zhijing (independent ' +
          "researchers, or those with a primary appointment elsewhere).",
        "Approval is handled by a lab admin — if you don't hear back in 3 business days, ping " +
          "Andrew Kim or Yongjin Yang on Slack or email.",
        "Anyone can also apply for the Killarney H100 cluster under Roger's CCID (vxq-872-01) via " +
          "My Account -> Apply for a New Role (leave the checkboxes unticked, put the CCID in the " +
          "sponsor field) — this is invite-only for selected large-compute projects, so always ask " +
          "before proceeding.",
        "Generate and register an SSH key since Killarney doesn't use password login.",
        "Some compute nodes aren't internet-connected, so pre-download Python wheels and install " +
          "your environment in $SLURM_TMPDIR; if a wheel is missing, email " +
          "support@tech.alliancecan.ca.",
        "Join #discussion-gpu-canada on Slack — Punya and Keenan know the workflow best and can help.",
      ],
      links: [
        {
          label: "Apply for an account",
          url: "https://alliancecan.ca/en/our-services/advanced-research-computing/account-management/apply-account",
        },
        { label: "SSH keys guide", url: "https://docs.alliancecan.ca/wiki/SSH_Keys" },
        {
          label: "Available Python wheels",
          url: "https://docs.alliancecan.ca/wiki/Available_Python_wheels",
        },
        { label: "Technical support", url: "https://docs.alliancecan.ca/wiki/Technical_support" },
      ],
    },
    {
      id: "google_drive",
      label: "Set up your Google Drive project folder",
      category: "Working with us",
      required: true,
      bullets: [
        "Copy the Zhijing-StudentName prototype folder, rename it with your name, and set access " +
          'to "Editable to everyone".',
        "Add your CV as a PDF as your first file.",
        'Keep docs "Pageless" (File > Page setup > Pageless), one long doc using headings rather ' +
          "than multiple tabs.",
        "Prefix document names with the creation date (yyyymmdd).",
        "Keep the folder flat (avoid deep nesting) so files sort cleanly by last-modified date.",
        "Installing Google Drive for desktop keeps the folder synced locally.",
      ],
    },
    {
      id: "communication_norms",
      label: "Review our meeting and communication norms",
      category: "Working with us",
      required: true,
      bullets: [
        "Prefer docs > Slack > a 30-min Zoom, in that order of speed.",
        "Pass-by-reference in Slack messages; keep detailed updates in a google doc section.",
        "Send a doc link 1 day before each meeting with your progress and what you plan to discuss.",
        "Meetings are usually scheduled after every 20-40 hours of work.",
        "Ping a progress update roughly every 10 hours of work.",
      ],
    },
    {
      id: "questions",
      label: "Questions?",
      category: "Questions",
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
  return projectOnboarding(buildOnboardingSteps());
}

export function onboardingStepIds(): string[] {
  return buildOnboardingStepDefinitions().map((definition) => definition.id);
}

export function findOnboardingStep(
  onboarding: AdminBotMemberOnboarding | undefined,
  stepId: string,
): AdminBotMemberOnboardingStep | undefined {
  return onboarding?.steps.find((step) => step.id === stepId);
}

export function isOnboardingStepComplete(
  onboarding: AdminBotMemberOnboarding | undefined,
  stepId: string,
): boolean {
  return findOnboardingStep(onboarding, stepId)?.status === "complete";
}

/**
 * Mark one step complete (or back to incomplete) and re-derive the checklist.
 *
 * `current` is positional, not stored per step: it is always the first required
 * step still outstanding, so completing one step promotes the next automatically
 * and un-completing one can pull `current` backwards.
 */
export function setOnboardingStepStatus(
  onboarding: AdminBotMemberOnboarding,
  stepId: string,
  complete: boolean,
): AdminBotMemberOnboarding {
  const steps = onboarding.steps.map((step) =>
    step.id === stepId ? { ...step, status: complete ? "complete" : "remaining" } : step,
  ) as AdminBotMemberOnboardingStep[];
  return projectOnboarding(promoteCurrentStep(steps));
}

function promoteCurrentStep(steps: AdminBotMemberOnboardingStep[]): AdminBotMemberOnboardingStep[] {
  let promoted = false;
  return steps.map((step) => {
    if (step.status === "complete") {
      return step;
    }
    if (!promoted && step.required) {
      promoted = true;
      return { ...step, status: "current" };
    }
    return { ...step, status: "remaining" };
  });
}

function projectOnboarding(steps: AdminBotMemberOnboardingStep[]): AdminBotMemberOnboarding {
  return {
    current_step: steps.find((step) => step.status === "current"),
    completed: steps.filter((step) => step.status === "complete"),
    remaining: steps.filter((step) => step.status !== "complete"),
    steps,
  };
}
