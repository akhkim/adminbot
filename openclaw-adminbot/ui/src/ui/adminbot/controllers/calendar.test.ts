import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchCalendarEvents = vi.fn();
const draftCalendarEvent = vi.fn();
const createCalendarEvent = vi.fn();
const updateCalendarEvent = vi.fn();

vi.mock("../auth/session.ts", () => ({
  fetchCalendarEvents: (...args: unknown[]) => fetchCalendarEvents(...args),
  draftCalendarEvent: (...args: unknown[]) => draftCalendarEvent(...args),
  createCalendarEvent: (...args: unknown[]) => createCalendarEvent(...args),
  updateCalendarEvent: (...args: unknown[]) => updateCalendarEvent(...args),
  inviteToCalendarEvent: vi.fn(),
  loadStoredMemberSession: () => ({ sessionToken: "token" }),
  resolveAdminBotBaseUrl: () => "http://localhost",
}));

const { loadAdminBotCalendar, requestAdminBotCalendarDraft, saveAdminBotCalendarEvent } =
  await import("./calendar.ts");

type Host = Parameters<typeof loadAdminBotCalendar>[0];

function host(overrides: Partial<Host> = {}): Host {
  return { settings: {}, ...overrides } as Host;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchCalendarEvents.mockResolvedValue({ ok: true, value: { events: [], calendar: null } });
  createCalendarEvent.mockResolvedValue({
    ok: true,
    value: { action_id: "a", status: "executed" },
  });
  updateCalendarEvent.mockResolvedValue({
    ok: true,
    value: { action_id: "a", status: "executed" },
  });
});

describe("loadAdminBotCalendar", () => {
  // The grid draws a whole month. Asking the service for "now onwards" would leave the days
  // earlier this month drawn as empty when they are not — the reader has no way to tell the
  // difference between "nothing booked" and "not fetched".
  it("asks for the whole month it is about to draw, including days already past", async () => {
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    const app = host();
    await loadAdminBotCalendar(app);

    const [params] = fetchCalendarEvents.mock.calls[0] as [{ from: string; to: string }];
    expect(params.from).toBe("2026-09-01T00:00:00.000Z");
    expect(params.to).toBe("2026-10-01T00:00:00.000Z");
    // Pinned, so every later load agrees with what is on screen.
    expect(app.calendarMonth).toBe("2026-09-01");
  });

  it("asks for the month the operator navigated to", async () => {
    const app = host({ calendarMonth: "2026-12-01" });
    await loadAdminBotCalendar(app);

    const [params] = fetchCalendarEvents.mock.calls[0] as [{ from: string; to: string }];
    expect(params.from).toBe("2026-12-01T00:00:00.000Z");
    expect(params.to).toBe("2027-01-01T00:00:00.000Z");
  });

  it("keeps whatever the calendar already holds, not only what this tab created", async () => {
    fetchCalendarEvents.mockResolvedValue({
      ok: true,
      value: {
        events: [{ id: "external-1", summary: "Someone else's meeting", start: "2026-09-02" }],
        calendar: { id: "jinesis.lab@gmail.com", timezone: "America/Toronto", embed_url: "u" },
      },
    });
    const app = host();
    await loadAdminBotCalendar(app);

    expect(app.calendarEvents).toHaveLength(1);
    expect(app.calendarSource?.id).toBe("jinesis.lab@gmail.com");
  });

  // "Empty" and "could not read" look identical on a grid, so a failure has to say so.
  it("reports a read failure instead of drawing an empty month", async () => {
    fetchCalendarEvents.mockResolvedValue({
      ok: false,
      kind: "auth-failed",
      message: "could not read the calendar: gog: no token",
    });
    const app = host();
    await loadAdminBotCalendar(app);

    expect(app.calendarEventsError).toContain("gog: no token");
    expect(app.calendarEvents).toEqual([]);
  });
});

