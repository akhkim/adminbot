import { describe, expect, it } from "vitest";
import type { AdminBotMemberLocationEntry } from "../../contracts/actions.js";
import {
  CARRY_LIMIT_DAYS,
  countryDayTotals,
  dailyLocationRows,
  daysInCountry,
  formatLocationDayCsv,
  formatLocationObservationCsv,
} from "./location-daily-log.js";

function entry(overrides: Partial<AdminBotMemberLocationEntry> = {}): AdminBotMemberLocationEntry {
  return {
    id: "loc-1",
    member_id: "m-zj",
    observed_at: "2026-08-10T09:00:00.000Z",
    source: "login_ip",
    raw: "Canada",
    country: "Canada",
    ...overrides,
  };
}

describe("dailyLocationRows", () => {
  it("marks the observation day observed and the days after it carried", () => {
    const rows = dailyLocationRows({
      history: [entry()],
      from: "2026-08-10",
      to: "2026-08-13",
    });
    expect(rows.map((row) => row.basis)).toEqual(["observed", "carried", "carried", "carried"]);
    expect(rows.map((row) => row.days_since_observation)).toEqual([0, 1, 2, 3]);
    expect(rows.every((row) => row.country === "Canada")).toBe(true);
    // Every carried row names the observation it rests on, so a reader can go check it.
    expect(rows.at(-1)?.observed_at).toBe("2026-08-10T09:00:00.000Z");
  });

  it("leaves days before the first observation unknown rather than backfilling", () => {
    const rows = dailyLocationRows({
      history: [entry()],
      from: "2026-08-08",
      to: "2026-08-10",
    });
    expect(rows.map((row) => row.basis)).toEqual(["unknown", "unknown", "observed"]);
    // An unknown day states nothing at all -- not even the country it would later turn out to be.
    expect(rows[0]?.country).toBeUndefined();
    expect(rows[0]?.source).toBeUndefined();
  });

  it("stops carrying once the observation is older than the carry limit", () => {
    const rows = dailyLocationRows({
      history: [entry()],
      from: "2026-08-10",
      to: "2026-09-10",
    });
    const carried = rows.filter((row) => row.basis === "carried");
    expect(carried).toHaveLength(CARRY_LIMIT_DAYS);
    // One sign-in must not fill a month.
    expect(rows.at(-1)?.basis).toBe("unknown");
    expect(rows.at(-1)?.country).toBeUndefined();
  });

  it("switches to a newer observation on the day it lands", () => {
    const rows = dailyLocationRows({
      history: [
        entry(),
        entry({
          id: "loc-2",
          observed_at: "2026-08-12T11:00:00.000Z",
          raw: "Germany",
          country: "Germany",
        }),
      ],
      from: "2026-08-10",
      to: "2026-08-13",
    });
    expect(rows.map((row) => row.country)).toEqual(["Canada", "Canada", "Germany", "Germany"]);
    expect(rows.map((row) => row.basis)).toEqual(["observed", "carried", "observed", "carried"]);
  });

  it("carries the Slack timezone independently of the location", () => {
    const rows = dailyLocationRows({
      history: [
        entry({
          id: "loc-tz",
          source: "slack_profile",
          raw: "Toronto",
          country: undefined,
          place_label: "Toronto",
          timezone: "America/Toronto",
        }),
        entry({
          id: "loc-ip",
          observed_at: "2026-08-20T09:00:00.000Z",
          raw: "Germany",
          country: "Germany",
        }),
      ],
      from: "2026-08-20",
      to: "2026-08-20",
    });
    // A fresh sign-in from Germany must not make the fortnight-old Slack zone look fresh, nor
    // suppress it: they are separate claims and are reported separately.
    const row = rows[0];
    expect(row?.country).toBe("Germany");
    expect(row?.basis).toBe("observed");
    expect(row?.slack_timezone).toBe("America/Toronto");
    expect(row?.timezone_basis).toBe("carried");
  });

  it("reports history out of order the same as history in order", () => {
    const ordered = dailyLocationRows({
      history: [
        entry(),
        entry({ id: "loc-2", observed_at: "2026-08-12T11:00:00.000Z", country: "Germany" }),
      ],
      from: "2026-08-10",
      to: "2026-08-13",
    });
    const shuffled = dailyLocationRows({
      history: [
        entry({ id: "loc-2", observed_at: "2026-08-12T11:00:00.000Z", country: "Germany" }),
        entry(),
      ],
      from: "2026-08-10",
      to: "2026-08-13",
    });
    expect(shuffled).toEqual(ordered);
  });

  it("produces no rows for an empty history beyond unknowns", () => {
    const rows = dailyLocationRows({ history: [], from: "2026-08-10", to: "2026-08-12" });
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.basis === "unknown" && row.timezone_basis === "unknown")).toBe(
      true,
    );
  });
});

