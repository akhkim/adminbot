import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import type { Tab } from "../../navigation.ts";
import type { AccessRole } from "../access.ts";
import { renderDashboard } from "./dashboard.ts";

function step(id: string, label: string, status: "complete" | "current" | "remaining") {
  return { id, label, status, category: "Getting started", required: true };
}

const ONBOARDING_STEPS = [
  step("slack", "Join the lab Slack", "complete"),
  step("compute", "Request compute access", "current"),
  step("doc", "Read the onboarding doc", "remaining"),
];

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    tab: "dashboard",
    adminBotOnboarding: null,
    adminBotOnboardingAcknowledged: true,
    adminBotData: { proposals: [] },
    registrations: [],
    setTab: () => {},
    ...overrides,
  } as unknown as AppViewState;
}

function renderPage(state: AppViewState, role: AccessRole = "admin"): HTMLElement {
  const container = document.createElement("div");
  render(renderDashboard(state, role), container);
  return container;
}

function attentionIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid^="dashboard-attention-"]')].map(
    (node) => node.dataset.testid?.replace("dashboard-attention-", "") ?? "",
  );
}

describe("renderDashboard", () => {
  it("says nothing is waiting when nothing is", () => {
    const container = renderPage(createState());
    expect(attentionIds(container)).toEqual([]);
    expect(container.querySelector(".dashboard__empty")).not.toBeNull();
  });

  // The checklist itself is not one of the click-to-open attention cards -- it is the standing
  // warning rendered inline, above the attention stack, until explicitly acknowledged.
  it("shows the onboarding checklist inline at the top of the dashboard when unacknowledged", () => {
    const container = renderPage(
      createState({
        adminBotOnboarding: {
          steps: ONBOARDING_STEPS,
          completed: [ONBOARDING_STEPS[0]],
          remaining: ONBOARDING_STEPS.slice(1),
        },
        adminBotOnboardingAcknowledged: false,
      } as unknown as Partial<AppViewState>),
    );
    expect(container.querySelector('[data-testid="dashboard-onboarding-warning"]')).not.toBeNull();
    expect(container.textContent).toContain("1 of 3 done");
    expect(container.textContent).toContain("Request compute access");
    expect(attentionIds(container)).not.toContain("onboarding");
  });

  it("hides the onboarding warning once acknowledged, regardless of steps left", () => {
    const container = renderPage(
      createState({
        adminBotOnboarding: {
          steps: ONBOARDING_STEPS,
          completed: [ONBOARDING_STEPS[0]],
          remaining: ONBOARDING_STEPS.slice(1),
        },
        adminBotOnboardingAcknowledged: true,
      } as unknown as Partial<AppViewState>),
    );
    expect(container.querySelector('[data-testid="dashboard-onboarding-warning"]')).toBeNull();
  });

  it("acknowledging the checklist from the dashboard flips the flag", () => {
    const state = createState({
      adminBotOnboarding: {
        steps: ONBOARDING_STEPS,
        completed: [ONBOARDING_STEPS[0]],
        remaining: ONBOARDING_STEPS.slice(1),
      },
      adminBotOnboardingAcknowledged: false,
    } as unknown as Partial<AppViewState>);
    const container = renderPage(state);
    container
      .querySelector<HTMLButtonElement>('[data-testid="dashboard-onboarding-acknowledge"]')
      ?.click();
    expect(state.adminBotOnboardingAcknowledged).toBe(true);
  });

  // Only pending rows are work; approved and executed ones are history.
  it("counts only pending queue rows", () => {
    const container = renderPage(
      createState({
        adminBotData: {
          proposals: [
            { id: "a", status: "pending" },
            { id: "b", status: "executed" },
          ],
        },
        registrations: [
          { id: "r1", status: "pending" },
          { id: "r2", status: "approved" },
        ],
      } as unknown as Partial<AppViewState>),
    );
    expect(attentionIds(container)).toEqual(["proposals", "registrations"]);
    expect(container.textContent).toContain("1 proposed by AdminBot.");
    expect(container.textContent).toContain("1 pending request.");
  });

  // The page must never show a person work their role cannot do.
  it("keeps the admin queues out of a member's view", () => {
    const container = renderPage(
      createState({
        adminBotData: { proposals: [{ id: "a", status: "pending" }] },
        registrations: [{ id: "r1", status: "pending" }],
      } as unknown as Partial<AppViewState>),
      "member",
    );
    expect(attentionIds(container)).toEqual([]);
  });

  // The summaries are the dashboard's whole second band; they must reflect the pages they stand
  // for rather than restating the navigation.
  it("summarises the profile and the work page", () => {
    const container = renderPage(
      createState({
        memberId: "m1",
        adminBotData: {
          proposals: [],
          members: [{ id: "m1", name: "Ada", role: "PhD Student", projects: ["Alignment"] }],
          papers: [{ id: "p1", title: "A paper", authors: ["Ada"], current_step: "submission" }],
        },
        myWorkBlockers: [
          { id: "b1", paperId: "p1", paperTitle: "A paper", text: "Stuck", createdAt: 0 },
        ],
      } as unknown as Partial<AppViewState>),
      "member",
    );
    const profile = container.querySelector('[data-testid="dashboard-summary-profile"]');
    const work = container.querySelector('[data-testid="dashboard-summary-myWork"]');
    expect(profile?.textContent).toContain("fields still blank");
    expect(work?.textContent).toContain("1 project or paper");
    // The summary shows the same step name the work page and Active Papers use.
    expect(work?.textContent).toContain("Submission");
    expect(work?.textContent).toContain("1 blocker awaiting review.");
  });

  it("says so when a profile has no blanks and no work is blocked", () => {
    const container = renderPage(
      createState({
        memberId: "m1",
        adminBotData: {
          proposals: [],
          members: [
            {
              id: "m1",
              name: "Ada",
              role: "PhD Student",
              affiliation: "Jinesis Lab",
              location: "Toronto",
              timezone: "America/Toronto",
              slack_user_id: "U1",
              personal_website: "https://example.com",
              hours_per_week: 40,
              research_topics: ["alignment"],
              projects: ["Alignment"],
              avatar_url: "https://example.com/ada.jpg",
              cv_url: "https://example.com/ada.pdf",
              linkedin_url: "https://linkedin.com/in/ada",
              twitter_url: "https://x.com/ada",
              github_url: "https://github.com/ada",
              scholar_url: "https://scholar.google.com/ada",
            },
          ],
          papers: [],
        },
      } as unknown as Partial<AppViewState>),
      "member",
    );
    const profile = container.querySelector('[data-testid="dashboard-summary-profile"]');
    expect(profile?.textContent).toContain("Your profile is complete.");
    expect(
      container.querySelector('[data-testid="dashboard-summary-myWork"]')?.textContent,
    ).toContain("Nothing is blocked.");
  });

  it("drops the profile summary when there is no member record to summarise", () => {
    const container = renderPage(createState(), "member");
    expect(container.querySelector('[data-testid="dashboard-summary-profile"]')).toBeNull();
    expect(container.querySelector('[data-testid="dashboard-summary-myWork"]')).not.toBeNull();
  });

  // A blank mandatory field never blocks saving or leaving the profile editor (see profile.ts),
  // so this card -- not a save-time block -- is how the dashboard surfaces the gap.
  it("warns about blank required fields and links to the profile page", () => {
    const state = createState({
      memberId: "m1",
      adminBotData: {
        proposals: [],
        members: [{ id: "m1", name: "Ada" }], // every required field but name is blank
      },
    } as unknown as Partial<AppViewState>);
    state.setTab = (tab: Tab) => {
      state.tab = tab;
    };
    const container = renderPage(state, "member");

    expect(attentionIds(container)).toContain("mandatoryFields");
    expect(container.textContent).toContain("required fields are still blank");

    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="dashboard-attention-mandatoryFields"] button',
      )
      ?.click();
    expect(state.tab).toBe("profile");
  });

  it("drops the mandatory-fields item once every required field is filled in", () => {
    const container = renderPage(
      createState({
        memberId: "m1",
        adminBotData: {
          proposals: [],
          members: [
            {
              id: "m1",
              name: "Ada",
              role: "PhD Student",
              affiliation: "Jinesis Lab",
              location: "Toronto",
              timezone: "America/Toronto",
              slack_user_id: "U1",
              hours_per_week: 40,
              research_topics: ["alignment"],
              projects: ["Alignment"],
            },
          ],
        },
      } as unknown as Partial<AppViewState>),
      "member",
    );
    expect(attentionIds(container)).not.toContain("mandatoryFields");
  });
});
