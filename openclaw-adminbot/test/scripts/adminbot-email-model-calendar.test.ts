import { describe, expect, it, vi } from "vitest";
import { AdminBotEmailModel } from "../../scripts/adminbot-email-model.js";

function respondingWith(content: unknown) {
  return vi.fn<typeof fetch>(async () => {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

function sentPayload(fetchMock: ReturnType<typeof respondingWith>) {
  const [, init] = fetchMock.mock.calls[0] ?? [];
  return JSON.parse(String(init?.body)) as {
    messages: Array<{ content: unknown }>;
  };
}

const event = {
  summary: "Test",
  start: "2026-07-30",
  end: "2026-07-31",
  allDay: true,
  description: null,
  location: null,
  startTimeZone: null,
  endTimeZone: null,
};

describe("AdminBot calendar extraction", () => {
  it("uses an all-day range only when the email has no time", async () => {
    const fetchMock = respondingWith({ calendar: "lab", events: [event] });
    const model = new AdminBotEmailModel(fetchMock);

    await expect(
      model.calendar({
        from: "pi@example.edu",
        subject: "Create event",
        body: "Add an event called Test on July 30, 2026.",
      }),
    ).resolves.toMatchObject({
      calendar: "lab",
      events: [{ summary: "Test", start: "2026-07-30", end: "2026-07-31", allDay: true }],
    });

    const payload = sentPayload(fetchMock);
    expect(payload.messages[0]?.content).toContain("Only when no time is stated");
    // No images, no content array: a text-only request stays the plain string it always was.
    expect(typeof payload.messages[1]?.content).toBe("string");
  });

  // The "Calendar" mail that failed was one sentence and a screenshot of two flights: the text
  // alone has no date, so the image has to reach the model, and both legs have to come back.
  it("reads attached screenshots and returns every event in them", async () => {
    const flights = [
      {
        ...event,
        summary: "Flight FRA → SFO (Lufthansa)",
        start: "2026-10-09T10:25:00+02:00",
        end: "2026-10-09T12:40:00-07:00",
        allDay: false,
        startTimeZone: "Europe/Berlin",
        endTimeZone: "America/Los_Angeles",
      },
      {
        ...event,
        summary: "Flight SFO → FRA (United)",
        start: "2026-10-22T13:55:00-07:00",
        end: "2026-10-23T09:45:00+02:00",
        allDay: false,
        startTimeZone: "America/Los_Angeles",
        endTimeZone: "Europe/Berlin",
      },
    ];
    const fetchMock = respondingWith({ calendar: "personal", events: flights });
    const model = new AdminBotEmailModel(fetchMock);

    const result = await model.calendar(
      {
        from: "pi@example.edu",
        subject: "Calendar",
        body: "Use the screenshot to add this to my personal calendar, not the lab calendar.",
      },
      [{ mimeType: "image/png", base64: "iVBORw0KGgo=" }],
    );

    expect(result.calendar).toBe("personal");
    expect(result.events).toHaveLength(2);
    const user = sentPayload(fetchMock).messages[1]?.content as Array<Record<string, unknown>>;
    expect(user[0]).toMatchObject({ type: "text" });
    expect(user[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    });
  });
});