describe("countryDayTotals", () => {
  it("keeps observed and carried days apart", () => {
    const rows = dailyLocationRows({
      history: [entry()],
      from: "2026-08-10",
      to: "2026-08-13",
    });
    expect(countryDayTotals(rows)).toEqual([
      { country: "Canada", observed_days: 1, carried_days: 3 },
    ]);
  });

  it("excludes unknown days from every total", () => {
    const rows = dailyLocationRows({
      history: [entry()],
      from: "2026-08-01",
      to: "2026-09-10",
    });
    const totals = countryDayTotals(rows);
    // Nine days before the sign-in and everything past the carry limit stay uncounted.
    expect(totals).toEqual([
      { country: "Canada", observed_days: 1, carried_days: CARRY_LIMIT_DAYS },
    ]);
  });
});

describe("formatLocationDayCsv", () => {
  it("writes a header and leaves unknown fields empty", () => {
    const csv = formatLocationDayCsv(
      dailyLocationRows({ history: [entry()], from: "2026-08-09", to: "2026-08-10" }),
    );
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "day,country,place_label,source,basis,observed_at,days_since_observation,slack_timezone,timezone_basis",
    );
    expect(lines[1]).toBe("2026-08-09,,,,unknown,,,,unknown");
    expect(lines[2]).toBe(
      "2026-08-10,Canada,,login_ip,observed,2026-08-10T09:00:00.000Z,0,,unknown",
    );
  });

  it("writes one row per observation and states nothing between them", () => {
    const csv = formatLocationObservationCsv([
      entry({
        id: "b",
        observed_at: "2026-08-14T09:00:00.000Z",
        raw: "Germany",
        country: "Germany",
      }),
      entry(),
    ]);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("observed_at,observed_at_local,source,raw,country,place_label,timezone");
    // Sorted oldest-first regardless of input order, and the four days between the two
    // observations produce no rows at all.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("2026-08-10T09:00:00.000Z,,login_ip,Canada,Canada,,");
    expect(lines[2]).toBe("2026-08-14T09:00:00.000Z,,login_ip,Germany,Germany,,");
  });

  it("carries a Slack zone through the observation export", () => {
    const csv = formatLocationObservationCsv([
      entry({
        source: "slack_timezone",
        raw: "Europe/Amsterdam",
        country: undefined,
        timezone: "Europe/Amsterdam",
      }),
    ]);
    expect(csv.trimEnd().split("\n")[1]).toBe(
      "2026-08-10T09:00:00.000Z,,slack_timezone,Europe/Amsterdam,,,Europe/Amsterdam",
    );
  });

  it("exports the local collection stamp beside the UTC one", () => {
    const csv = formatLocationObservationCsv([
      entry({
        observed_at: "2026-08-10T03:30:00.000Z",
        observed_at_local: "2026-08-09T23:30:00-04:00",
      }),
    ]);
    expect(csv.trimEnd().split("\n")[1]).toBe(
      "2026-08-10T03:30:00.000Z,2026-08-09T23:30:00-04:00,login_ip,Canada,Canada,,",
    );
  });

  it("quotes a place label containing a comma", () => {
    const csv = formatLocationDayCsv(
      dailyLocationRows({
        history: [entry({ place_label: "Toronto, Ontario" })],
        from: "2026-08-10",
        to: "2026-08-10",
      }),
    );
    expect(csv).toContain('"Toronto, Ontario"');
  });
});

