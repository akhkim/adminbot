// The letter policy, clause by clause, on synthetic members only.
import { describe, expect, it } from "vitest";
import type {
  AdminBotAvailabilityRow,
  AdminBotLabMember,
  AdminBotMeetingRecord,
} from "../../contracts/actions.js";
import type { AdminBotRecLetterFreezeIncident } from "../../contracts/rec-letter-freezes.js";
import {
  adminBotRecLetterMinRosterCoverage,
  averageWeeklyCommittedHours,
  recLetterAttendance,
  recLetterEligibility,
  recLetterFreeze,
  recLetterHours,
  recLetterMeetingDay,
  redactRecLetterEligibilityForMember,
} from "./rec-letter-eligibility.js";

// A Friday afternoon in Toronto.
const NOW = new Date("2026-10-16T16:00:00Z");
const TODAY = "2026-10-16";

function member(fields: Partial<AdminBotLabMember> & { id: string }): AdminBotLabMember {
  return {
    name: `Member ${fields.id}`,
    privilege_level: "member",
    access: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    ...fields,
  } as AdminBotLabMember;
}

function incident(
  id: string,
  occurredOn: string,
  memberId = "m-alpha",
): AdminBotRecLetterFreezeIncident {
  return {
    id,
    member_id: memberId,
    kind: "hallucinated_citation_desk_rejection",
    occurred_on: occurredOn,
    created_by: "m-admin",
    created_at: `${occurredOn}T12:00:00.000Z`,
  };
}

function row(start: string, end: string, hours: number, project?: string): AdminBotAvailabilityRow {
  return { start, end, hours_per_week: hours, ...(project ? { project } : {}) };
}

/** A meeting at noon UTC on a Toronto date -- the same calendar day there in any season. */
function meeting(
  id: string,
  date: string,
  present: string[] | null,
  extra: Partial<AdminBotMeetingRecord> = {},
): AdminBotMeetingRecord {
  const startedAt = date.includes("T") ? date : `${date}T16:00:00.000Z`;
  return {
    id,
    topic: `Meeting ${id}`,
    started_at: startedAt,
    recording: { share_url: `https://zoom.example/${id}` },
    source: "zoom_email",
    created_at: startedAt,
    updated_at: startedAt,
    // null is "nobody exported a roster"; an empty array would be the same thing.
    ...(present
      ? {
          attendees: present.map((memberId) => ({
            member_id: memberId,
            display_name: `Member ${memberId}`,
            source: "participant_report" as const,
            present: true,
          })),
        }
      : {}),
    ...extra,
  };
}

/** Every date in [from, to] whose UTC weekday is `weekday` (1 Monday, 3 Wednesday). */
function datesOn(weekday: number, from: string, to: string): string[] {
  const dates: string[] = [];
  for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); ) {
    if (day.getUTCDay() === weekday) {
      dates.push(day.toISOString().slice(0, 10));
    }
    day = new Date(day.getTime() + 86_400_000);
  }
  return dates;
}

/**
 * A run of Monday and Wednesday meetings with a roster, the member present unless the date is in
 * `absent`, and a second member present throughout so every roster is a known one.
 */
function series(
  memberId: string,
  from: string,
  to: string,
  absent: readonly string[] = [],
): AdminBotMeetingRecord[] {
  const dates = [...datesOn(1, from, to), ...datesOn(3, from, to)];
  return dates.map((date) =>
    meeting(`mt-${date}`, date, absent.includes(date) ? ["m-other"] : [memberId, "m-other"]),
  );
}

// Jul-Sep 2026: 13 Mondays and 14 Wednesdays.
const JUL_SEP = { from: "2026-07-01", to: "2026-09-30" };

