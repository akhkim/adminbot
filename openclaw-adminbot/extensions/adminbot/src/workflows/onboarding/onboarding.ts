import type {
  AdminBotOnboardingCycleReason,
  AdminBotMemberOnboarding,
  AdminBotMemberOnboardingStep,
} from "../../contracts/actions.js";

// Links that name this deployment's workspace -- the lab calendar, the PI's LinkedIn, the lab's X
// account -- come from the environment rather than from the tracked checklist. Unset, the entry is
// simply left out: a checklist step that survives without one of its links is better than one
// pointing a new member at nothing.
const LAB_EMAIL_ENV = "ADMINBOT_LAB_EMAIL";
const PI_LINKEDIN_ENV = "ADMINBOT_PI_LINKEDIN_URL";
const LAB_X_ENV = "ADMINBOT_LAB_X_URL";

type OnboardingLink = { label: string; url: string };

/** Keeps a link only when its env var is set, so an unconfigured deployment omits it entirely. */
function optionalLink(
  label: string,
  varName: string,
  toUrl: (value: string) => string = (value) => value,
): OnboardingLink[] {
  const value = process.env[varName]?.trim();
  return value ? [{ label, url: toUrl(value) }] : [];
}

function labCalendarEmbedUrl(labEmail: string): string {
  return `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(labEmail)}&ctz=America%2FToronto`;
}

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
      // Conditional on the same variable as the link below, and for a reason this lab has already
      // paid for: the claim used to be unconditional while the link was not, so a deployment with
      // no lab calendar configured told 155 members they had been added to a calendar that had
      // never heard of them, with no link to notice the absence by. A step that admits access is
      // still coming is worth far more than one that confidently states a falsehood.
      detail: process.env[LAB_EMAIL_ENV]?.trim()
        ? "You've been added as a view-only guest on the Jinesis Lab calendar " +
          "(America/Toronto timezone) automatically — no action needed."
        : "Lab calendar access is not set up on this deployment yet. Ask an admin to grant it; " +
          "there is nothing for you to do here.",
      links: optionalLink("Open the lab calendar", LAB_EMAIL_ENV, labCalendarEmbedUrl),
    },
    {
      // Information, not a task. The old "Set up your Google Drive project folder" step was
      // removed because drive-workspace.ts already provisions the folder when the guide is sent --
      // it asked members to do by hand what onboarding had done for them. What was worth keeping
      // is what the folder *is* and what is already in it, which is this.
      id: "drive_folder",
      label: "Your shared Google Drive folder",
      category: "Getting started",
      required: true,
      detail:
        "A 1:1 Google Drive folder with Zhijing is shared with you when your account is " +
        "approved — no action needed to create it.",
      bullets: [
        {
          text: "The internal mentee handbook should already be in it.",
          points: [
            "Check it first when a question comes up — it answers most of them.",
            "Still stuck after that? See Questions? at the end of this checklist.",
          ],
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
        {
          text: "Mandatory events come with a personal email invite.",
          points: [
            "These are the ones directly relevant to your research, e.g. the Monday big group meeting.",
          ],
        },
        {
          text: "Every other event on the lab calendar is open — join any session that interests you.",
        },
        {
          text: "Each themed topic may have its own Slack group chat (#meeting-xxx) you're welcome to join.",
        },
      ],
    },
    {
      id: "linkedin",
      label: "Connect on LinkedIn",
      category: "Social media",
      required: true,
      detail: "Build your professional presence with the lab.",
      bullets: [
        {
          text: "Update your own LinkedIn to show you joined as a Research Assistant at the Jinesis Lab.",
        },
        {
          text: "Working on AI safety or democracy, based in Europe, or just interested? You are also welcome to add EuroSafeAI as a parallel org.",
        },
      ],
      links: [
        ...optionalLink("Connect with Zhijing", PI_LINKEDIN_ENV),
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
        ...optionalLink("Jinesis Lab", LAB_X_ENV),
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
      // What a person may request depends on their standing, so a change of standing is exactly
      // when this is worth reading again.
      reaffirm_on_standing_change: true,
      detail: "Set up compute access for research, sponsored by Zhijing's CCID hqw-052-01.",
      bullets: [
        {
          text: "Use an institutional email if you have one.",
          points: [
            "A current or previous university/company address is preferred.",
            "A personal address works, but the affiliation and the email domain must look consistent or approval may be rejected.",
            'Example: "University of Toronto" needs a utoronto.ca-style address, not a personal gmail one.',
          ],
        },
        {
          text: 'Pick the right role: "External Collaborator" is for people not directly paid by Zhijing.',
          points: [
            "That covers independent researchers, and anyone whose primary appointment is elsewhere.",
          ],
        },
        {
          text: "Approval is handled by a lab admin.",
          points: [
            "No reply within 3 business days? Ping Andrew Kim or Yongjin Yang on Slack or email.",
          ],
        },
        {
          text: "Optional: the Killarney H100 cluster, under Roger's CCID vxq-872-01.",
          points: [
            "Apply from My Account -> Apply for a New Role.",
            "Leave the checkboxes unticked and put the CCID in the sponsor field.",
            "Invite-only for selected large-compute projects, so always ask before proceeding.",
          ],
        },
        {
          text: "Generate and register an SSH key.",
          points: ["Killarney has no password login, so the key is the only way in."],
        },
        {
          text: "Prepare for nodes with no internet access.",
          points: [
            "Pre-download Python wheels and install your environment in $SLURM_TMPDIR.",
            "If a wheel is missing, email support@tech.alliancecan.ca.",
          ],
        },
        {
          text: "Join #discussion-gpu-canada on Slack.",
          points: ["Punya and Keenan know the workflow best and can help."],
        },
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
      id: "communication_norms",
      label: "Review our meeting and communication norms",
      category: "Working with us",
      required: true,
      // What the lab expects week to week says something different to a full member than to a
      // trial, which is the whole reason a promotion re-opens the checklist.
      reaffirm_on_standing_change: true,
      bullets: [
        {
          text: "Prefer docs > Slack > a 30-minute Zoom, in that order.",
          points: [
            "Pass by reference in Slack; the detail belongs in a section of your google doc.",
          ],
        },
        {
          text: "Send a doc link 1 day before each meeting.",
          points: ["Include your progress and what you want to discuss."],
        },
        {
          text: "Expected cadence:",
          points: [
            "A meeting after roughly every 20-40 hours of work.",
            "A short progress ping roughly every 10 hours of work.",
          ],
        },
      ],
    },
    {
      id: "questions",
      label: "Questions?",
      category: "Questions",
      required: false,
      // Ordered, not a menu: the guidebook answers most of what gets asked, and a question that
      // reaches a person before it reaches the handbook costs two people's time instead of none.
      detail:
        "Check the guidebook first — it answers most questions. If it does not, ask our chatbot, " +
        "then Andrew directly.",
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

/**
 * Builds a member's checklist from the current step definitions, carrying over the only things that
 * are per-member: which steps they have acknowledged, and which they have marked done. Step text is
 * a snapshot of the lab's onboarding doc, so a copy stored at signup goes stale as soon as the doc
 * changes -- and a copy stored under an older step shape (bullets as plain strings, before they
 * gained nested points) renders as empty bullets in the Control UI. Content belongs to this file;
 * only the member's own answers belong to the member.
 */
export function resolveMemberOnboarding(
  existing?: AdminBotMemberOnboarding,
  options: {
    /** A change of standing: re-open the steps that are about standing, and restart the clock. */
    reopen?: { reason: AdminBotOnboardingCycleReason; at: string };
  } = {},
): AdminBotMemberOnboarding {
  // Re-opened steps lose their acknowledgement, and only those. Clearing the whole list on every
  // promotion would teach people to click through reading material without reading it, which is
  // the one failure a checklist of reading material cannot survive.
  const reopened = options.reopen
    ? new Set(
        buildOnboardingStepDefinitions()
          .filter((definition) => definition.reaffirm_on_standing_change)
          .map((definition) => definition.id),
      )
    : new Set<string>();
  const acknowledgedAt = new Map(
    (existing?.steps ?? [])
      .filter((step) => step.acknowledged_at && !reopened.has(step.id))
      .map((step) => [step.id, step.acknowledged_at as string]),
  );
  const completed = new Set(
    (existing?.steps ?? [])
      .filter((step) => step.status === "complete" && !reopened.has(step.id))
      .map((step) => step.id),
  );
  const cycle = options.reopen
    ? { opened_at: options.reopen.at, reason: options.reopen.reason }
    : {
        ...(existing?.opened_at ? { opened_at: existing.opened_at } : {}),
        ...(existing?.reason ? { reason: existing.reason } : {}),
        // The follow-up stamp belongs to the cycle, so re-opening drops it and the new cycle gets
        // its own ten days rather than inheriting a clock that already expired.
        ...(existing?.last_nudged_at ? { last_nudged_at: existing.last_nudged_at } : {}),
      };
  return withCycle(
    projectOnboarding(
      promoteCurrentStep(
        buildOnboardingSteps().map((step) => {
          const at = acknowledgedAt.get(step.id);
          const complete = at !== undefined || completed.has(step.id);
          return {
            ...step,
            ...(complete ? { status: "complete" as const } : {}),
            ...(at ? { acknowledged_at: at } : {}),
          };
        }),
      ),
    ),
    cycle,
  );
}

/** Carries the cycle fields through the derived views, which rebuild the step lists each time. */
function withCycle(
  onboarding: AdminBotMemberOnboarding,
  cycle: Partial<AdminBotMemberOnboarding>,
): AdminBotMemberOnboarding {
  return { ...onboarding, ...cycle };
}

/**
 * Records that a member has read a step, and rebuilds the derived views around it. Reading and
 * doing are tracked apart: the acknowledgement stamp is what gates dismissing the welcome screen,
 * while `status` is the self-attested "I did this" that the onboarding nudge keys off. Acknowledging
 * also completes the step, because a step nobody can observe is done once its reader says so.
 */
export function acknowledgeOnboardingStep(
  onboarding: AdminBotMemberOnboarding,
  stepId: string,
  acknowledgedAt: string,
): AdminBotMemberOnboarding | undefined {
  if (!onboarding.steps.some((step) => step.id === stepId)) {
    return undefined;
  }
  const steps = onboarding.steps.map((step) =>
    step.id === stepId && !step.acknowledged_at
      ? { ...step, status: "complete" as const, acknowledged_at: acknowledgedAt }
      : step,
  );
  return projectOnboarding(promoteCurrentStep(steps));
}

export function buildInitialOnboarding(openedAt?: string): AdminBotMemberOnboarding {
  return withCycle(
    projectOnboarding(buildOnboardingSteps()),
    openedAt ? { opened_at: openedAt, reason: "registration" as const } : {},
  );
}

/**
 * Whether a standing change should re-open the checklist.
 *
 * Status and privilege level only. Every other field on the record is a fact about the person --
 * their city, their topics, their links -- and none of them changes what the lab is asking of them.
 */
export function onboardingReopenReason(
  before: { status?: string; privilege_level?: string } | undefined,
  after: { status?: string; privilege_level?: string },
): AdminBotOnboardingCycleReason | undefined {
  if (!before) {
    return undefined;
  }
  if ((before.privilege_level ?? "") !== (after.privilege_level ?? "")) {
    return "privilege_change";
  }
  if ((before.status ?? "") !== (after.status ?? "")) {
    return "status_change";
  }
  return undefined;
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

// `current` is positional: the first required step still outstanding. Kept apart from the
// projection below so callers that already promoted cannot double-promote.
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

// Keeps `current_step`/`completed`/`remaining` consistent with `steps`, which is the only field
// callers mutate. Everything unfinished stays in `remaining` so the UI can count what is left.
function projectOnboarding(steps: AdminBotMemberOnboardingStep[]): AdminBotMemberOnboarding {
  const current = steps.find((step) => step.status === "current");
  return {
    ...(current ? { current_step: current } : {}),
    completed: steps.filter((step) => step.status === "complete"),
    remaining: steps.filter((step) => step.status !== "complete"),
    steps,
  };
}
