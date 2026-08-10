import { describe, expect, it } from "vitest";
import {
  ADMINBOT_CALENDAR_ENV,
  calendarIdFromUrl,
  extractCalendarDetails,
  resolveCalendarSource,
} from "./source.js";

describe("calendar source extraction", () => {
  it("extracts an all-day flight range and useful summary from source text", () => {
    const result = extractCalendarDetails(
      "Flight details\nSTR LHR\nOutbound 2099-07-21\nReturn 2099-07-23",
    );

    expect(result).toMatchObject({
      summary: "Flight STR ↔ LHR",
      timeWindow: "2099-07-21 through 2099-07-23",
      payload: {
        summary: "Flight STR ↔ LHR",
        from: "2099-07-21",
        to: "2099-07-24",
        all_day: true,
      },
    });
  });

  it("ignores passport and birth dates when extracting calendar dates", () => {
    const result = extractCalendarDetails(
      [
        "Event: Research visit",
        "Passport expiration date: May 6, 2098",
        "Birth date: 29 July 1997",
        "Visit date: August 12, 2099",
      ].join("\n"),
    );

    expect(result.payload).toMatchObject({
      from: "2099-08-12",
      to: "2099-08-13",
      all_day: true,
    });
  });

  it("uses a Calendar embed URL as the destination rather than a readable source", async () => {
    const calendarId = "examplecalendarid000000000@group.calendar.google.com";
    const calendarUrl =
      "https://calendar.google.com/calendar/embed?src=" +
      encodeURIComponent(calendarId) +
      "&ctz=Europe%2FBerlin";

    expect(calendarIdFromUrl(calendarUrl)).toBe(calendarId);
    await expect(
      resolveCalendarSource({
        summary: "Test",
        timeWindow: "2099-07-30",
        sourceUrl: calendarUrl,
      }),
    ).resolves.toMatchObject({
      summary: "Test",
      timeWindow: "2099-07-30",
      proposedPayload: {
        calendar_id: calendarId,
      },
    });
  });

  it.each([
    ["personal", "examplecalendarid000000000@group.calendar.google.com"],
    ["jinesis", "adminbot@example.com"],
  ] as const)("maps the %s calendar name to its writable calendar id", async (calendarName, id) => {
    await expect(
      resolveCalendarSource(
        {
          summary: "Named calendar test",
          timeWindow: "2099-07-30",
          calendarName,
        },
        { [ADMINBOT_CALENDAR_ENV[calendarName]]: id },
      ),
    ).resolves.toMatchObject({
      proposedPayload: {
        calendar_id: id,
      },
    });

    // The ids name a real Google Workspace, so they live in the environment. Unconfigured, the
    // proposal is still made -- just without a destination -- rather than throwing and taking
    // down every calendar action on a deployment that never set them.
    await expect(
      resolveCalendarSource(
        { summary: "Named calendar test", timeWindow: "2099-07-30", calendarName },
        {},
      ),
    ).resolves.toEqual({
      summary: "Named calendar test",
      timeWindow: "2099-07-30",
    });
  });

  it("preserves an exact time range from source text instead of making it all-day", () => {
    const result = extractCalendarDetails(
      "Event: Research dinner\nDate: July 30, 2099\nTime: 6:30 PM - 8:00 PM",
    );

    expect(result).toMatchObject({
      timeWindow: "2099-07-30T18:30:00-04:00 through 2099-07-30T20:00:00-04:00",
      payload: {
        from: "2099-07-30T18:30:00-04:00",
        to: "2099-07-30T20:00:00-04:00",
        all_day: false,
        timezone: "America/Toronto",
      },
    });
  });
});
