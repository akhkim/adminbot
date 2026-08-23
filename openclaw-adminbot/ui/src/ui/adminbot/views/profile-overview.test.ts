// The admin's profile sweep: what a row says, and what the page lets an admin do about it.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { MemberProfileOverviewRow } from "../auth/session.ts";
import { renderAdminBotProfileOverview, type ProfileOverviewFilter } from "./profile-overview.ts";

type DrawOptions = {
  members?: MemberProfileOverviewRow[];
  mandatoryFieldCount?: number;
  loading?: boolean;
  error?: string | null;
  notice?: string | null;
  reminding?: boolean;
  filter?: Partial<ProfileOverviewFilter>;
};

function draw(options: DrawOptions = {}) {
  const reminds: Array<{ include: string; memberIds: string[] }> = [];
  const opened: string[] = [];
  const filters: ProfileOverviewFilter[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderAdminBotProfileOverview({
      members: options.members ?? [],
      mandatoryFieldCount: options.mandatoryFieldCount ?? 12,
      loading: options.loading ?? false,
      error: options.error ?? null,
      notice: options.notice ?? null,
      reminding: options.reminding ?? false,
      filter: { gap: "all", membership: "everyone", ...options.filter },
      onFilterChange: (next) => filters.push(next),
      onRemind: (scope) => reminds.push(scope),
      onOpenMember: (id) => opened.push(id),
    }),
    container,
  );
  return { container, reminds, opened, filters };
}

function member(fields: Partial<MemberProfileOverviewRow> = {}): MemberProfileOverviewRow {
  return {
    id: "ada",
    name: "Ada Lovelace",
    status: "active",
    privilege_level: "member",
    missing_fields: [],
    filled_field_count: 12,
    timeline: { availability: 2, time_off: 1, milestones: 0, trips: 0, total: 3 },
    ...fields,
  };
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".profile-overview__row")];
}

