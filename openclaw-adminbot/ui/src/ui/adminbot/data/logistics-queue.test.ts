import { describe, expect, it } from "vitest";
import type { LogisticsRequest } from "../auth/session.ts";
import {
  DEFAULT_LOGISTICS_QUEUE_OPTIONS,
  logisticsDeadlineText,
  selectLogisticsQueue,
} from "./logistics-queue.ts";

function letter(id: string, zone: string, date: string, time: string): LogisticsRequest {
  return {
    id,
    kind: "recommendation_letters",
    member_id: id,
    member_name: id,
    status: "submitted",
    submitted_at: "2026-09-28T10:00:00Z",
    updated_at: "2026-09-28T10:00:00Z",
    deadline_at: "2026-01-01T00:00:00Z",
    schools: [
      {
        school: "Example University",
        application_deadline: "2026-01-01",
        letter_deadline: date,
        letter_deadline_time: time,
        deadline_timezone: zone,
      },
    ],
  };
}

describe("the request queue's deadlines and controls", () => {
  const aoe = letter("Ada", "AoE", "2026-12-01", "23:59");
  const tokyo = letter("Bo", "Asia/Tokyo", "2026-12-02", "09:00");
  const missing = {
    ...letter("Cam", "AoE", "", ""),
    schools: [{ school: "Other University", application_deadline: "2026-01-01" }],
  };

  it("shows the entered letter date, time, and timezone rather than the viewer's clock", () => {
    expect(logisticsDeadlineText(aoe)).toBe("Dec 1, 2026, 23:59 AoE (UTC−12)");
    expect(logisticsDeadlineText(tokyo)).toBe("Dec 2, 2026, 09:00 Asia/Tokyo");
    expect(logisticsDeadlineText(missing)).toBe("");
  });

  it("orders actual due times across zones, ignores cached application dates, and puts missing deadlines last both ways", () => {
    const input = [missing, aoe, tokyo];
    expect(
      selectLogisticsQueue(input, DEFAULT_LOGISTICS_QUEUE_OPTIONS, false).map((r) => r.id),
    ).toEqual(["Bo", "Ada", "Cam"]);
    expect(
      selectLogisticsQueue(
        input,
        { ...DEFAULT_LOGISTICS_QUEUE_OPTIONS, sortDirection: "desc" },
        false,
      ).map((r) => r.id),
    ).toEqual(["Ada", "Bo", "Cam"]);
    expect(input.map((r) => r.id)).toEqual(["Cam", "Ada", "Bo"]);
  });

  it("combines case-insensitive name/school search with type and status filters", () => {
    const done = { ...tokyo, status: "completed" as const };
    const options = {
      ...DEFAULT_LOGISTICS_QUEUE_OPTIONS,
      search: "example UNIVERSITY",
      kind: "recommendation_letters" as const,
      status: "completed" as const,
    };
    expect(selectLogisticsQueue([aoe, done, missing], options, false).map((r) => r.id)).toEqual([
      "Bo",
    ]);
    expect(selectLogisticsQueue([aoe, done], { ...options, search: " nobody " }, true)).toEqual([]);
    expect(
      selectLogisticsQueue(
        [aoe, done],
        { ...DEFAULT_LOGISTICS_QUEUE_OPTIONS, search: " ADA " },
        true,
      ),
    ).toEqual([aoe]);
  });

  it("supports requester, submission-time, and status sorting", () => {
    const latest = { ...tokyo, submitted_at: "2026-09-29T10:00:00Z", status: "completed" as const };
    for (const sortBy of ["user", "submitted", "status"] as const) {
      expect(
        selectLogisticsQueue(
          [aoe, latest],
          { ...DEFAULT_LOGISTICS_QUEUE_OPTIONS, sortBy, sortDirection: "desc" },
          true,
        ).map((r) => r.id),
      ).toEqual(["Bo", "Ada"]);
    }
  });
});