describe("requestAdminBotCalendarDraft", () => {
  it("puts the instruction in the transcript and clears the box", async () => {
    draftCalendarEvent.mockResolvedValue({
      ok: true,
      value: { summary: "Lunch", start: "2026-09-15T13:00", end: "2026-09-15T14:00" },
    });
    const app = host({ calendarPrompt: "lunch tuesday at 1" });
    await requestAdminBotCalendarDraft(app);

    expect(app.calendarMessages?.[0]).toEqual({ role: "user", content: "lunch tuesday at 1" });
    expect(app.calendarMessages?.[1]?.role).toBe("assistant");
    expect(app.calendarMessages?.[1]?.content).toContain("Lunch");
    expect(app.calendarPrompt).toBe("");
  });

  it("says a refusal in the conversation, where the reader is looking", async () => {
    draftCalendarEvent.mockResolvedValue({
      ok: false,
      kind: "auth-failed",
      message: "the draft ends before it starts",
    });
    const app = host({ calendarPrompt: "move it to yesterday" });
    await requestAdminBotCalendarDraft(app);

    expect(app.calendarMessages?.at(-1)).toEqual({
      role: "assistant",
      content: "the draft ends before it starts",
    });
    expect(app.calendarDraftError).toBe("the draft ends before it starts");
  });

  it("tells the model what the event says when one is being changed", async () => {
    draftCalendarEvent.mockResolvedValue({
      ok: true,
      value: { summary: "Retreat", start: "2026-09-15T13:00", end: "2026-09-15T14:00" },
    });
    const app = host({
      calendarPrompt: "move it to Thursday",
      calendarEditingEventId: "evt-1",
      calendarEvents: [
        { id: "evt-1", summary: "Retreat", start: "2026-09-01T13:00:00-04:00", location: "Lounge" },
      ],
    });
    await requestAdminBotCalendarDraft(app);

    const [request] = draftCalendarEvent.mock.calls[0] as [{ editing?: { summary: string } }];
    expect(request.editing).toMatchObject({ summary: "Retreat", location: "Lounge" });
  });
});

describe("saveAdminBotCalendarEvent", () => {
  const draft = {
    summary: "Reading group lunch",
    start: "2026-09-18T13:00",
    end: "2026-09-18T14:00",
  };

  // Drafting "next Tuesday" while looking at August can land the event in September. Reloading the
  // month on screen would then show nothing, which looks exactly like the save having failed.
  it("moves the grid to the month the event landed in", async () => {
    const app = host({ calendarMonth: "2026-08-01", calendarDraft: draft });
    await saveAdminBotCalendarEvent(app);

    expect(createCalendarEvent).toHaveBeenCalledTimes(1);
    expect(app.calendarMonth).toBe("2026-09-01");
    // And reloads, so the new event is actually on the grid.
    const [params] = fetchCalendarEvents.mock.calls[0] as [{ from: string }];
    expect(params.from).toBe("2026-09-01T00:00:00.000Z");
  });

  // The failure the operator was hitting: the write failed and nothing on screen said so.
  it("reports a failure with the service's own words", async () => {
    createCalendarEvent.mockResolvedValue({
      ok: false,
      kind: "auth-failed",
      message: "gog calendar create failed: token expired",
    });
    const app = host({ calendarDraft: draft });
    await saveAdminBotCalendarEvent(app);

    expect(app.adminBotNotice).toEqual({
      kind: "error",
      text: "gog calendar create failed: token expired",
    });
    // The draft survives a failure, so the operator can retry rather than retype it.
    expect(app.calendarDraft).toEqual(draft);
  });

  it("updates instead of creating when an event is being edited", async () => {
    const app = host({
      calendarDraft: draft,
      calendarEditingEventId: "evt-1",
      calendarEvents: [{ id: "evt-1", summary: "Old", start: "2026-09-18T13:00:00-04:00" }],
    });
    await saveAdminBotCalendarEvent(app);

    expect(updateCalendarEvent).toHaveBeenCalledTimes(1);
    expect(createCalendarEvent).not.toHaveBeenCalled();
    expect(updateCalendarEvent.mock.calls[0][0]).toBe("evt-1");
    expect(app.calendarEditingEventId).toBeNull();
  });
});
