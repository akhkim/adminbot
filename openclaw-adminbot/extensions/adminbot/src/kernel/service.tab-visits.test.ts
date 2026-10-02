// Which tabs people open, and the arithmetic that turns a log of openings into a rate.
//
// The summary is the part worth pinning down rather than the insert: it derives dwell from the gaps
// between one member's own visits, and every way that can go wrong (two members reading at once, a
// sitting that ended overnight, a clock that disagrees) is a silent wrong number rather than a
// failure.
import { describe, expect, it } from "vitest";
import { summarizeTabVisits, type AdminBotTabVisit } from "../contracts/tab-visits.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

function serviceWithMembers(ids: readonly string[]): AdminBotService {
  const service = new AdminBotService();
  for (const id of ids) {
    unwrap(service.upsertLabMember({ id, name: id } as never));
  }
  return service;
}

/** Minutes from a fixed start, so a case reads as a sitting rather than as a list of stamps. */
function at(minutes: number): string {
  return new Date(Date.parse("2026-09-01T09:00:00.000Z") + minutes * 60_000).toISOString();
}

function visit(fields: Partial<AdminBotTabVisit> & { tab: string }): AdminBotTabVisit {
  return {
    id: `v_${fields.tab}_${fields.at ?? "0"}_${fields.member_id ?? "ada"}`,
    member_id: "ada",
    at: at(0),
    ...fields,
  };
}

const WINDOW = { from: at(-60), to: at(600), days: 1 };

describe("summarizeTabVisits", () => {
  it("counts openings and distinct people separately", () => {
    // The ratio is the interesting part: a tab two people live in and a tab the lab passes through
    // can carry the same visit count.
    const report = summarizeTabVisits(
      [
        visit({ tab: "dashboard", member_id: "ada", at: at(0) }),
        visit({ tab: "dashboard", member_id: "ada", at: at(10) }),
        visit({ tab: "dashboard", member_id: "mei", at: at(20) }),
        visit({ tab: "adminbotPapers", member_id: "mei", at: at(30) }),
      ],
      WINDOW,
    );
    const dashboard = report.tabs.find((row) => row.tab === "dashboard");
    expect(dashboard?.visits).toBe(3);
    expect(dashboard?.members).toBe(2);
    expect(report.visits).toBe(4);
    // Not the sum of the per-tab member counts: Mei is on two tabs and is still one person.
    expect(report.members).toBe(2);
  });

  it("orders tabs by visits, and breaks a tie by name rather than by insertion", () => {
    const report = summarizeTabVisits(
      [
        visit({ tab: "zebra", at: at(1) }),
        visit({ tab: "alpha", at: at(2) }),
        visit({ tab: "busy", at: at(3) }),
        visit({ tab: "busy", at: at(4) }),
      ],
      WINDOW,
    );
    expect(report.tabs.map((row) => row.tab)).toEqual(["busy", "alpha", "zebra"]);
  });

  it("times a visit by the gap to that member's next one", () => {
    const report = summarizeTabVisits(
      [
        visit({ tab: "dashboard", at: at(0) }),
        visit({ tab: "adminbotPapers", at: at(5) }),
        visit({ tab: "adminbotDeadlines", at: at(20) }),
      ],
      WINDOW,
    );
    const byTab = new Map(report.tabs.map((row) => [row.tab, row]));
    expect(byTab.get("dashboard")?.dwell_seconds_median).toBe(5 * 60);
    expect(byTab.get("adminbotPapers")?.dwell_seconds_median).toBe(15 * 60);
    // The last visit of a sitting has nothing after it to measure against, so it is counted as a
    // visit and reported as untimed rather than guessed at.
    expect(byTab.get("adminbotDeadlines")?.dwell_samples).toBe(0);
    expect(byTab.get("adminbotDeadlines")?.visits).toBe(1);
  });

  it("never borrows one member's gap to time another's visit", () => {
    // Two people reading at the same time. Interleaved by timestamp, the naive walk would time
    // Ada's dashboard against Mei's next click and report four minutes for a tab she closed after
    // one.
    const report = summarizeTabVisits(
      [
        visit({ tab: "dashboard", member_id: "ada", at: at(0) }),
        visit({ tab: "labSharing", member_id: "mei", at: at(1) }),
        visit({ tab: "profile", member_id: "ada", at: at(2) }),
        visit({ tab: "profile", member_id: "mei", at: at(30) }),
      ],
      WINDOW,
    );
    const byTab = new Map(report.tabs.map((row) => [row.tab, row]));
    expect(byTab.get("dashboard")?.dwell_seconds_median).toBe(2 * 60);
    expect(byTab.get("labSharing")?.dwell_seconds_median).toBe(29 * 60);
  });

  it("treats a long gap as a sitting that ended, not as hours of reading", () => {
    const report = summarizeTabVisits(
      [
        visit({ tab: "dashboard", at: at(0) }),
        // Back the next morning.
        visit({ tab: "dashboard", at: at(20 * 60) }),
      ],
      { from: at(-60), to: at(24 * 60), days: 1 },
    );
    const dashboard = report.tabs.find((row) => row.tab === "dashboard");
    expect(dashboard?.visits).toBe(2);
    expect(dashboard?.dwell_samples).toBe(0);
    expect(dashboard?.dwell_seconds_total).toBe(0);
  });

  it("drops a backwards gap rather than subtracting it from the total", () => {
    // Two devices whose clocks disagree. Left in, this is negative dwell, which pulls a tab's
    // total below zero and reads as a tab nobody spent time on.
    const report = summarizeTabVisits(
      [visit({ tab: "dashboard", at: at(10) }), visit({ tab: "profile", at: at(9) })],
      WINDOW,
    );
    const byTab = new Map(report.tabs.map((row) => [row.tab, row]));
    expect(byTab.get("profile")?.dwell_samples).toBe(1);
    expect(byTab.get("dashboard")?.dwell_samples).toBe(0);
    expect(byTab.get("dashboard")?.dwell_seconds_total).toBe(0);
  });

  it("reports per-day rate so two windows of different lengths compare", () => {
    const report = summarizeTabVisits(
      [visit({ tab: "dashboard", at: at(0) }), visit({ tab: "dashboard", at: at(5) })],
      { from: at(0), to: at(5), days: 4 },
    );
    expect(report.tabs[0]?.visits_per_day).toBe(0.5);
  });

  it("counts an admin's view-as browsing rather than hiding it", () => {
    const report = summarizeTabVisits(
      [
        visit({ tab: "dashboard", at: at(0) }),
        visit({ tab: "dashboard", at: at(1), impersonated: true }),
      ],
      WINDOW,
    );
    expect(report.visits).toBe(2);
    expect(report.impersonated_visits).toBe(1);
  });

  it("answers an empty window with an empty report rather than nothing", () => {
    const report = summarizeTabVisits([], WINDOW);
    expect(report.tabs).toEqual([]);
    expect(report.visits).toBe(0);
    expect(report.members).toBe(0);
  });
});