describe("recLetterFreeze", () => {
  it("is not frozen with no incidents on file", () => {
    expect(recLetterFreeze("m-alpha", [], TODAY)).toEqual({ frozen: false, incident_count: 0 });
  });

  it("ends a freeze on the first anniversary of the incident", () => {
    const exactlyOneYear = recLetterFreeze("m-alpha", [incident("i1", "2025-10-16")], TODAY);
    expect(exactlyOneYear).toMatchObject({ frozen: false, frozen_until: "2026-10-16" });
    const oneDayShort = recLetterFreeze("m-alpha", [incident("i1", "2025-10-17")], TODAY);
    expect(oneDayShort).toMatchObject({ frozen: true, frozen_until: "2026-10-17" });
  });

  it("restarts the clock from the latest incident, whatever order they are stored in", () => {
    const result = recLetterFreeze(
      "m-alpha",
      [incident("i-later", "2026-02-10"), incident("i-earlier", "2025-03-01")],
      TODAY,
    );
    expect(result).toEqual({
      frozen: true,
      frozen_until: "2027-02-10",
      latest_incident_id: "i-later",
      incident_count: 2,
    });
  });

  it("ignores other members' incidents and unreadable dates", () => {
    const result = recLetterFreeze(
      "m-alpha",
      [incident("i-other", "2026-09-01", "m-beta"), incident("i-bad", "2026-02-30")],
      TODAY,
    );
    expect(result).toEqual({ frozen: false, incident_count: 0 });
  });

  it("ends a 29 February freeze on 1 March", () => {
    expect(recLetterFreeze("m-alpha", [incident("i1", "2028-02-29")], "2028-03-01")).toMatchObject({
      frozen_until: "2029-03-01",
      frozen: true,
    });
  });

  it("reads today in Toronto, not UTC", () => {
    // 02:00 UTC on the 17th is still the evening of the 16th in Toronto.
    const result = recLetterEligibility({
      member: member({ id: "m-alpha" }),
      incidents: [incident("i1", "2025-10-17")],
      meetings: [],
      now: new Date("2026-10-17T02:00:00Z"),
    });
    expect(result.as_of).toBe("2026-10-16");
    expect(result.freeze.frozen).toBe(true);
  });
});

describe("averageWeeklyCommittedHours", () => {
  it("weights a row by the days of the month it covers", () => {
    // 40 h/week for 17 of January's 31 days.
    expect(
      averageWeeklyCommittedHours([row("2026-01-15", "2026-02-14", 40)], "2026-01"),
    ).toBeCloseTo((40 * 17) / 31);
    // ...and for all 14 of February's first two weeks: exactly 20.
    expect(averageWeeklyCommittedHours([row("2026-01-15", "2026-02-14", 40)], "2026-02")).toBe(20);
  });

  it("adds overlapping rows together", () => {
    const rows = [row("2026-01-01", "2026-06-30", 10), row("2026-01-01", "2026-06-30", 12, "p1")];
    expect(averageWeeklyCommittedHours(rows, "2026-03")).toBe(22);
  });
});

