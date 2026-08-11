import { render } from "lit";
import { describe, expect, it } from "vitest";
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

  it("puts the deadline summary beside the work summary", () => {
    const container = renderPage(createState(), "member");
    expect(container.querySelector("adminbot-deadline-summary")).not.toBeNull();
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

  // A count alone ("6 required fields are still blank") says there is work without saying what it
  // is, so the card cannot be acted on without opening the profile and hunting.
  it("names the first three blank fields and counts the rest", () => {
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

    const chips = [
      ...container.querySelectorAll('[data-testid="dashboard-mandatory-fields"] .dashboard-card__field'),
    ].map((node) => node.textContent?.trim() ?? "");
    // Three names plus one "+N more".
    expect(chips).toHaveLength(4);
    expect(chips.at(-1)).toMatch(/^\+\d+ more$/u);
    for (const chip of chips.slice(0, 3)) {
      expect(chip).not.toBe("");
      expect(chip.endsWith("more")).toBe(false);
    }
  });

  it("names them without a 'more' chip when three or fewer are blank", () => {
    const container = renderPage(
      createState({
        memberId: "m1",
        adminBotData: {
          proposals: [],
          members: [
            {
              id: "m1",
              name: "Ada",
              location: "Toronto",
              research_topics: ["alignment"],
              joined_month: "2026-03",
              correspondence_email: "ada@cs.toronto.edu",
              whatsapp: "+1 555 0100",
              openreview_id: "~Ada_Lovelace1",
              github_url: "https://github.com/ada",
              linkedin_url: "https://www.linkedin.com/in/ada",
              linkedin_urn: "ACoAAB1234567",
              // calendar_email and cv_url left blank: exactly two.
            },
          ],
        },
      } as unknown as Partial<AppViewState>),
      "member",
    );

    const chips = [
      ...container.querySelectorAll('[data-testid="dashboard-mandatory-fields"] .dashboard-card__field'),
    ];
    expect(chips).toHaveLength(2);
    expect(chips.some((chip) => (chip.textContent ?? "").trim().endsWith("more"))).toBe(false);
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
