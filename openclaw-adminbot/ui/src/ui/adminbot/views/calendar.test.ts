import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../../app-view-state.ts";
import type { AdminBotLabMember, AdminBotPaperRecord } from "../controllers/admin.ts";
import { calendarInviteSelection, renderAdminBotCalendar } from "./calendar.ts";

function member(overrides: Partial<AdminBotLabMember> = {}): AdminBotLabMember {
  return {
    id: "m1",
    name: "Ada Lovelace",
    email: "ada@cs.toronto.edu",
    privilege_level: "member",
    access: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as AdminBotLabMember;
}

function paper(overrides: Partial<AdminBotPaperRecord> = {}): AdminBotPaperRecord {
  return {
    id: "p1",
    title: "On analytical engines",
    authors: ["Ada Lovelace"],
    current_step: "drafting",
    artifacts: { conference: "NeurIPS 2026" },
    ...overrides,
  } as AdminBotPaperRecord;
}

function state(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    adminBotData: {
      members: [member()],
      papers: [paper()],
      proposals: [],
      executions: [],
      nudges: [],
      settings: null,
      sensitiveInfo: null,
      loadedAt: Date.now(),
    },
    calendarEvents: [
      {
        id: "evt-1",
        summary: "Lab retreat",
        start: "2026-09-01T13:00:00-04:00",
        end: "2026-09-01T17:00:00-04:00",
        location: "DCS lounge",
      },
    ],
    ...overrides,
  } as unknown as AppViewState;
}

function renderToDiv(view: AppViewState): HTMLElement {
  const container = document.createElement("div");
  render(renderAdminBotCalendar(view), container);
  return container;
}

describe("the draft panel", () => {
  it("will not draft an empty prompt", () => {
    const container = renderToDiv(state({ calendarPrompt: "  " } as Partial<AppViewState>));
    const submit = container.querySelector<HTMLButtonElement>(
      '[data-testid="calendar-draft-submit"]',
    );
    expect(submit?.disabled).toBe(true);
  });

  it("asks the controller for a draft on submit", () => {
    const requestCalendarDraft = vi.fn().mockResolvedValue(undefined);
    const container = renderToDiv(
      state({
        calendarPrompt: "lunch tuesday at 1",
        requestCalendarDraft,
      } as Partial<AppViewState>),
    );
    container
      .querySelector<HTMLFormElement>('[data-testid="calendar-draft-panel"] form')
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(requestCalendarDraft).toHaveBeenCalledTimes(1);
  });

  // The model's answer is a draft, not a decision: every field is editable before it is filed.
  it("shows the returned draft in editable fields", () => {
    const container = renderToDiv(
      state({
        calendarDraft: {
          summary: "Reading group lunch",
          start: "2026-08-18T13:00",
          end: "2026-08-18T14:00",
          location: "DCS lounge",
          timezone: "America/Toronto",
        },
      } as Partial<AppViewState>),
    );
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="calendar-draft-summary"]')?.value,
    ).toBe("Reading group lunch");
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="calendar-draft-start"]')?.value,
    ).toBe("2026-08-18T13:00");
    expect(container.textContent).toContain("America/Toronto");
  });

  it("surfaces the reason a draft was refused", () => {
    const container = renderToDiv(
      state({ calendarDraftError: "the draft ends before it starts" } as Partial<AppViewState>),
    );
    expect(container.textContent).toContain("the draft ends before it starts");
  });
});