describe("counting on the local calendar", () => {
  // The whole reason the local stamp is stored: a sign-in at 23:30 in Toronto is one Canada day,
  // and its UTC stamp (03:30 the next date) files it on the wrong day. The default `utc` basis
  // keeps every existing caller unchanged; `local` is what a residency count asks for.
  const lateNight: AdminBotMemberLocationEntry = {
    id: "loc-late",
    member_id: "m-zj",
    observed_at: "2026-08-12T03:30:00.000Z",
    observed_at_local: "2026-08-11T23:30:00-04:00",
    source: "login_ip",
    raw: "Canada",
    country: "Canada",
  };

  it("files an observation on its UTC day by default and its local day when asked", () => {
    const utc = dailyLocationRows({ history: [lateNight], from: "2026-08-11", to: "2026-08-12" });
    expect(utc.find((row) => row.day === "2026-08-12")?.basis).toBe("observed");
    expect(utc.find((row) => row.day === "2026-08-11")?.basis).toBe("unknown");

    const local = dailyLocationRows({
      history: [lateNight],
      from: "2026-08-11",
      to: "2026-08-12",
      dayBasis: "local",
    });
    expect(local.find((row) => row.day === "2026-08-11")?.basis).toBe("observed");
  });

  it("falls back to the UTC day when an entry carries no local stamp", () => {
    const noLocal = { ...lateNight, observed_at_local: undefined };
    const local = dailyLocationRows({
      history: [noLocal],
      from: "2026-08-11",
      to: "2026-08-12",
      dayBasis: "local",
    });
    expect(local.find((row) => row.day === "2026-08-12")?.basis).toBe("observed");
    expect(local.find((row) => row.day === "2026-08-11")?.basis).toBe("unknown");
  });
});

describe("daysInCountry", () => {
  function day(dayOfMonth: string, country: string, offset: string): AdminBotMemberLocationEntry {
    return {
      id: `loc-${dayOfMonth}`,
      member_id: "m-zj",
      observed_at: `2026-08-${dayOfMonth}T12:00:00.000Z`,
      observed_at_local: `2026-08-${dayOfMonth}T08:00:00${offset}`,
      source: "login_ip",
      raw: country,
      country,
    };
  }

  it("counts local days in the country, observed and carried apart", () => {
    // In Canada on the 10th, still there (carried) the 11th, gone to Germany the 12th.
    const history = [day("10", "Canada", "-04:00"), day("12", "Germany", "+02:00")];
    const canada = daysInCountry({
      history,
      country: "Canada",
      from: "2026-08-10",
      to: "2026-08-12",
    });
    // Observed on the 10th; carried the 11th; the 12th belongs to Germany.
    expect(canada).toEqual({ country: "Canada", observed_days: 1, carried_days: 1 });
  });

  it("matches the country name case-insensitively", () => {
    const history = [day("10", "Canada", "-04:00")];
    expect(
      daysInCountry({ history, country: "canada", from: "2026-08-10", to: "2026-08-10" })
        .observed_days,
    ).toBe(1);
  });

  it("puts a late-night sign-in on the local day the border would count", () => {
    const lateNight: AdminBotMemberLocationEntry = {
      id: "loc-late",
      member_id: "m-zj",
      observed_at: "2026-08-12T03:30:00.000Z",
      observed_at_local: "2026-08-11T23:30:00-04:00",
      source: "login_ip",
      raw: "Canada",
      country: "Canada",
    };
    // The window is a single local day -- the 11th -- which the UTC stamp would miss entirely.
    expect(
      daysInCountry({
        history: [lateNight],
        country: "Canada",
        from: "2026-08-11",
        to: "2026-08-11",
      }),
    ).toEqual({ country: "Canada", observed_days: 1, carried_days: 0 });
  });

  it("counts zero for a country with no days in the window", () => {
    const history = [day("10", "Canada", "-04:00")];
    expect(
      daysInCountry({ history, country: "France", from: "2026-08-10", to: "2026-08-12" }),
    ).toEqual({ country: "France", observed_days: 0, carried_days: 0 });
  });
});