describe("recLetterHours", () => {
  it("has nothing to judge without availability rows", () => {
    const result = recLetterHours(member({ id: "m-alpha", joined_month: "2025-01" }), TODAY);
    expect(result).toMatchObject({ status: "insufficient_data", qualifying_months: 0, months: [] });
  });

  it("counts five qualifying months, consecutive or not", () => {
    const rows = [
      row("2026-01-01", "2026-01-31", 25),
      row("2026-03-01", "2026-03-31", 25),
      row("2026-05-01", "2026-05-31", 25),
      row("2026-07-01", "2026-07-31", 25),
    ];
    const four = recLetterHours(
      member({ id: "m-alpha", joined_month: "2026-01", availability: rows }),
      TODAY,
    );
    expect(four).toMatchObject({ status: "not_met", qualifying_months: 4, required_months: 5 });
    const five = recLetterHours(
      member({
        id: "m-alpha",
        joined_month: "2026-01",
        availability: [...rows, row("2026-09-01", "2026-09-30", 25)],
      }),
      TODAY,
    );
    expect(five).toMatchObject({ status: "met", qualifying_months: 5 });
  });

  it("counts only finished months", () => {
    const result = recLetterHours(
      member({
        id: "m-alpha",
        joined_month: "2026-06",
        availability: [row("2026-06-01", "2026-12-31", 30)],
      }),
      TODAY,
    );
    expect(result.months.map((month) => month.month)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    expect(result.status).toBe("not_met");
  });

  it("does not count a half month for somebody who joined mid-month", () => {
    const result = recLetterHours(
      member({
        id: "m-alpha",
        joined_month: "2026-03",
        availability: [row("2026-03-16", "2026-08-31", 25)],
      }),
      TODAY,
    );
    expect(result.months[0]).toEqual({
      month: "2026-03",
      average_weekly_hours: 12.9,
      qualifies: false,
    });
    expect(result).toMatchObject({ status: "met", qualifying_months: 5 });
  });

  it("clips to the months the member was in the lab", () => {
    const result = recLetterHours(
      member({
        id: "m-alpha",
        joined_month: "2026-02",
        graduated_month: "2026-04",
        status: "alumni",
        availability: [row("2025-06-01", "2026-12-31", 30)],
      }),
      TODAY,
    );
    expect(result.months.map((month) => month.month)).toEqual(["2026-02", "2026-03", "2026-04"]);
  });

  it("falls back to the earliest row when the join month is unknown", () => {
    const result = recLetterHours(
      member({ id: "m-alpha", availability: [row("2026-08-10", "2026-09-30", 30)] }),
      TODAY,
    );
    expect(result.months.map((month) => month.month)).toEqual(["2026-08", "2026-09"]);
  });

  it("does not round a month over the line", () => {
    // 19.96 h/week shows as 20.0 but does not qualify.
    const result = recLetterHours(
      member({
        id: "m-alpha",
        joined_month: "2026-01",
        availability: [row("2026-01-01", "2026-01-31", 19.96)],
      }),
      TODAY,
    );
    expect(result.months[0]).toMatchObject({ average_weekly_hours: 20, qualifies: false });
  });

  it("skips rows it cannot read", () => {
    const result = recLetterHours(
      member({
        id: "m-alpha",
        availability: [row("2026-02-30", "2026-03-31", 40), row("2026-05-01", "2026-04-01", 40)],
      }),
      TODAY,
    );
    expect(result.status).toBe("insufficient_data");
  });
});

describe("recLetterMeetingDay", () => {
  it("reads the weekday in Toronto across both daylight-saving changes", () => {
    // 9:30 on the Monday after clocks went back (EST, UTC-5).
    expect(recLetterMeetingDay(new Date("2026-11-02T14:30:00Z"))).toMatchObject({
      date: "2026-11-02",
      weekday: "Mon",
    });
    // A Monday-evening meeting is already Tuesday in UTC.
    expect(recLetterMeetingDay(new Date("2026-11-03T03:30:00Z"))).toMatchObject({
      date: "2026-11-02",
      weekday: "Mon",
    });
    // Sunday evening the day clocks went forward is Monday in UTC, and not a Monday meeting.
    expect(recLetterMeetingDay(new Date("2026-03-09T00:30:00Z"))).toMatchObject({
      date: "2026-03-08",
      weekday: "Sun",
    });
    expect(recLetterMeetingDay(new Date("not a date"))).toBeNull();
  });
});

describe("recLetterAttendance", () => {
  const alpha = member({ id: "m-alpha", joined_month: "2026-06" });

  it("passes a window with full attendance", () => {
    const result = recLetterAttendance(
      alpha,
      series("m-alpha", JUL_SEP.from, JUL_SEP.to),
      "2026-09-30",
    );
    expect(result.status).toBe("met");
    expect(result.best_window).toMatchObject({
      start_month: "2026-07",
      end_month: "2026-09",
      mondays_held: 13,
      mondays_present: 13,
      wednesday_weeks_held: 14,
      monday_rate: 1,
      wednesday_rate: 1,
      passes: true,
    });
  });

  it("holds the Monday line at 80%", () => {
    // 11 of 13 = 84.6%.
    const pass = recLetterAttendance(
      alpha,
      series("m-alpha", JUL_SEP.from, JUL_SEP.to, ["2026-09-14", "2026-09-21"]),
      "2026-09-30",
    );
    expect(pass.status).toBe("met");
    expect(pass.best_window?.monday_rate).toBe(0.846);
    // 10 of 13 = 76.9%.
    const fail = recLetterAttendance(
      alpha,
      series("m-alpha", JUL_SEP.from, JUL_SEP.to, ["2026-07-06", "2026-07-13", "2026-07-20"]),
      "2026-09-30",
    );
    expect(fail.status).toBe("not_met");
    expect(fail.best_window).toMatchObject({ monday_rate: 0.769, passes: false, assessable: true });
  });

  it("holds the Wednesday line at 80% of weeks", () => {
    const pass = recLetterAttendance(
      alpha,
      series("m-alpha", JUL_SEP.from, JUL_SEP.to, ["2026-09-09", "2026-09-16"]),
      "2026-09-30",
    );
    expect(pass.status).toBe("met");
    expect(pass.best_window?.wednesday_rate).toBe(0.857);
    const fail = recLetterAttendance(
      alpha,
      series("m-alpha", JUL_SEP.from, JUL_SEP.to, ["2026-08-05", "2026-08-12", "2026-08-19"]),
      "2026-09-30",
    );
    expect(fail.status).toBe("not_met");
  });

  it("counts only the weeks that had a Wednesday meeting", () => {
    const mondays = datesOn(1, JUL_SEP.from, JUL_SEP.to).map((date) =>
      meeting(`mon-${date}`, date, ["m-alpha"]),
    );
    const wednesdays = ["2026-07-08", "2026-07-22", "2026-08-12", "2026-09-02", "2026-09-23"].map(
      (date) => meeting(`wed-${date}`, date, ["m-alpha"]),
    );
    const result = recLetterAttendance(alpha, [...mondays, ...wednesdays], "2026-09-30");
    expect(result.status).toBe("met");
    expect(result.best_window).toMatchObject({ wednesday_weeks_held: 5, wednesday_rate: 1 });
  });

  it("counts a week once whichever of its Wednesday meetings the member was at", () => {
    const base = series("m-alpha", JUL_SEP.from, JUL_SEP.to, ["2026-09-09"]);
    // A second theme meeting the same Wednesday, which the member did attend.
    const parallel = meeting("wed-theme-b", "2026-09-09T20:00:00.000Z", ["m-alpha"]);
    const result = recLetterAttendance(alpha, [...base, parallel], "2026-09-30");
    expect(result.best_window).toMatchObject({
      wednesday_weeks_held: 14,
      wednesday_weeks_present: 14,
    });
  });

  it("does not count a Wednesday as missed when one of its meetings has no roster", () => {
    const base = series("m-alpha", JUL_SEP.from, JUL_SEP.to, ["2026-09-09"]);
    const unexported = meeting("wed-theme-b", "2026-09-09T20:00:00.000Z", null);
    const result = recLetterAttendance(alpha, [...base, unexported], "2026-09-30");
    expect(result.best_window).toMatchObject({
      wednesday_weeks_held: 14,
      wednesday_weeks_with_roster: 13,
      wednesday_weeks_present: 13,
      wednesday_rate: 1,
    });
  });

  it("leaves unrostered meetings out of the rate", () => {
    // Fresh fixtures each call, so setting fields in place touches nothing shared.
    const meetings = series("m-alpha", JUL_SEP.from, JUL_SEP.to);
    for (const entry of meetings) {
      if (entry.started_at.startsWith("2026-07-06")) {
        entry.attendees = [];
      }
    }
    const result = recLetterAttendance(alpha, meetings, "2026-09-30");
    expect(result.best_window).toMatchObject({
      mondays_held: 13,
      mondays_with_roster: 12,
      monday_rate: 1,
      monday_coverage: 0.923,
    });
  });

  it("does not judge a window where too few meetings have a roster", () => {
    expect(adminBotRecLetterMinRosterCoverage).toBe(0.7);
    // Rosters for 8 of 13 Mondays (61.5%), and the member absent from all of them.
    const unexported = new Set(datesOn(1, JUL_SEP.from, JUL_SEP.to).slice(0, 5));
    const meetings = series(
      "m-alpha",
      JUL_SEP.from,
      JUL_SEP.to,
      datesOn(1, JUL_SEP.from, JUL_SEP.to),
    );
    for (const entry of meetings) {
      if (unexported.has(entry.started_at.slice(0, 10))) {
        entry.attendees = undefined;
      }
    }
    const result = recLetterAttendance(alpha, meetings, "2026-09-30");
    expect(result.status).toBe("insufficient_data");
    expect(result.windows_assessed).toBe(0);
    expect(result.best_window).toBeNull();
  });

  it("says not enough data, not a fail, when there are no meetings at all", () => {
    const result = recLetterAttendance(alpha, [], "2026-09-30");
    expect(result).toMatchObject({ status: "insufficient_data", best_window: null });
    expect(result.windows_considered).toBe(2);
  });

  it("does not judge a window with a month that has no Monday on record", () => {
    const meetings = [
      ...series("m-alpha", "2026-07-01", "2026-07-31"),
      ...series("m-alpha", "2026-09-01", "2026-09-30"),
    ];
    expect(recLetterAttendance(alpha, meetings, "2026-09-30").status).toBe("insufficient_data");
  });

  it("has no window for somebody who joined under three months ago", () => {
    const recent = member({ id: "m-alpha", joined_month: "2026-09" });
    const result = recLetterAttendance(recent, series("m-alpha", "2026-09-01", TODAY), TODAY);
    expect(result).toMatchObject({ status: "insufficient_data", windows_considered: 0 });
  });

  it("matches an unlinked attendee line by name", () => {
    const meetings = series("m-beta", JUL_SEP.from, JUL_SEP.to);
    for (const entry of meetings) {
      entry.attendees = [
        { display_name: "Member m-alpha", source: "transcript" as const, present: true },
        ...(entry.attendees ?? []),
      ];
    }
    expect(recLetterAttendance(alpha, meetings, "2026-09-30").status).toBe("met");
  });

  it("stops counting at an alumnus's graduation month", () => {
    const alumnus = member({
      id: "m-alpha",
      joined_month: "2026-03",
      graduated_month: "2026-06",
      member_type: "alumni",
    });
    // Present through June, gone after.
    const meetings = [
      ...series("m-alpha", "2026-04-01", "2026-06-30"),
      ...series("m-other", "2026-07-01", "2026-09-30"),
    ];
    const result = recLetterAttendance(alumnus, meetings, TODAY);
    expect(result.status).toBe("met");
    expect(result.windows_considered).toBe(2);
  });

  it("does not hold meetings before the member joined against them", () => {
    const late = member({ id: "m-alpha", joined_month: "2026-07" });
    const meetings = [
      ...series("m-other", "2026-04-01", "2026-07-31"),
      ...series("m-alpha", "2026-08-01", "2026-10-31"),
    ];
    const result = recLetterAttendance(late, meetings, "2026-10-31");
    expect(result.status).toBe("met");
    expect(result.best_window).toMatchObject({ start_month: "2026-08", mondays_held: 13 });
  });
});

describe("recLetterEligibility", () => {
  const steady = [row("2026-01-01", "2026-09-30", 25)];

  it("is eligible when both criteria are met and nothing is frozen", () => {
    const result = recLetterEligibility({
      member: member({ id: "m-alpha", joined_month: "2026-01", availability: steady }),
      incidents: [],
      meetings: series("m-alpha", JUL_SEP.from, JUL_SEP.to),
      now: NOW,
    });
    expect(result).toMatchObject({ status: "eligible", advisory: true, missing: [] });
  });

  it("puts a freeze ahead of everything else", () => {
    const result = recLetterEligibility({
      member: member({ id: "m-alpha", joined_month: "2026-01", availability: steady }),
      incidents: [incident("i1", "2026-05-01")],
      meetings: series("m-alpha", JUL_SEP.from, JUL_SEP.to),
      now: NOW,
    });
    expect(result.status).toBe("frozen");
    expect(result.missing).toEqual([{ code: "frozen", frozen_until: "2027-05-01" }]);
  });

  it("says not yet when a criterion is known to fall short", () => {
    const result = recLetterEligibility({
      member: member({
        id: "m-alpha",
        joined_month: "2026-01",
        availability: [row("2026-01-01", "2026-02-28", 25)],
      }),
      incidents: [],
      meetings: [],
      now: NOW,
    });
    expect(result.status).toBe("not_yet");
    expect(result.missing).toEqual([
      { code: "hours_short", qualifying_months: 2, required_months: 5 },
      { code: "attendance_no_window" },
    ]);
  });

  it("says not enough data when nothing falls short but something is unknown", () => {
    const result = recLetterEligibility({
      member: member({ id: "m-alpha", joined_month: "2026-01", availability: steady }),
      incidents: [],
      meetings: [],
      now: NOW,
    });
    expect(result.status).toBe("insufficient_data");
    expect(result.missing).toEqual([{ code: "attendance_no_window" }]);
  });

  it("flags an alumnus without treating them differently", () => {
    const result = recLetterEligibility({
      member: member({
        id: "m-alpha",
        joined_month: "2026-01",
        graduated_month: "2026-09",
        member_type: "alumni",
        availability: steady,
      }),
      incidents: [],
      meetings: series("m-alpha", JUL_SEP.from, JUL_SEP.to),
      now: NOW,
    });
    expect(result).toMatchObject({ status: "eligible", is_alumni: true });
  });
});

describe("redactRecLetterEligibilityForMember", () => {
  const base = {
    member: member({ id: "m-alpha", joined_month: "2026-01" }),
    meetings: [],
    now: NOW,
  };

  it("keeps the frozen-until date and drops which incident and how many", () => {
    const result = redactRecLetterEligibilityForMember(
      recLetterEligibility({
        ...base,
        incidents: [incident("i1", "2026-01-10"), incident("i2", "2026-05-01")],
      }),
    );
    expect(result.freeze).toEqual({ frozen: true, frozen_until: "2027-05-01" });
    expect(JSON.stringify(result)).not.toContain("i2");
  });

  it("drops an expired freeze's date altogether", () => {
    const result = redactRecLetterEligibilityForMember(
      recLetterEligibility({ ...base, incidents: [incident("i1", "2024-01-10")] }),
    );
    expect(result.freeze).toEqual({ frozen: false });
  });
});
