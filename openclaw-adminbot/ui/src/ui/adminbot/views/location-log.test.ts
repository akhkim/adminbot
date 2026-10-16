/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { locationLogRows, parseLocationLog, renderLocationLogRows } from "./location-log.ts";

// Synthetic entries, newest first, as the route returns them.
const BODY = {
  locations: [
    {
      id: "loc_4",
      member_id: "m_synthetic",
      observed_at: "2026-07-15T12:00:00.000Z",
      observed_at_local: "2026-07-15T08:00:00-04:00",
      source: "self_reported",
      raw: "Toronto",
      place_label: "Toronto",
      country: "Canada",
      checkin: "answered",
      checkin_via: "picker",
    },
    {
      id: "loc_3",
      member_id: "m_synthetic",
      observed_at: "2026-07-10T09:00:00.000Z",
      source: "self_reported",
      raw: "Ask me later",
      checkin: "snoozed",
    },
    {
      id: "loc_2",
      member_id: "m_synthetic",
      observed_at: "2026-07-09T03:30:00.000Z",
      observed_at_local: "2026-07-08T23:30:00-04:00",
      source: "login_ip",
      raw: "Toronto, Ontario, CA",
      place_label: "Toronto",
      country: "Canada",
    },
    {
      id: "loc_1",
      member_id: "m_synthetic",
      observed_at: "2026-07-01T00:00:00.000Z",
      source: "slack_timezone",
      raw: "America/Toronto",
    },
    { id: "broken" },
  ],
};

describe("location log", () => {
  it("drops malformed rows and keeps the service's order", () => {
    expect(parseLocationLog(BODY).map((entry) => entry.id)).toEqual([
      "loc_4",
      "loc_3",
      "loc_2",
      "loc_1",
    ]);
    expect(parseLocationLog(null)).toEqual([]);
  });

  it("names each source, dates rows by their local day, and shows what a check-in was answered", () => {
    expect(locationLogRows(parseLocationLog(BODY))).toEqual([
      { id: "loc_4", day: "2026-07-15", source: "Check-in", what: "Toronto, Canada" },
      {
        id: "loc_3",
        day: "2026-07-10",
        source: "Check-in",
        what: "",
        outcome: "Asked; chose ask me later",
      },
      // 23:30 in Toronto is the 8th there, though it is the 9th in UTC.
      { id: "loc_2", day: "2026-07-08", source: "Sign-in", what: "Toronto, Canada" },
      { id: "loc_1", day: "2026-07-01", source: "Slack time zone", what: "America/Toronto" },
    ]);
  });

  it("renders a list, or says there is nothing yet", () => {
    const container = document.createElement("div");
    render(renderLocationLogRows(locationLogRows(parseLocationLog(BODY))), container);
    expect(container.querySelectorAll("li")).toHaveLength(4);
    expect(container.textContent).toContain("ask me later");
    render(renderLocationLogRows([]), container);
    expect(container.textContent).toContain("Nothing logged yet.");
  });
});
