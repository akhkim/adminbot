import { beforeEach, describe, expect, it, vi } from "vitest";

// Node's own execFile carries a util.promisify.custom that resolves { stdout, stderr }; the mock
// supplies the same, since the runner promisifies it at import.
const execFile = vi.hoisted(() => {
  const mock = vi.fn(async (_file: string, _args: string[], _options: unknown) => ({
    stdout: "",
    stderr: "",
  }));
  return Object.assign(mock, {
    [Symbol.for("nodejs.util.promisify.custom")]: mock,
  });
});
vi.mock("node:child_process", () => ({ execFile }));

const { createCalendarInviteRunner } = await import("./calendar-invite.js");

describe("createCalendarInviteRunner", () => {
  beforeEach(() => execFile.mockClear());

  // Google's "shared a calendar with you" mail is off for every grant, onboarding included:
  // AdminBot's calendar writes do not email anyone.
  it("grants reader access without a share notification", async () => {
    const invite = createCalendarInviteRunner({ ADMINBOT_LAB_EMAIL: "lab@example.com" });

    await invite("ada@example.com");

    const args = execFile.mock.calls[0]?.[1] as string[];
    expect(args.slice(0, 3)).toEqual(["calendar", "acl", "insert"]);
    expect(JSON.parse(args[args.indexOf("--params") + 1] ?? "{}")).toEqual({
      calendarId: "lab@example.com",
      sendNotifications: false,
    });
    expect(JSON.parse(args[args.indexOf("--json") + 1] ?? "{}")).toEqual({
      role: "reader",
      scope: { type: "user", value: "ada@example.com" },
    });
  });
});