describe("profile overview", () => {
  it("puts every column of the sweep on one line", () => {
    const { container } = draw({ members: [member()] });
    expect(
      [...container.querySelectorAll(".profile-overview__head")].map((h) => h.textContent?.trim()),
    ).toEqual(["Member", "Profile", "Still missing", "Timeline entries", "Last reminded"]);
  });

  it("shows completion against the count the service supplied, not a hardcoded one", () => {
    // The service does not check `name`, so the denominator is 12 rather than the 13 in the
    // exported field list. A client that counted the list itself would show 92% for a finished
    // profile forever.
    const { container } = draw({
      members: [member({ filled_field_count: 12, missing_fields: [] })],
      mandatoryFieldCount: 12,
    });
    expect(container.querySelector(".profile-overview__percent")?.textContent).toBe("100%");
  });

  it("names the blanks rather than only counting them", () => {
    const { container } = draw({
      members: [member({ missing_fields: ["cv_url", "linkedin_urn"], filled_field_count: 10 })],
    });
    const blanks = [...container.querySelectorAll(".profile-overview__missing li")].map((li) =>
      li.textContent?.trim(),
    );
    expect(blanks).toEqual(["Cv", "Linkedin URN"]);
    expect(container.querySelector(".profile-overview__percent")?.textContent).toBe("83%");
  });

  it("says a finished profile is finished instead of leaving the cell blank", () => {
    const { container } = draw({ members: [member()] });
    expect(container.querySelector(".profile-overview__done")?.textContent).toContain("Complete");
  });

  it("flags a thin timeline, and leaves a used one alone", () => {
    const thin = draw({
      members: [
        member({ timeline: { availability: 1, time_off: 0, milestones: 0, trips: 0, total: 1 } }),
      ],
    });
    expect(thin.container.querySelector(".profile-overview__timeline.is-short")).not.toBeNull();

    const used = draw({ members: [member()] });
    expect(used.container.querySelector(".profile-overview__timeline.is-short")).toBeNull();
  });

  it("puts the breakdown behind a tooltip rather than in four more columns", () => {
    const { container } = draw({ members: [member()] });
    expect(container.querySelector(".profile-overview__timeline")?.getAttribute("title")).toContain(
      "2 availability",
    );
  });

  it("says who has never been reminded", () => {
    const { container } = draw({ members: [member({ missing_fields: ["cv_url"] })] });
    expect(container.textContent).toContain("Never");
  });

  it("hides the finished rows when the sweep filter is on", () => {
    const people = [
      member({ id: "done", name: "Done" }),
      member({ id: "blank", name: "Blank", missing_fields: ["cv_url"], filled_field_count: 11 }),
      member({
        id: "thin",
        name: "Thin",
        timeline: { availability: 0, time_off: 0, milestones: 1, trips: 0, total: 1 },
      }),
    ];
    expect(rows(draw({ members: people, filter: { gap: "all" } }).container)).toHaveLength(3);
    // A thin timeline counts as outstanding too -- it is half of what this page is for.
    const swept = rows(draw({ members: people, filter: { gap: "any" } }).container);
    expect(swept.map((row) => row.textContent?.includes("Done"))).toEqual([false, false]);
  });

  it("changes what is outstanding through the filter", () => {
    const drawn = draw({ members: [member()], filter: { gap: "any" } });
    const select = drawn.container.querySelector<HTMLSelectElement>(
      '[data-testid="profile-overview-filter-gap"]',
    );
    select!.value = "timeline";
    select?.dispatchEvent(new Event("change", { bubbles: true }));
    expect(drawn.filters).toEqual([{ gap: "timeline", membership: "everyone" }]);
  });

  // The whole point of the pair of filters: full members who never planned their term are a
  // group an admin can now see and chase in one gesture.
  it("finds full members with no timeline, and chases only them", () => {
    const people = [
      member({ id: "planned", name: "Planned" }),
      member({
        id: "thin",
        name: "Thin",
        timeline: { availability: 0, time_off: 0, milestones: 0, trips: 0, total: 0 },
      }),
      member({
        id: "guest",
        name: "Guest",
        privilege_level: "external_collaborator",
        timeline: { availability: 0, time_off: 0, milestones: 0, trips: 0, total: 0 },
      }),
    ];
    const drawn = draw({ members: people, filter: { gap: "timeline", membership: "full" } });
    // The collaborator is not asked when they are working; the full member with nothing is.
    expect(rows(drawn.container).map((row) => row.textContent?.includes("Thin"))).toEqual([true]);
    drawn.container
      .querySelector<HTMLButtonElement>('[data-testid="profile-overview-remind"]')
      ?.click();
    expect(drawn.reminds).toEqual([{ include: "timeline", memberIds: ["thin"] }]);
  });

  it("counts only incomplete profiles on the reminder button", () => {
    const { container } = draw({
      members: [member(), member({ id: "b", missing_fields: ["cv_url"] })],
    });
    const button = container.querySelector<HTMLButtonElement>(
      "[data-testid='profile-overview-remind']",
    );
    expect(button?.textContent).toContain("1");
    expect(button?.disabled).toBe(false);
  });

  it("offers nothing to send when every profile is complete", () => {
    const { container } = draw({ members: [member()] });
    expect(
      container.querySelector<HTMLButtonElement>("[data-testid='profile-overview-remind']")
        ?.disabled,
    ).toBe(true);
  });

  it("blocks a second send while one is in flight", () => {
    const { container } = draw({
      members: [member({ missing_fields: ["cv_url"] })],
      reminding: true,
    });
    const button = container.querySelector<HTMLButtonElement>(
      "[data-testid='profile-overview-remind']",
    );
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Sending…");
  });

  it("sends the reminder when pressed", () => {
    const drawn = draw({ members: [member({ missing_fields: ["cv_url"] })] });
    drawn.container
      .querySelector<HTMLButtonElement>("[data-testid='profile-overview-remind']")
      ?.click();
    expect(drawn.reminds).toHaveLength(1);
  });

  it("routes to the member for the follow-up conversation", () => {
    const drawn = draw({ members: [member()] });
    drawn.container.querySelector<HTMLButtonElement>(".logistics-requests__open")?.click();
    expect(drawn.opened).toEqual(["ada"]);
  });

  it("reports a read that failed, and one that has not happened yet", () => {
    expect(
      draw({ error: "Could not reach the AdminBot service." }).container.querySelector(
        ".logistics-requests__error",
      )?.textContent,
    ).toContain("Could not reach");
    expect(
      draw({ loading: true }).container.querySelector(".logistics-requests__empty")?.textContent,
    ).toContain("Reading profiles…");
  });

  it("says the sweep is clear rather than showing a bare header", () => {
    const { container } = draw({ members: [member()], filter: { gap: "any" } });
    expect(container.querySelector(".profile-overview__table")).toBeNull();
    expect(container.querySelector(".logistics-requests__empty")?.textContent).toContain(
      "Everyone is caught up",
    );
  });
});
