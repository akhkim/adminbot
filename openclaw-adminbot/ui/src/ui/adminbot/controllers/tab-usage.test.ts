// The export, which is the half of this feature a paper actually reads.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import type { UiSettings } from "../../storage.ts";
import type { TabVisitRow } from "../auth/session.ts";
import { saveStoredMemberSession } from "../auth/session.ts";
import {
  exportAdminBotTabUsage,
  loadAdminBotTabUsage,
  tabVisitsCsv,
  type AdminBotTabUsageHost,
} from "./tab-usage.ts";

function row(fields: Partial<TabVisitRow> & { tab: string }): TabVisitRow {
  return {
    id: "tabv_1",
    member_id: "ada",
    at: "2026-09-01T09:00:00.000Z",
    ...fields,
  };
}

describe("tabVisitsCsv", () => {
  it("writes the service's own field names as the header", () => {
    // The column in the paper's analysis and the column here have to mean the same thing without a
    // translation table, so these are deliberately not the camelCase the page uses.
    expect(tabVisitsCsv([]).split("\n")[0]).toBe("id,member_id,tab,at,impersonated");
  });

  it("writes one row per visit, with the flag as 0 or 1", () => {
    const csv = tabVisitsCsv([
      row({ id: "a", tab: "dashboard" }),
      row({ id: "b", tab: "profile", impersonated: true }),
    ]);
    expect(csv.split("\n")).toEqual([
      "id,member_id,tab,at,impersonated",
      "a,ada,dashboard,2026-09-01T09:00:00.000Z,0",
      "b,ada,profile,2026-09-01T09:00:00.000Z,1",
    ]);
  });

  it("quotes a value that would otherwise shift every column after it", () => {
    // Not hypothetical for a member id imported from a spreadsheet: "Chen, Mei" is one field and
    // unquoted it is two, which moves the timestamp into the tab column for that row only.
    const csv = tabVisitsCsv([row({ tab: "dash,board", member_id: 'say "hi"' })]);
    expect(csv.split("\n")[1]).toBe('tabv_1,"say ""hi""","dash,board",2026-09-01T09:00:00.000Z,0');
  });

  it("quotes a value carrying a newline rather than ending the row early", () => {
    const csv = tabVisitsCsv([row({ tab: "two\nlines" })]);
    expect(csv).toContain('"two\nlines"');
    // The header plus one logical row, even though the file has three physical lines.
    expect(csv.split("\n")).toHaveLength(3);
  });

  it("answers an empty log with a header and nothing else", () => {
    expect(tabVisitsCsv([])).toBe("id,member_id,tab,at,impersonated");
  });
});

describe("tab usage session boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("ignores A's late report after B signs in", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "token-a", memberId: "a" } as never);
    let finish: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const host: AdminBotTabUsageHost = {
      settings: { adminBotUrl: "https://admin.safe.eu" } as UiSettings,
      adminBotTabUsage: null,
      adminBotTabUsageDays: 7,
      adminBotTabUsageLoading: false,
      adminBotTabUsageError: null,
      adminBotTabUsageExporting: false,
    };
    const loading = loadAdminBotTabUsage(host);
    saveStoredMemberSession({ sessionToken: "token-b", memberId: "b" } as never);
    host.adminBotTabUsageLoading = false;
    finish?.(
      new Response(JSON.stringify({ visits: 99, tabs: [] }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await loading;
    expect(host.adminBotTabUsage).toBeNull();
    expect(host.adminBotTabUsageLoading).toBe(false);
  });

  it("does not download A's late CSV under B's session", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    saveStoredMemberSession({ sessionToken: "token-a", memberId: "a" } as never);
    const createElement = vi.fn(() => {
      throw new Error("stale export downloaded");
    });
    vi.stubGlobal("document", { createElement });
    let finish: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const host: AdminBotTabUsageHost = {
      settings: { adminBotUrl: "https://admin.safe.eu" } as UiSettings,
      adminBotTabUsage: null,
      adminBotTabUsageDays: 7,
      adminBotTabUsageLoading: false,
      adminBotTabUsageError: null,
      adminBotTabUsageExporting: false,
    };
    const exporting = exportAdminBotTabUsage(host);
    saveStoredMemberSession({ sessionToken: "token-b", memberId: "b" } as never);
    host.adminBotTabUsageExporting = false;
    finish?.(
      new Response(JSON.stringify({ visits: [row({ tab: "private" })] }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    await exporting;
    expect(createElement).not.toHaveBeenCalled();
  });
});
