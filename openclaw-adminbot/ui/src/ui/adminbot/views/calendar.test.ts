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
  it("aims the instruction box at the event and clears what was there", () => {
    const view = state({
      calendarPrompt: "half-typed instruction for something else",
      calendarDraft: {
        summary: "Old draft",
        start: "2026-08-18T13:00",
        end: "2026-08-18T14:00",
      },
    } as Partial<AppViewState>);
    const container = renderToDiv(view);
    container
      .querySelector<HTMLButtonElement>('[data-testid="calendar-edit-evt-1"]')
      ?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(view.calendarEditingEventId).toBe("evt-1");
    expect(view.calendarPrompt).toBe("");
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

describe("the embed", () => {
  it("shows the calendar the service says it read", () => {
    const container = renderToDiv(
      state({
        calendarSource: {
          id: "jinesis.lab@gmail.com",
          timezone: "America/Toronto",
          embed_url:
            "https://calendar.google.com/calendar/embed?src=jinesis.lab%40gmail.com&ctz=America%2FToronto",
        },
      } as Partial<AppViewState>),
    );
    const frame = container.querySelector<HTMLIFrameElement>(".adminbot-calendar__embed");
    expect(frame?.getAttribute("src")).toContain("jinesis.lab%40gmail.com");
    expect(container.querySelector('[data-testid="calendar-embed"]')?.textContent).toContain(
      "America/Toronto",
    );
  });

  // Before the first read the tab does not know which calendar it is on, and guessing one would
  // show a calendar the writes do not touch.
  it("shows no calendar until the service names one", () => {
    expect(renderToDiv(state()).querySelector('[data-testid="calendar-embed"]')).toBeNull();
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
