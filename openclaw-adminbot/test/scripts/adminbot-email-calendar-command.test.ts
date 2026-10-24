import { beforeEach, expect, it, vi } from "vitest";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});

import { GoogleClient } from "../../scripts/adminbot-email-automation.js";

beforeEach(() => {
  vi.stubEnv("ADMINBOT_BOT_EMAIL", "bot@example.com");
  execute.mockReset().mockResolvedValue({ stdout: "{}", stderr: "" });
});

it("creates all-day dates without forbidden timezone flags, while timed events retain their zones", async () => {
  const client = new GoogleClient();
  const event = {
    summary: "Example retreat",
    start: "2027-06-28",
    end: "2027-06-30",
    allDay: true,
    startTimeZone: "Europe/Berlin",
    endTimeZone: "America/Toronto",
  };
  await client.createEvent(event, "example-calendar");
  const allDayArgs = execute.mock.calls[0][1] as string[];
  expect(allDayArgs).toContain("--all-day");
  expect(allDayArgs).not.toContain("--start-timezone");
  expect(allDayArgs).not.toContain("--end-timezone");
  expect(
    allDayArgs.slice(
      allDayArgs.indexOf("--send-updates"),
      allDayArgs.indexOf("--send-updates") + 2,
    ),
  ).toEqual(["--send-updates", "none"]);

  await client.createEvent(
    { ...event, allDay: false, start: "2027-06-28T09:00:00", end: "2027-06-28T10:00:00" },
    "example-calendar",
  );
  const timedArgs = execute.mock.calls[1][1] as string[];
  expect(timedArgs).not.toContain("--all-day");
  expect(timedArgs[timedArgs.indexOf("--start-timezone") + 1]).toBe("Europe/Berlin");
  expect(timedArgs[timedArgs.indexOf("--end-timezone") + 1]).toBe("America/Toronto");

  await client.createEvent(
    { ...event, allDay: false, startTimeZone: undefined, endTimeZone: undefined },
    "example-calendar",
  );
  const defaultArgs = execute.mock.calls[2][1] as string[];
  expect(defaultArgs[defaultArgs.indexOf("--start-timezone") + 1]).toBe("America/Toronto");
  expect(defaultArgs[defaultArgs.indexOf("--end-timezone") + 1]).toBe("America/Toronto");
});
