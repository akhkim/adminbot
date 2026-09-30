import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSettings } from "../../storage.ts";
import {
  invalidateMemberMap,
  loadMemberMap,
  needsDashboardMemberMap,
  type MemberMapHost,
} from "./member-map.ts";

afterEach(() => vi.restoreAllMocks());

function mapResponse(label: string): Response {
  return new Response(
    JSON.stringify({
      mode: "summary",
      places: [{ key: label, label, country: "Canada", lat: 43, lon: -79, count: 1 }],
      counts: { placed: 1, unplaced: 0, unknown: 0 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("Dashboard member map loading", () => {
  it("requests the map only on a signed-in Dashboard that has not requested it", () => {
    expect(needsDashboardMemberMap("dashboard", true, undefined, false)).toBe(true);
    expect(needsDashboardMemberMap("profile", true, undefined, false)).toBe(false);
    expect(needsDashboardMemberMap("myWork", true, undefined, false)).toBe(false);
    expect(needsDashboardMemberMap("dashboard", false, undefined, false)).toBe(false);
    expect(needsDashboardMemberMap("dashboard", true, undefined, true)).toBe(false);
    expect(needsDashboardMemberMap("dashboard", true, null, false)).toBe(false);
  });

  it.each(["old first", "new first"])(
    "ignores a superseded map response after profile refresh (%s)",
    async (order) => {
      const resolveFetch: Array<(response: Response) => void> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch.push(resolve);
          }),
      );
      const host: MemberMapHost = {
        settings: { adminBotUrl: "http://127.0.0.1:8765" } as UiSettings,
        adminBotMemberMap: undefined,
        adminBotMemberMapLoading: false,
      };
      const oldRead = loadMemberMap(host);
      invalidateMemberMap(host); // a profile edit or Dashboard refresh
      expect(host.adminBotMemberMapLoading).toBe(false);
      const newRead = loadMemberMap(host);

      if (order === "old first") {
        resolveFetch[0](mapResponse("old"));
        await oldRead;
        expect(host.adminBotMemberMap).toBeUndefined();
        expect(host.adminBotMemberMapLoading).toBe(true);
        resolveFetch[1](mapResponse("new"));
        await newRead;
      } else {
        resolveFetch[1](mapResponse("new"));
        await newRead;
        resolveFetch[0](mapResponse("old"));
        await oldRead;
      }
      expect(host.adminBotMemberMap?.places[0].label).toBe("new");
      expect(host.adminBotMemberMapLoading).toBe(false);
    },
  );
});
