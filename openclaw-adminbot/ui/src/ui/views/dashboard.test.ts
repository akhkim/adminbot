import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { AccessRole } from "../access.ts";
import type { AppViewState } from "../app-view-state.ts";
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
    adminBotWelcomeVisible: false,
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

  it("puts unfinished onboarding at the top", () => {
    const container = renderPage(
      createState({
        adminBotOnboarding: {
          steps: ONBOARDING_STEPS,
          completed: [ONBOARDING_STEPS[0]],
          remaining: ONBOARDING_STEPS.slice(1),
        },
      } as unknown as Partial<AppViewState>),
    );
    expect(attentionIds(container)[0]).toBe("onboarding");
    expect(container.textContent).toContain("1 of 3 done");
    expect(container.textContent).toContain("Request compute access");
  });

  it("drops the onboarding item once every step is done", () => {
    const container = renderPage(
      createState({
        adminBotOnboarding: {
          steps: ONBOARDING_STEPS,
          completed: ONBOARDING_STEPS,
          remaining: [],
        },
      } as unknown as Partial<AppViewState>),
    );
    expect(attentionIds(container)).toEqual([]);
  });

  it("hands the onboarding checklist off rather than rebuilding it", () => {
    const state = createState({
      adminBotOnboarding: {
        steps: ONBOARDING_STEPS,
        completed: [ONBOARDING_STEPS[0]],
        remaining: ONBOARDING_STEPS.slice(1),
      },
    } as unknown as Partial<AppViewState>);
    const container = renderPage(state);
    container
      .querySelector<HTMLButtonElement>('[data-testid="dashboard-attention-onboarding"] button')
      ?.click();
    expect(state.adminBotWelcomeVisible).toBe(true);
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
          papers: [
            { id: "p1", title: "A paper", authors: ["Ada"], current_step: "submission" },
          ],
        },
        myWorkBlockers: [{ id: "b1", paperId: "p1", paperTitle: "A paper", text: "Stuck", createdAt: 0 }],
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
    expect(container.querySelector('[data-testid="dashboard-summary-myWork"]')?.textContent).toContain(
      "Nothing is blocked.",
    );
  });

  it("drops the profile summary when there is no member record to summarise", () => {
    const container = renderPage(createState(), "member");
    expect(container.querySelector('[data-testid="dashboard-summary-profile"]')).toBeNull();
    expect(container.querySelector('[data-testid="dashboard-summary-myWork"]')).not.toBeNull();
  });
});
