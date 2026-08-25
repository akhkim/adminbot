// Control UI tests cover the profile-overview read across a service/UI version gap.
//
// The two deploy separately here, so the browser regularly holds a page newer than the service
// answering it. Every counted field is read unguarded while rendering, so a missing one used to
// throw inside the render and blank the page rather than empty a column.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { fetchMemberProfileOverview } from "./auth/session.ts";
import {
  EMPTY_PROFILE_OVERVIEW_FILTER,
  renderAdminBotProfileOverview,
} from "./views/profile-overview.ts";

function respond(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

const OLD_SERVICE_ROW = {
  id: "m-1",
  name: "Mira Member",
  privilege_level: "member",
  missing_fields: ["location"],
  filled_field_count: 11,
};

describe("fetchMemberProfileOverview", () => {
  it("fills in the counts a service that predates them does not send", async () => {
    vi.stubGlobal("fetch", respond({ members: [OLD_SERVICE_ROW], mandatory_field_count: 12 }));
    const result = await fetchMemberProfileOverview("token", "http://service.test");
    vi.unstubAllGlobals();

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const row = result.value.members[0];
    expect(row?.projects).toEqual({ total: 0, self_updated: 0 });
    expect(row?.timeline).toEqual({
      availability: 0,
      time_off: 0,
      milestones: 0,
      trips: 0,
      total: 0,
    });
    expect(row?.self_filled_field_count).toBe(0);
    // What the service did send is untouched.
    expect(row?.name).toBe("Mira Member");
    expect(row?.missing_fields).toEqual(["location"]);
    // The roll-up counts the rows it actually got rather than reporting a lab of nobody.
    expect(result.value.adoption).toEqual({
      members: 1,
      profile_rate: 0,
      project_rate: 0,
      signed_in_ever: 0,
    });
  });

  it("renders those rows instead of throwing the page away", async () => {
    vi.stubGlobal("fetch", respond({ members: [OLD_SERVICE_ROW], mandatory_field_count: 12 }));
    const result = await fetchMemberProfileOverview("token", "http://service.test");
    vi.unstubAllGlobals();
    if (!result.ok) {
      throw new Error("expected the read to succeed");
    }

    const container = document.createElement("div");
    render(
      renderAdminBotProfileOverview({
        members: result.value.members,
        mandatoryFieldCount: result.value.mandatoryFieldCount,
        adoption: result.value.adoption,
        loading: false,
        error: null,
        notice: null,
        reminding: false,
        filter: EMPTY_PROFILE_OVERVIEW_FILTER,
        onFilterChange: vi.fn(),
        onRemind: vi.fn(),
        onOpenMember: vi.fn(),
      }),
      container,
    );
    expect(container.textContent).toContain("Mira Member");
  });
});
