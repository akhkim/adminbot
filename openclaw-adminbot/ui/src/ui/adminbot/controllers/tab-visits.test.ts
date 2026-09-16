// The write side of the usage log: what gets recorded, and what deliberately does not.
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordTabVisit = vi.fn();
let storedSession: { sessionToken: string } | null = { sessionToken: "token" };

vi.mock("../auth/session.ts", () => ({
  recordTabVisit: (...args: unknown[]) => recordTabVisit(...args),
  loadStoredMemberSession: () => storedSession,
  resolveAdminBotBaseUrl: () => "http://localhost",
}));

const { recordAdminBotTabVisit } = await import("./tab-visits.ts");

type Host = Parameters<typeof recordAdminBotTabVisit>[0];

function host(): Host {
  return { settings: {} } as Host;
}

beforeEach(() => {
  recordTabVisit.mockReset();
  storedSession = { sessionToken: "token" };
});

describe("recordAdminBotTabVisit", () => {
  it("records the tab that was opened", () => {
    recordAdminBotTabVisit(host(), "adminbotPapers");
    expect(recordTabVisit).toHaveBeenCalledWith("token", "http://localhost", "adminbotPapers");
  });

  it("ignores a repeat of the tab already open", () => {
    // The router re-asserts the current tab on a hash change, on a "view as" switch and on the
    // head-professor landing. None of those is a second visit, and counting them would inflate
    // exactly the tabs that get landed on.
    const state = host();
    recordAdminBotTabVisit(state, "dashboard");
    recordAdminBotTabVisit(state, "dashboard");
    recordAdminBotTabVisit(state, "dashboard");
    expect(recordTabVisit).toHaveBeenCalledTimes(1);
  });

  it("records the return to a tab that was left in between", () => {
    const state = host();
    recordAdminBotTabVisit(state, "dashboard");
    recordAdminBotTabVisit(state, "adminbotPapers");
    recordAdminBotTabVisit(state, "dashboard");
    expect(recordTabVisit).toHaveBeenCalledTimes(3);
  });

  it("keeps one host's last tab out of another's", () => {
    // Two hosts in one page (a test, an embedded shell) must not swallow each other's first visit,
    // which is what module-level state would do.
    const first = host();
    const second = host();
    recordAdminBotTabVisit(first, "dashboard");
    recordAdminBotTabVisit(second, "dashboard");
    expect(recordTabVisit).toHaveBeenCalledTimes(2);
  });

  it("records nothing for a visitor with no session", () => {
    // Real browsing, but there is nobody to attribute it to and the service would refuse the row.
    storedSession = null;
    const state = host();
    recordAdminBotTabVisit(state, "adminbotDeadlines");
    expect(recordTabVisit).not.toHaveBeenCalled();
    // And it must not remember the attempt, or the visit would be lost after signing in.
    storedSession = { sessionToken: "token" };
    recordAdminBotTabVisit(state, "adminbotDeadlines");
    expect(recordTabVisit).toHaveBeenCalledTimes(1);
  });
});