describe("the invite panel", () => {
  // Nobody is invited by default: an empty filter set is a forgotten filter, not "everyone".
  it("selects nobody until a filter is set", () => {
    const container = renderToDiv(state());
    expect(container.querySelector('[data-testid="calendar-matches"]')).toBeNull();
    expect(container.querySelector('[data-testid="calendar-no-matches"]')?.textContent).toContain(
      "Pick at least one filter",
    );
  });

  it("lists who matches and why", () => {
    const container = renderToDiv(
      state({ calendarAudience: { conference: "NeurIPS 2026" } } as Partial<AppViewState>),
    );
    const matches = container.querySelector('[data-testid="calendar-matches"]');
    expect(matches?.textContent).toContain("Ada Lovelace");
    expect(matches?.textContent).toContain("ada@cs.toronto.edu");
    expect(matches?.textContent).toContain("writing for NeurIPS 2026");
  });

  it("points back at the calendar when no event is selected", () => {
    const container = renderToDiv(state());
    expect(container.querySelector('[data-testid="calendar-no-event"]')?.textContent).toContain(
      "Pick an event on the calendar above",
    );
    expect(container.querySelector('[data-testid="calendar-selected-event"]')).toBeNull();
  });

  it("names the selected event, and what it already has", () => {
    const container = renderToDiv(
      state({
        calendarSelectedEventId: "evt-1",
        calendarEvents: [
          {
            id: "evt-1",
            summary: "Lab retreat",
            start: "2026-09-01T13:00:00-04:00",
            location: "DCS lounge",
            attendees: ["ada@cs.toronto.edu"],
          },
        ],
      } as Partial<AppViewState>),
    );
    const selected = container.querySelector('[data-testid="calendar-selected-event"]');
    expect(selected?.textContent).toContain("Lab retreat");
    expect(selected?.textContent).toContain("1 already invited");
  });

  it("cannot send until an event is picked", () => {
    const container = renderToDiv(
      state({ calendarAudience: { conference: "NeurIPS 2026" } } as Partial<AppViewState>),
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="calendar-send-invite"]',
    );
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Pick an event");
  });

  it("counts the people on the button once an event is picked", () => {
    const container = renderToDiv(
      state({
        calendarAudience: { conference: "NeurIPS 2026" },
        calendarSelectedEventId: "evt-1",
      } as Partial<AppViewState>),
    );
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="calendar-send-invite"]',
    );
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toContain("(1)");
  });

  // Someone with no address would otherwise be counted on screen and then quietly missing from the
  // invite that goes out.
  it("names a matching member who has no address", () => {
    const container = renderToDiv(
      state({
        adminBotData: {
          members: [member({ id: "m2", name: "Mei Chen", email: undefined, location: "Toronto" })],
          papers: [],
          proposals: [],
          executions: [],
          nudges: [],
          settings: null,
          sensitiveInfo: null,
          loadedAt: Date.now(),
        },
        calendarAudience: { homeCity: "Toronto" },
      } as unknown as Partial<AppViewState>),
    );
    expect(container.querySelector('[data-testid="calendar-unreachable"]')?.textContent).toContain(
      "Mei Chen",
    );
  });

  it("reports an unreadable calendar rather than an empty one", () => {
    const container = renderToDiv(
      state({
        calendarEvents: [],
        calendarEventsError: "could not read the calendar: gog: no token",
      } as Partial<AppViewState>),
    );
    expect(container.textContent).toContain("could not read the calendar");
    expect(container.querySelector('[data-testid="calendar-events-empty"]')).toBeNull();
  });
});

// These buttons really send, so the second click is the safety. A first click only arms it.
describe("the two-step send", () => {
  const armed = {
    calendarAudience: { conference: "NeurIPS 2026" },
    calendarSelectedEventId: "evt-1",
  } as Partial<AppViewState>;

  it("arms on the first click and sends on the second", () => {
    const sendCalendarInvites = vi.fn().mockResolvedValue(undefined);
    const view = state({ ...armed, sendCalendarInvites } as Partial<AppViewState>);
    let container = renderToDiv(view);
    container
      .querySelector<HTMLButtonElement>('[data-testid="calendar-send-invite"]')
      ?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(sendCalendarInvites).not.toHaveBeenCalled();
    expect(view.calendarConfirming).toBe("invite");

    container = renderToDiv(view);
    expect(
      container.querySelector('[data-testid="calendar-invite-confirm"]')?.textContent,
    ).toContain("Lab retreat");
    container
      .querySelector<HTMLButtonElement>('[data-testid="calendar-send-invite"]')
      ?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(sendCalendarInvites).toHaveBeenCalledTimes(1);
  });

  // Consent to mail one set of people is not consent to mail a different one.
  it("disarms when the filter changes", () => {
    const view = state({ ...armed, calendarConfirming: "invite" } as Partial<AppViewState>);
    const container = renderToDiv(view);
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="calendar-filter-home-city"]',
    );
    select!.value = "";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(view.calendarConfirming).toBeNull();
  });
});

