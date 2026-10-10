import { describe, expect, it, vi } from "vitest";
import {
  calendarMembershipReader,
  removeFilteredCalendarAttendees,
} from "./calendar-membership.js";
const event = (id: string) => ({
  id,
  organizer: { email: "lab@example.org" },
  attendees: [{ email: "remove@example.org" }],
});
describe("calendar membership connector", () => {
  it("reads all pages of future events without expanding infinite recurring series", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          kind: "calendar#events",
          items: [event("series")],
          nextPageToken: "next",
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ kind: "calendar#events", items: [event("one-off")] }),
      );
    expect((await calendarMembershipReader(capture)("lab@example.org")).map((e) => e.id)).toEqual([
      "series",
      "one-off",
    ]);
    const args = capture.mock.calls[0][0];
    const params = JSON.parse(args[args.indexOf("--params") + 1]);
    expect(params).toMatchObject({ singleEvents: false, showDeleted: false });
    expect(params.timeMax).toBeUndefined();
    expect(params.timeMin).toBeTruthy();
  });
  it("rejects incomplete attendee lists and broken pagination before returning an inventory", async () => {
    const capture = vi.fn().mockResolvedValue(
      JSON.stringify({
        kind: "calendar#events",
        items: [{ ...event("event"), attendeesOmitted: true }],
      }),
    );
    await expect(calendarMembershipReader(capture)("lab")).rejects.toThrow("Incomplete");
    capture.mockResolvedValue(
      JSON.stringify({ kind: "calendar#events", items: [], nextPageToken: "same" }),
    );
    await expect(calendarMembershipReader(capture)("lab")).rejects.toThrow("pagination");
  });
  it("subtracts from fresh attendees rather than overwriting with the planning snapshot", async () => {
    const run = vi.fn(async (_args: string[]) => {});
    const capture = vi.fn(async () =>
      JSON.stringify({
        ...event("event"),
        attendees: [
          { email: "remove@example.org" },
          { email: "new@example.org", responseStatus: "accepted" },
        ],
      }),
    );
    await removeFilteredCalendarAttendees(
      { calendar_id: "lab", event_id: "event", removed_attendees: ["remove@example.org"] },
      capture,
      run,
    );
    const args = run.mock.calls[0][0];
    expect(JSON.parse(args[args.indexOf("--body") + 1])).toEqual({
      attendees: [{ email: "new@example.org", responseStatus: "accepted" }],
    });
  });
});
