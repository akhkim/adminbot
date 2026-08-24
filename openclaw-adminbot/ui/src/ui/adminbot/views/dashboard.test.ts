import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import type { AccessRole } from "../access.ts";
import { renderDashboard } from "./dashboard.ts";

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

  it("uses the complete public deadline board instead of a dashboard-only summary", async () => {
    const container = renderPage(createState(), "member");
    document.body.append(container);
    const board = container.querySelector("adminbot-deadlines-view") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    await board.updateComplete;

    expect(container.querySelector("adminbot-deadline-summary")).toBeNull();
    expect(container.querySelector('[data-testid="dashboard-deadlines"]')).not.toBeNull();
    expect(board.querySelector('.deadline-board__search input[type="search"]')).not.toBeNull();
    expect(board.querySelector('[data-testid="deadline-group-all"]')).not.toBeNull();
    expect(
      [...board.querySelectorAll<HTMLElement>(".deadline-group")].reduce(
        (total, group) => total + Number(group.dataset.count),
        0,
      ),
    ).toBeGreaterThan(100);
    expect(board.textContent).toContain("Upcoming conference & workshop deadlines.");
    container.remove();
  });

  // A blank mandatory field never blocks saving or leaving the profile editor (see profile.ts),
  // so this card is how the gap gets surfaced. It navigates to the editor, which is its own tab
  // again.
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

  // Naming a blank field is only half the help: the name is the shortest route to the box that
  // answers it.
  it("lists each blank field as a button that opens the profile", () => {
    const state = createState({
      memberId: "m1",
      setTab: vi.fn(),
      adminBotData: {
        proposals: [],
        members: [{ id: "m1", name: "Ada" }],
      },
    } as unknown as Partial<AppViewState>);
    const container = renderPage(state, "member");

    const chips = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-testid^="dashboard-blank-"]'),
    ];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((chip) => chip.tagName === "BUTTON")).toBe(true);
    chips[0]?.click();
    expect(state.setTab).toHaveBeenCalledWith("profile");
  });

  // A new member has a dozen blanks. Naming them all wrapped the card to four rows and pushed
  // everything under it off the screen, so the card names the first few and counts the rest.
  it("caps the named blanks and counts the remainder", () => {
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

    const card = container.querySelector('[data-testid="dashboard-attention-mandatoryFields"]')!;
    const chips = card.querySelectorAll('[data-testid^="dashboard-blank-"]');
    expect(chips.length).toBe(5);
    expect(card.querySelector(".dashboard-card__step--more")?.textContent?.trim()).toMatch(
      /^\+\d+ more$/u,
    );
  });

  // The URN is filled in by an admin, so chasing the member for it names a field whose control on
  // the profile page is disabled.
  it("never lists an admin-filled field among the blanks", () => {
    const container = renderPage(
      createState({
        memberId: "m1",
        adminBotData: {
          proposals: [],
          members: [{ id: "m1", name: "Ada" }],
        },
      } as unknown as Partial<AppViewState>),
      "member",
    );

    expect(container.querySelector('[data-testid="dashboard-blank-linkedin_urn"]')).toBeNull();
  });

  it("drops the mandatory-fields item once every required field is filled in", () => {
    const container = renderPage(
      createState({
        memberId: "m1",
        adminBotData: {
          proposals: [],
          members: [
            {
              // The mandatory set is the member sheet's own columns, plus the CV.
              id: "m1",
              name: "Ada",
              location: "Toronto",
              research_topics: ["alignment"],
              joined_month: "2026-03",
              correspondence_email: "ada@cs.toronto.edu",
              calendar_email: "ada@gmail.com",
              whatsapp: "(+1) 555 0100",
              openreview_id: "~Ada_Lovelace1",
              github_url: "https://github.com/ada",
              linkedin_url: "https://www.linkedin.com/in/ada",
              cv_url: "https://ada.dev/cv.pdf",
              intake_form_url: "https://docs.google.com/forms/d/e/ada/viewform",
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