describe("editing an event with a prompt", () => {
  // Clicking the event on the calendar is how you aim the assistant at it — there is one picker,
  // and picking is what starts an edit.
  it("aims the assistant at the event and clears the draft that was there", () => {
    const view = state({
      calendarMonth: "2026-09-01",
      calendarEvents: [{ id: "evt-1", summary: "Lab retreat", start: "2026-09-15T13:00:00-04:00" }],
      calendarDraft: {
        summary: "Old draft",
        start: "2026-08-18T13:00",
        end: "2026-08-18T14:00",
      },
    } as Partial<AppViewState>);
    const container = renderToDiv(view);
    container
      .querySelector<HTMLButtonElement>('[data-testid="calendar-chip-evt-1"]')
      ?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(view.calendarEditingEventId).toBe("evt-1");
    expect(view.calendarDraft).toBeNull();
  });

  it("says which event it is changing, and offers a way out", () => {
    const view = state({ calendarEditingEventId: "evt-1" } as Partial<AppViewState>);
    const container = renderToDiv(view);
    expect(container.querySelector('[data-testid="calendar-editing"]')?.textContent).toContain(
      "Lab retreat",
    );
    container
      .querySelector<HTMLButtonElement>('[data-testid="calendar-editing-clear"]')
      ?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(view.calendarEditingEventId).toBeNull();
  });

  it("labels the save as an update while an event is being edited", () => {
    const container = renderToDiv(
      state({
        calendarEditingEventId: "evt-1",
        calendarDraft: {
          summary: "Lab retreat",
          start: "2026-09-01T15:00",
          end: "2026-09-01T17:00",
        },
      } as Partial<AppViewState>),
    );
    expect(container.querySelector('[data-testid="calendar-save-event"]')?.textContent).toContain(
      "Update this event",
    );
  });
});

describe("the month grid", () => {
  const september = {
    calendarMonth: "2026-09-01",
    calendarEvents: [
      {
        id: "evt-1",
        summary: "Lab retreat",
        start: "2026-09-15T13:00:00-04:00",
        end: "2026-09-15T17:00:00-04:00",
      },
      { id: "evt-2", summary: "Reading week", start: "2026-09-21", all_day: true },
    ],
    calendarSource: {
      id: "jinesis.lab@gmail.com",
      timezone: "America/Toronto",
      embed_url:
        "https://calendar.google.com/calendar/embed?src=jinesis.lab%40gmail.com&ctz=America%2FToronto",
    },
  } as Partial<AppViewState>;

  it("draws the month with a cell per day and the events on their own days", () => {
    const container = renderToDiv(state(september));
    expect(container.querySelector('[data-testid="calendar-grid"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="calendar-day-2026-09-15"]')?.textContent,
    ).toContain("Lab retreat");
    expect(
      container.querySelector('[data-testid="calendar-day-2026-09-21"]')?.textContent,
    ).toContain("Reading week");
    // Not on a day it does not belong to.
    expect(
      container.querySelector('[data-testid="calendar-day-2026-09-16"]')?.textContent,
    ).not.toContain("Lab retreat");
  });

  it("names the month and offers the calendar it is drawing", () => {
    const container = renderToDiv(state(september));
    expect(container.querySelector('[data-testid="calendar-month"]')?.textContent).toContain(
      "September 2026",
    );
    expect(
      container.querySelector('[data-testid="calendar-embed-link"]')?.getAttribute("href"),
    ).toContain("jinesis.lab%40gmail.com");
  });

  // Moving months has to fetch that month, or the grid is empty past whatever the first load
  // happened to cover.
  it("reloads when the month changes", () => {
    const loadCalendarEvents = vi.fn().mockResolvedValue(undefined);
    const view = state({ ...september, loadCalendarEvents } as Partial<AppViewState>);
    const container = renderToDiv(view);
    container
      .querySelector<HTMLButtonElement>('[data-testid="calendar-month-next"]')
      ?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(view.calendarMonth).toBe("2026-10-01");
    expect(loadCalendarEvents).toHaveBeenCalledTimes(1);
  });

  // One click on an event is how you reach both of the things you can do to an existing one.
  it("selects an event and aims the assistant at it when a chip is clicked", () => {
    const view = state(september);
    const container = renderToDiv(view);
    container
      .querySelector<HTMLButtonElement>('[data-testid="calendar-chip-evt-1"]')
      ?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(view.calendarSelectedEventId).toBe("evt-1");
    expect(view.calendarEditingEventId).toBe("evt-1");
  });

  // An empty grid looks identical whether the month is genuinely free or nothing was ever read,
  // which is exactly the confusion that cost a debugging session.
  it("says which calendar and month were empty rather than just drawing nothing", () => {
    const container = renderToDiv(
      state({ ...september, calendarEvents: [] } as Partial<AppViewState>),
    );
    const note = container.querySelector('[data-testid="calendar-empty-month"]')?.textContent;
    expect(note).toContain("jinesis.lab@gmail.com");
    expect(note).toContain("September 2026");
  });

  it("does not claim the month is empty when the read failed", () => {
    const container = renderToDiv(
      state({
        ...september,
        calendarEvents: [],
        calendarEventsError: "could not read the calendar",
      } as Partial<AppViewState>),
    );
    expect(container.querySelector('[data-testid="calendar-empty-month"]')).toBeNull();
  });

  it("reports an unreadable calendar on the grid itself", () => {
    const container = renderToDiv(
      state({
        ...september,
        calendarEvents: [],
        calendarEventsError: "could not read the calendar: gog: no token",
      } as Partial<AppViewState>),
    );
    expect(container.querySelector('[data-testid="calendar-month"]')?.textContent).toContain(
      "could not read the calendar",
    );
  });
});

