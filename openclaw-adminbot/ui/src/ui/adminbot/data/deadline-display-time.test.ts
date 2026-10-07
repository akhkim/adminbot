/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import {
  deadlineDisplayLabel,
  displayTimezone,
  zonedDeadlineLabel,
  loadDeadlineTimezone,
  saveDeadlineTimezone,
  DEADLINE_TIMEZONE_KEY,
} from "./deadline-display-time.ts";
beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));
const exact = {
  deadline_aoe: "2026-09-25 23:59:00",
  deadline_at: "2026-09-26T11:59:00Z",
  deadline_timezone: "AoE",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("deadline display timezones", () => {
  it("changes the calendar day without changing the instant", () => {
    expect(deadlineDisplayLabel(exact, "original")).toBe("Sep 25, 2026 · 23:59 AoE");
    expect(deadlineDisplayLabel(exact, "Europe/Zurich")).toBe("Sep 26, 2026 · 13:59 UTC+2");
    expect(deadlineDisplayLabel(exact, "America/Toronto")).toBe(
      "Sep 26, 2026 · 07:59 UTC-4",
    );
  });
  it("uses the offset at the deadline, including half hours and daylight saving", () => {
    expect(zonedDeadlineLabel(Date.parse("2026-11-26T11:59:00Z"), "Europe/Zurich")).toContain(
      "12:59 UTC+1",
    );
    expect(deadlineDisplayLabel(exact, "Asia/Kolkata")).toContain("17:29 UTC+5:30");
  });
  it("shows the date-specific offset without repeating it in details", () => {
    expect(deadlineDisplayLabel(exact, "America/Toronto", true)).toContain(
      "07:59 UTC-4",
    );
    expect(
      zonedDeadlineLabel(Date.parse("2026-11-26T11:59:00Z"), "America/Toronto", true),
    ).toContain("06:59 UTC-5");
    expect(deadlineDisplayLabel(exact, "Asia/Kolkata", true)).toContain(
      "17:29 UTC+5:30",
    );
  });
  it("uses each record's source zone rather than a global AoE assumption", () => {
    expect(deadlineDisplayLabel({ ...exact, deadline_timezone: "UTC" }, "original")).toContain(
      "11:59 UTC",
    );
    expect(deadlineDisplayLabel({ ...exact, deadline_timezone: "" }, "original")).toContain(
      "11:59 UTC · source timezone unknown",
    );
  });
  it("does not turn a date-only source into a converted closing time", () => {
    const day = {
      ...exact,
      deadline_at: "",
      deadline_date: "2026-09-25",
      deadline_time_precision: "date_only",
      deadline_timezone: "",
    };
    for (const zone of ["original", "local", "Pacific/Honolulu"]) {
      expect(deadlineDisplayLabel(day, zone)).toBe("Sep 25, 2026 · time unknown");
    }
    expect(zonedDeadlineLabel(Date.parse("2026-09-24T10:00:00Z"), "Europe/Zurich")).toBe(
      "Sep 24, 2026 · 12:00 UTC+2",
    );
  });
  it("persists a display preference and rejects invalid stored zones", () => {
    expect(loadDeadlineTimezone()).toBe("local");
    saveDeadlineTimezone("original");
    expect(loadDeadlineTimezone()).toBe("original");
    saveDeadlineTimezone("Asia/Tokyo");
    expect(loadDeadlineTimezone()).toBe("Asia/Tokyo");
    window.localStorage.setItem(DEADLINE_TIMEZONE_KEY, "missing/zone");
    expect(loadDeadlineTimezone()).toBe("local");
    expect(displayTimezone("missing/zone")).toBe("UTC");
  });
  it("works when storage is unavailable", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadDeadlineTimezone()).toBe("local");
    expect(() => saveDeadlineTimezone("UTC")).not.toThrow();
  });
});
