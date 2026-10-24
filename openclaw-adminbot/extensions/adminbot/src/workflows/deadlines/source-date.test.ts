import { describe, expect, it } from "vitest";
import { deadlineSourceDateLabel } from "./source-date.js";

describe("deadline source dates", () => {
  it.each([
    ["AoE", "2035-09-24 23:30 AoE"],
    ["UTC", "2035-09-25 11:30 UTC"],
    ["GMT+2", "2035-09-25 13:30 GMT+2"],
    ["UTC-03:30", "2035-09-25 08:00 UTC-03:30"],
    ["Europe/Paris", "2035-09-25 13:30 Europe/Paris (UTC+2)"],
    ["", "2035-09-25 11:30 UTC; source timezone unknown"],
    ["invalid", "2035-09-25 11:30 UTC; source timezone unknown"],
  ])("retains the source date in %s", (zone, expected) => {
    expect(
      deadlineSourceDateLabel({ deadline_at: "2035-09-25T11:30:00Z", deadline_timezone: zone }),
    ).toBe(expected);
  });
  it("uses the offset on the deadline date", () => {
    expect(
      deadlineSourceDateLabel({
        deadline_at: "2035-01-25T11:30:00Z",
        deadline_timezone: "Europe/Paris",
      }),
    ).toBe("2035-01-25 12:30 Europe/Paris (UTC+1)");
  });
  it("does not convert a date-only announcement or invent a closing time", () => {
    expect(
      deadlineSourceDateLabel({
        deadline_time_precision: "date_only",
        deadline_date: "2035-09-25",
        deadline_timezone: "AoE",
      }),
    ).toBe("2035-09-25 (time unknown; AoE)");
    expect(deadlineSourceDateLabel({})).toBe("Date not published");
  });
});

it("reads the current dataset without claiming its normalized zone is the source zone", () => {
  expect(deadlineSourceDateLabel({ deadline_aoe: "2035-09-24 23:30:00" })).toBe("2035-09-25 11:30 UTC; source timezone unknown");
});
