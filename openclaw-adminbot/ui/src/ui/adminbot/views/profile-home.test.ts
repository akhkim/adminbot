import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import type { AccessRole } from "../access.ts";
import { renderProfileHome } from "./profile-home.ts";

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    tab: "profile",
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
  render(renderProfileHome(state, role), container);
  return container;
}

function attentionIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid^="dashboard-attention-"]')].map(
    (node) => node.dataset.testid?.replace("dashboard-attention-", "") ?? "",
  );
}

describe("renderProfileHome", () => {
  it("says nothing is waiting when nothing is", () => {
    const container = renderPage(createState());
    expect(attentionIds(container)).toEqual([]);
    expect(container.querySelector(".dashboard__empty")).not.toBeNull();
  });

  // The onboarding checklist is no longer part of this band at all: it moved to the bottom of the
  // profile page, composed in app-render.ts, and is covered by onboarding-checklist.test.ts.
  it("leaves the onboarding checklist to the bottom of the page", () => {
    const container = renderPage(
      createState({
        adminBotOnboarding: {
          steps: [
            {
              id: "slack",
              label: "Join the lab Slack",
              status: "current",
              category: "Getting started",
              required: true,
            },
          ],
          completed: [],
          remaining: [],
        },
        adminBotOnboardingAcknowledged: false,
      } as unknown as Partial<AppViewState>),
    );
    expect(container.querySelector('[data-testid="dashboard-onboarding-warning"]')).toBeNull();
  });

  it("counts only pending queue rows", () => {
    const container = renderPage(
      createState({
        adminBotData: {
          proposals: [
            { id: "a", status: "pending" },
            { id: "b", status: "executed" },
          ],
          members: [],
          papers: [],
        },
        registrations: [
          { id: "r1", status: "pending" },
          { id: "r2", status: "approved" },
        ],
      } as unknown as Partial<AppViewState>),
    );
    expect(attentionIds(container)).toEqual(["proposals", "registrations"]);
    expect(container.textContent).toContain("1");
  });

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

  // The profile summary card that used to sit beside this one is gone: it summarised the page it
  // was printed on. The work summary stands for a page the viewer would actually navigate to.
  it("summarises the work page and no longer summarises the profile it sits on", () => {
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
              projects: ["Alignment"],
            },
          ],
          papers: [
            {
              id: "p1",
              title: "A paper",
              authors: ["Ada"],
              current_step: "submission",
            },
          ],
        },
        myWorkBlockers: [
          {
            id: "b1",
            paperId: "p1",
            paperTitle: "A paper",
            text: "Stuck",
            createdAt: 0,
          },
        ],
      } as unknown as Partial<AppViewState>),
      "member",
    );
    expect(container.querySelector('[data-testid="dashboard-summary-profile"]')).toBeNull();

    const work = container.querySelector('[data-testid="dashboard-summary-myWork"]');
    expect(work?.textContent).toContain("1 project or paper");
    // The summary shows the same step name the work page and Active Papers use.
    expect(work?.textContent).toContain("Submission");
    expect(work?.textContent).toContain("1 blocker awaiting review.");
  });

  it("says so when no work is blocked", () => {
    const container = renderPage(
      createState({
        memberId: "m1",
        adminBotData: {
          proposals: [],
          members: [{ id: "m1", name: "Ada" }],
          papers: [],
        },
      } as unknown as Partial<AppViewState>),
      "member",
    );
    expect(
      container.querySelector('[data-testid="dashboard-summary-myWork"]')?.textContent,
    ).toContain("Nothing is blocked.");
  });

  it("puts the deadline summary beside the work summary", () => {
    const container = renderPage(createState(), "member");
    expect(container.querySelector("adminbot-deadline-summary")).not.toBeNull();
  });

  // A blank mandatory field never blocks saving or leaving the profile editor (see profile.ts),
  // so this card is how the gap gets surfaced. It now scrolls to the editor rather than navigating
  // to it, because the editor is further down the same page.
  it("warns about blank required fields", () => {
    const container = renderPage(
      createState({
        memberId: "m1",
        adminBotData: {
          proposals: [],
          members: [{ id: "m1", name: "Ada" }], // every required field but name is blank
        },
      } as unknown as Partial<AppViewState>),
      "member",
    );

    expect(attentionIds(container)).toContain("mandatoryFields");
    expect(container.textContent).toContain("required fields are still blank");
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
              linkedin_urn: "ACoAAB1234567",
            },
          ],
        },
      } as unknown as Partial<AppViewState>),
      "member",
    );
    expect(attentionIds(container)).not.toContain("mandatoryFields");
  });
});
