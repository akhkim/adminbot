/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import type { AccessRole } from "../access.ts";
import { renderDashboard } from "./dashboard.ts";
import { findOwnMember } from "./profile.ts";

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

  // The whole board used to render here, which made the dashboard mostly a second copy of the
  // Deadlines tab. It is a two-row glance now, and the board is a click away.
  it("shows a two-row deadline glance rather than the whole board", () => {
    const container = renderPage(createState(), "member");
    expect(container.querySelector("adminbot-deadlines-view")).toBeNull();
    const widget = container.querySelector('[data-testid="dashboard-next-deadlines"]');
    expect(widget).not.toBeNull();
    expect(widget?.querySelectorAll(".dashboard__next-deadline")).toHaveLength(2);
    expect(
      container.querySelector('[data-testid="dashboard-next-deadlines-open"]'),
    ).not.toBeNull();
  });

  // The member's own dated milestones are the ones they plan around, so a glance that showed only
  // the public board could say "nothing for weeks" to somebody with a submission on Friday.
  it("merges the member's own milestones into the glance, soonest first", () => {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const state = createState({
      memberId: "ada",
      adminBotData: {
        proposals: [],
        members: [
          {
            id: "ada",
            name: "Ada Lovelace",
            milestones: [{ date: soon, label: "Thesis draft" }],
          },
        ],
      },
    } as unknown as Partial<AppViewState>);
    expect(findOwnMember(state)?.milestones).toHaveLength(1);
    const container = renderPage(state, "member");
    const rows = [
      ...container.querySelectorAll<HTMLElement>(".dashboard__next-deadline"),
    ];
    // Tomorrow beats every conference in the bundled snapshot, so it leads.
    expect(rows[0]?.textContent).toContain("Thesis draft");
    expect(rows[0]?.textContent).toContain("yours");
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

describe("notifications on the dashboard", () => {
  const NOTIFICATION = {
    id: "notif-1",
    member_id: "ada",
    kind: "meeting_attendance" as const,
    title: "Please join the next Monday meeting",
    body: "You have missed the last 2 Monday meetings.",
    tab: "adminbotMeetings",
    created_at: "2026-08-25T09:00:00.000Z",
  };

  it("puts what the lab has told this member above their own housekeeping", () => {
    const container = renderPage(
      createState({
        adminBotNotifications: [NOTIFICATION],
        adminBotData: { proposals: [{ status: "pending" }] },
      } as never),
      "admin",
    );
    // A notification is the lab having decided to say something to this person, which outranks a
    // queue that is merely waiting.
    expect(attentionIds(container)[0]).toBe(`notification-${NOTIFICATION.id}`);
    expect(container.textContent).toContain("missed the last 2 Monday meetings");
  });

  it("warns across the top, in the way, about what is still unanswered", () => {
    // The cards below already list every notification. The banner exists for the ones that were
    // already missed on Slack and in that list, so it must not be scrollable past.
    const container = renderPage(createState({ adminBotNotifications: [NOTIFICATION] } as never));
    const warning = container.querySelector<HTMLElement>('[data-testid="dashboard-nudge-warning"]');
    expect(warning?.dataset.tone).toBe("info");
    expect(warning?.textContent).toContain("Please join the next Monday meeting");
  });

  it("says louder that something important is outstanding, and louder still once escalated", () => {
    const important = renderPage(
      createState({
        adminBotNotifications: [{ ...NOTIFICATION, important: true }],
      } as never),
    );
    expect(
      important.querySelector<HTMLElement>('[data-testid="dashboard-nudge-warning"]')?.dataset.tone,
    ).toBe("warn");

    const escalated = renderPage(
      createState({
        adminBotNotifications: [
          { ...NOTIFICATION, important: true },
          {
            ...NOTIFICATION,
            id: "notif-2",
            title: "Submission ID missing",
            important: true,
            escalated_at: "2026-08-25T09:00:00.000Z",
          },
        ],
      } as never),
    );
    const warning = escalated.querySelector<HTMLElement>('[data-testid="dashboard-nudge-warning"]');
    expect(warning?.dataset.tone).toBe("danger");
    // Once the professor is in a group DM about something, "you have unread reminders" is no
    // longer the news, so the escalated item is what the banner lists.
    expect(warning?.textContent).toContain("Submission ID missing");
    expect(warning?.textContent).not.toContain("Please join the next Monday meeting");
  });

  it("does not warn about what has already been acknowledged", () => {
    const container = renderPage(
      createState({
        adminBotNotifications: [{ ...NOTIFICATION, read_at: "2026-08-25T09:05:00.000Z" }],
      } as never),
    );
    expect(container.querySelector('[data-testid="dashboard-nudge-warning"]')).toBeNull();
  });

  it("acknowledges every unread one at once from the banner", () => {
    const read: unknown[] = [];
    const container = renderPage(
      createState({
        adminBotNotifications: [NOTIFICATION, { ...NOTIFICATION, id: "notif-2" }],
        markNotificationsRead: async (ids: string[]) => {
          read.push(ids);
        },
      } as never),
    );
    container
      .querySelector<HTMLButtonElement>('[data-testid="dashboard-nudge-warning-ack"]')
      ?.click();
    expect(read).toEqual([["notif-1", "notif-2"]]);
  });

  it("keeps showing one that has already been read", () => {
    // Read is "you have seen this", not "you have done it": the reminder stays until they turn up.
    const container = renderPage(
      createState({
        adminBotNotifications: [{ ...NOTIFICATION, read_at: "2026-08-25T09:05:00.000Z" }],
      } as never),
    );
    expect(attentionIds(container)).toContain(`notification-${NOTIFICATION.id}`);
  });

  it("marks it read and opens the tab it names", () => {
    const tabs: string[] = [];
    const read: unknown[] = [];
    const container = renderPage(
      createState({
        adminBotNotifications: [NOTIFICATION],
        setTab: (tab: string) => tabs.push(tab),
        markNotificationsRead: async (ids: string[]) => {
          read.push(ids);
        },
      } as never),
    );
    container
      .querySelector<HTMLButtonElement>(
        `[data-testid="dashboard-attention-notification-${NOTIFICATION.id}"] button`,
      )
      ?.click();
    expect(read).toEqual([[NOTIFICATION.id]]);
    expect(tabs).toEqual(["adminbotMeetings"]);
  });
});
