import { describe, expect, it, vi } from "vitest";
import {
  calendarMembershipReader,
  calendarAccessReader,
  revokeCalendarAccess,
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

describe("calendar subscription connector", () => {
  it("reads every ACL page, then revokes the exact user rule", async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ kind: "calendar#acl", items: [], nextPageToken: "next" }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          kind: "calendar#acl",
          items: [
            {
              id: "user:minor",
              role: "reader",
              scope: { type: "user", value: "minor@example.org" },
            },
          ],
        }),
      );
    const run = vi.fn(async (_args: string[]) => {});
    await revokeCalendarAccess(
      { calendar_id: "lab", rule_id: "user:minor", email: "minor@example.org" },
      capture,
      run,
    );
    expect(capture).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0]).toContain("calendar.acl.delete");
    expect(JSON.parse(run.mock.calls[0][0][run.mock.calls[0][0].indexOf("--params") + 1])).toEqual({
      calendarId: "lab",
      ruleId: "user:minor",
    });
  });
  it.each(["owner", "writer"])("refuses a changed ACL with role %s", async (role) => {
    const capture = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({
          kind: "calendar#acl",
          items: [{ id: "rule", role, scope: { type: "user", value: "different@example.org" } }],
        }),
      );
    const run = vi.fn(async (_args: string[]) => {});
    await expect(
      revokeCalendarAccess(
        { calendar_id: "lab", rule_id: "rule", email: "minor@example.org" },
        capture,
        run,
      ),
    ).rejects.toThrow("changed");
    expect(run).not.toHaveBeenCalled();
  });
  it("treats an already removed rule as a no-op", async () => {
    const run = vi.fn(async (_args: string[]) => {});
    await revokeCalendarAccess(
      { calendar_id: "lab", rule_id: "gone", email: "minor@example.org" },
      async () => JSON.stringify({ kind: "calendar#acl", items: [] }),
      run,
    );
    expect(run).not.toHaveBeenCalled();
  });
  it("refuses incomplete and repeated ACL pages", async () => {
    await expect(
      calendarAccessReader(async () =>
        JSON.stringify({ kind: "calendar#acl", items: [{ id: "bad" }] }),
      )("lab"),
    ).rejects.toThrow("Invalid");
    await expect(
      calendarAccessReader(async () =>
        JSON.stringify({ kind: "calendar#acl", nextPageToken: "same" }),
      )("lab"),
    ).rejects.toThrow("pagination");
  });
});