describe("recordTabVisit", () => {
  it("records a visit against the member the session names", () => {
    const service = serviceWithMembers(["ada"]);
    expect(unwrap(service.recordTabVisit("ada", { tab: "adminbotPapers" })).recorded).toBe(true);
    const report = unwrap(service.tabVisitReport());
    expect(report.tabs.map((row) => [row.tab, row.visits, row.members])).toEqual([
      ["adminbotPapers", 1, 1],
    ]);
  });

  it("refuses a member the roster does not have", () => {
    // A log that takes any id is a log whose member column cannot be joined, and whose rows the
    // deletion sweep would never find.
    const service = serviceWithMembers(["ada"]);
    const result = service.recordTabVisit("ghost", { tab: "dashboard" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.status).toBe(404);
  });

  it("refuses a blank or oversized tab id rather than storing one", () => {
    const service = serviceWithMembers(["ada"]);
    expect(service.recordTabVisit("ada", { tab: "   " }).ok).toBe(false);
    expect(service.recordTabVisit("ada", { tab: "x".repeat(65) }).ok).toBe(false);
    expect(unwrap(service.tabVisitReport()).visits).toBe(0);
  });

  it("keeps an unknown tab id, because a newer UI is not an error", () => {
    const service = serviceWithMembers(["ada"]);
    unwrap(service.recordTabVisit("ada", { tab: "somethingNobodyHasShippedYet" }));
    expect(unwrap(service.tabVisitReport()).tabs[0]?.tab).toBe("somethingNobodyHasShippedYet");
  });

  it("marks a view-as visit so an analysis can drop it", () => {
    const service = serviceWithMembers(["ada"]);
    unwrap(service.recordTabVisit("ada", { tab: "profile", impersonated: true }));
    expect(unwrap(service.tabVisitReport()).impersonated_visits).toBe(1);
  });
});

describe("tabVisitReport", () => {
  it("counts only what falls inside the window it reports", () => {
    const service = serviceWithMembers(["ada"]);
    const now = Date.now();
    const days = (count: number) => new Date(now - count * 86_400_000).toISOString();
    unwrap(service.recordTabVisit("ada", { tab: "recent", at: days(2) }));
    unwrap(service.recordTabVisit("ada", { tab: "old", at: days(40) }));

    const month = unwrap(service.tabVisitReport({ days: 30 }));
    expect(month.days).toBe(30);
    expect(month.tabs.map((row) => row.tab)).toEqual(["recent"]);

    const quarter = unwrap(service.tabVisitReport({ days: 90 }));
    expect(quarter.tabs.map((row) => row.tab).toSorted()).toEqual(["old", "recent"]);
  });

  it("clamps a nonsense window instead of failing the page", () => {
    const service = serviceWithMembers(["ada"]);
    expect(unwrap(service.tabVisitReport({ days: 0 })).days).toBe(1);
    expect(unwrap(service.tabVisitReport({ days: 10_000 })).days).toBe(365);
    expect(unwrap(service.tabVisitReport({ days: Number.NaN })).days).toBe(30);
  });

  it("hands over the raw rows for an analysis this service should not be doing", () => {
    const service = serviceWithMembers(["ada"]);
    unwrap(service.recordTabVisit("ada", { tab: "dashboard" }));
    const rows = unwrap(service.listTabVisits({ days: 7 }));
    expect(rows.days).toBe(7);
    expect(rows.visits.map((row) => [row.member_id, row.tab])).toEqual([["ada", "dashboard"]]);
    expect(rows.visits[0]?.at).toBeTypeOf("string");
  });
});