describe("the assistant", () => {
  it("greets with an example instead of an empty box", () => {
    const container = renderToDiv(state());
    expect(
      container.querySelector('[data-testid="calendar-chat-greeting"]')?.textContent,
    ).toContain("reading group");
  });

  it("shows the exchange as a conversation", () => {
    const container = renderToDiv(
      state({
        calendarMessages: [
          { role: "user", content: "lunch tuesday at 1" },
          { role: "assistant", content: 'Drafted "Reading group lunch".' },
        ],
      } as Partial<AppViewState>),
    );
    const log = container.querySelector('[role="log"]');
    expect(log?.textContent).toContain("lunch tuesday at 1");
    expect(log?.textContent).toContain("Reading group lunch");
    expect(log?.querySelectorAll(".adminbot-calendar__message--user")).toHaveLength(1);
    expect(log?.querySelectorAll(".adminbot-calendar__message--assistant")).toHaveLength(1);
  });

  it("says it is working while a draft is in flight", () => {
    const container = renderToDiv(state({ calendarDraftBusy: true } as Partial<AppViewState>));
    expect(container.querySelector('[data-testid="calendar-chat-thinking"]')).not.toBeNull();
  });

  it("clears the conversation on Start over", () => {
    const view = state({
      calendarMessages: [{ role: "user", content: "x" }],
      calendarDraft: { summary: "x", start: "2026-08-18T13:00", end: "2026-08-18T14:00" },
      calendarEditingEventId: "evt-1",
    } as Partial<AppViewState>);
    const container = renderToDiv(view);
    container
      .querySelector<HTMLButtonElement>('[data-testid="calendar-chat-reset"]')
      ?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(view.calendarMessages).toEqual([]);
    expect(view.calendarDraft).toBeNull();
    expect(view.calendarEditingEventId).toBeNull();
  });

  it("says the draft card is empty rather than showing blank fields", () => {
    const container = renderToDiv(state());
    expect(container.querySelector('[data-testid="calendar-draft-empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="calendar-draft"]')).toBeNull();
  });
});

describe("calendarInviteSelection", () => {
  it("carries the addresses and states the filter that chose them", () => {
    const selection = calendarInviteSelection(
      state({
        calendarAudience: { conference: "NeurIPS 2026", homeCity: "Toronto" },
        calendarSelectedEventId: "evt-1",
        adminBotData: {
          members: [member({ location: "Toronto, ON" })],
          papers: [paper()],
          proposals: [],
          executions: [],
          nudges: [],
          settings: null,
          sensitiveInfo: null,
          loadedAt: Date.now(),
        },
      } as unknown as Partial<AppViewState>),
    );
    expect(selection.event?.id).toBe("evt-1");
    expect(selection.emails).toEqual(["ada@cs.toronto.edu"]);
    expect(selection.reason).toContain("writing for NeurIPS 2026");
    expect(selection.reason).toContain("based in Toronto");
  });

  // An operator who unticks one person must not have to abandon a filter that is right for the
  // rest.
  it("drops the people the operator unticked", () => {
    const selection = calendarInviteSelection(
      state({
        calendarAudience: { conference: "NeurIPS 2026" },
        calendarSelectedEventId: "evt-1",
        calendarExcludedMemberIds: ["m1"],
      } as Partial<AppViewState>),
    );
    expect(selection.emails).toEqual([]);
  });
});
