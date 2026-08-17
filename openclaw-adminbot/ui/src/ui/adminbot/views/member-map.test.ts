import { render } from "lit";
import { describe, expect, it } from "vitest";
import { parseMemberMap, type MemberMap } from "../data/member-map.ts";
import { WORLD_OUTLINE_VIEW } from "../data/world-outline.ts";
import { renderMemberMap } from "./member-map.ts";

async function draw(map: MemberMap | null): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderMemberMap(map), container);
  // The card is a custom element; its first render is scheduled asynchronously.
  await (
    container.querySelector("adminbot-member-map") as { updateComplete?: Promise<unknown> } | null
  )?.updateComplete;
  return container;
}

const summary = {
  mode: "summary",
  places: [
    { key: "toronto", label: "Toronto", country: "Canada", lat: 43.65, lon: -79.38, count: 9 },
    { key: "zurich", label: "Zurich", country: "Switzerland", lat: 47.37, lon: 8.54, count: 4 },
  ],
  unplaced: [],
  counts: { placed: 13, unplaced: 0, unknown: 2 },
};

describe("parseMemberMap", () => {
  it("reads the summary shape the service sends a non-admin", () => {
    const map = parseMemberMap(summary)!;
    expect(map.mode).toBe("summary");
    expect(map.places.map((place) => place.label)).toEqual(["Toronto", "Zurich"]);
    // No names in this shape, which is the point of it — not missing data.
    expect(map.places[0].members).toBeUndefined();
  });

  it("reads the full shape and counts from the member list", () => {
    const map = parseMemberMap({
      mode: "full",
      places: [
        {
          key: "toronto",
          label: "Toronto",
          country: "Canada",
          lat: 43.65,
          lon: -79.38,
          members: [
            { member_id: "a", name: "Ada" },
            { member_id: "b", name: "Bob" },
          ],
        },
      ],
      unplaced: [{ member_id: "c", name: "Cy", raw: "somewhere nice" }],
      counts: { placed: 2, unplaced: 1, unknown: 0 },
    })!;
    expect(map.mode).toBe("full");
    expect(map.places[0].count).toBe(2);
    expect(map.places[0].members?.map((member) => member.name)).toEqual(["Ada", "Bob"]);
    // Unplaced is a prompt to extend the gazetteer, so the card only needs how many.
    expect(map.unplaced).toBe(1);
  });

  it("sorts places by headcount so the list reads as a ranking", () => {
    const map = parseMemberMap({
      ...summary,
      places: [summary.places[1], summary.places[0]],
    })!;
    expect(map.places.map((place) => place.label)).toEqual(["Toronto", "Zurich"]);
  });

  // (0, 0) is in the Gulf of Guinea; a place drawn there reads as a real lab presence.
  it("drops a place with no usable coordinates rather than plotting it at null island", () => {
    const map = parseMemberMap({
      ...summary,
      places: [...summary.places, { key: "ghost", label: "Ghost", count: 3 }],
    })!;
    expect(map.places.map((place) => place.key)).not.toContain("ghost");
  });

  it("carries avatar_url and last_login_at through when present, and drops them when blank", () => {
    const map = parseMemberMap({
      mode: "full",
      places: [
        {
          key: "toronto",
          label: "Toronto",
          country: "Canada",
          lat: 43.65,
          lon: -79.38,
          members: [
            {
              member_id: "a",
              name: "Ada",
              avatar_url: "https://example.com/ada.png",
              last_login_at: "2026-01-05T00:00:00.000Z",
            },
            { member_id: "b", name: "Bob", avatar_url: "", last_login_at: "" },
          ],
        },
      ],
      unplaced: [],
      counts: { placed: 2, unplaced: 0, unknown: 0 },
    })!;
    expect(map.places[0].members?.[0]).toEqual({
      member_id: "a",
      name: "Ada",
      avatar_url: "https://example.com/ada.png",
      last_login_at: "2026-01-05T00:00:00.000Z",
    });
    expect(map.places[0].members?.[1]).toEqual({ member_id: "b", name: "Bob" });
  });

  it("returns null for a body that is not a map", () => {
    expect(parseMemberMap(null)).toBeNull();
    expect(parseMemberMap({ error: "nope" })).toBeNull();
  });
});

describe("renderMemberMap", () => {
  it("plots one dot per city and lists them by headcount", async () => {
    const container = await draw(parseMemberMap(summary));
    // Scoped to the card: the full-screen view renders its own copy of the plot.
    const card = container.querySelector(".member-map__body")!;
    expect(card.querySelectorAll(".member-map__dot")).toHaveLength(2);
    expect(
      [...container.querySelectorAll(".member-map__row-label")].map((node) => node.textContent),
    ).toEqual(["Toronto", "Zurich"]);
  });

  // Area is what the eye compares, so a busier city must be a visibly bigger dot.
  it("sizes dots by headcount", async () => {
    const container = await draw(parseMemberMap(summary));
    const [busy, quiet] = [...container.querySelectorAll(".member-map__dot")].map((dot) =>
      Number(dot.getAttribute("r")),
    );
    expect(busy).toBeGreaterThan(quiet);
  });

  it("names who is where only when the service sent names", async () => {
    const withNames = await draw(
      parseMemberMap({
        mode: "full",
        places: [
          {
            key: "toronto",
            label: "Toronto",
            country: "Canada",
            lat: 43.65,
            lon: -79.38,
            members: [{ member_id: "a", name: "Ada" }],
          },
        ],
        unplaced: [],
        counts: { placed: 1, unplaced: 0, unknown: 0 },
      }),
    );
    expect(withNames.querySelector(".member-map__dot title")?.textContent).toContain("Ada");

    const anonymous = await draw(parseMemberMap(summary));
    expect(anonymous.querySelector(".member-map__dot title")?.textContent).not.toContain("Ada");
    expect(anonymous.querySelector(".member-map__dot title")?.textContent).toContain("9");
  });

  it("shows up to 3 avatars per city, most-recently-logged-in first, with a '…' for the rest", async () => {
    const container = await draw(
      parseMemberMap({
        mode: "full",
        places: [
          {
            key: "toronto",
            label: "Toronto",
            country: "Canada",
            lat: 43.65,
            lon: -79.38,
            members: [
              {
                member_id: "a",
                name: "Ada",
                avatar_url: "https://example.com/ada.png",
                last_login_at: "2026-01-01T00:00:00.000Z",
              },
              {
                member_id: "b",
                name: "Bob",
                avatar_url: "https://example.com/bob.png",
                last_login_at: "2026-01-03T00:00:00.000Z",
              },
              { member_id: "c", name: "Cy", last_login_at: "2026-01-02T00:00:00.000Z" },
              { member_id: "d", name: "Di", avatar_url: "https://example.com/di.png" },
            ],
          },
        ],
        unplaced: [],
        counts: { placed: 4, unplaced: 0, unknown: 0 },
      }),
    );
    const avatars = container.querySelectorAll(".member-map__body .member-map__avatar");
    expect(avatars).toHaveLength(3);
    // Bob logged in most recently, then Cy, then Ada; Di (no login recorded) is left out.
    expect([...avatars].map((node) => node.getAttribute("title"))).toEqual(["Bob", "Cy", "Ada"]);
    // Cy has no avatar_url, so their circle is the initials fallback, not an <img>.
    expect(avatars[1].tagName).toBe("SPAN");
    expect(avatars[1].textContent).toBe("C");
    expect(
      container.querySelector(".member-map__body .member-map__avatar-more"),
    ).not.toBeNull();
  });

  const FOUR_MEMBER_TORONTO = {
    mode: "full",
    places: [
      {
        key: "toronto",
        label: "Toronto",
        country: "Canada",
        lat: 43.65,
        lon: -79.38,
        members: [
          { member_id: "a", name: "Ada" },
          { member_id: "b", name: "Bob" },
          { member_id: "c", name: "Cy" },
          { member_id: "d", name: "Di" },
        ],
      },
    ],
    unplaced: [],
    counts: { placed: 4, unplaced: 0, unknown: 0 },
  };

  it("reveals a readable name list below a row's avatars when its expand button is clicked", async () => {
    const container = await draw(parseMemberMap(FOUR_MEMBER_TORONTO));
    const element = container.querySelector("adminbot-member-map") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    const row = container.querySelector(".member-map__body .member-map__row")!;
    const button = row.querySelector<HTMLButtonElement>(".member-map__expand-btn")!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector(".member-map__name-list")).toBeNull();

    button.click();
    await element.updateComplete;

    const expandedRow = container.querySelector(".member-map__body .member-map__row")!;
    const expandedButton = expandedRow.querySelector<HTMLButtonElement>(".member-map__expand-btn")!;
    expect(expandedButton.getAttribute("aria-expanded")).toBe("true");
    expect(
      [...expandedRow.querySelectorAll(".member-map__name-list li")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["Ada", "Bob", "Cy", "Di"]);

    // Clicking again collapses it.
    expandedButton.click();
    await element.updateComplete;
    expect(
      container.querySelector(".member-map__body .member-map__name-list"),
    ).toBeNull();
  });

  it("omits the expand button for a city with 3 or fewer members", async () => {
    const container = await draw(
      parseMemberMap({
        mode: "full",
        places: [
          {
            key: "toronto",
            label: "Toronto",
            country: "Canada",
            lat: 43.65,
            lon: -79.38,
            members: [
              { member_id: "a", name: "Ada" },
              { member_id: "b", name: "Bob" },
            ],
          },
        ],
        unplaced: [],
        counts: { placed: 2, unplaced: 0, unknown: 0 },
      }),
    );
    expect(container.querySelector(".member-map__body .member-map__expand-btn")).toBeNull();
  });

  it("mentions members it could not place", async () => {
    const container = await draw(
      parseMemberMap({ ...summary, unplaced: [{ member_id: "c", name: "Cy" }] }),
    );
    expect(container.querySelector('[data-testid="member-map-unplaced"]')?.textContent).toContain(
      "1",
    );
  });

  // The coastline is what makes a dot identifiable; a graticule alone was unreadable.
  it("draws the world outline under the dots", async () => {
    const container = await draw(parseMemberMap(summary));
    const land = container.querySelector(".member-map__land");
    expect(land).not.toBeNull();
    expect((land?.getAttribute("d") ?? "").length).toBeGreaterThan(1000);
    // Land is painted before the dots, so a coastal city sits on top of its coastline.
    const svgEl = container.querySelector(".member-map__plot")!;
    const nodes = [...svgEl.querySelectorAll(".member-map__land, .member-map__dot")];
    expect(nodes[0]?.classList.contains("member-map__land")).toBe(true);
  });

  // The path is baked into one projection. If the view's constants drifted from the generator's,
  // every dot would slide off the coastline it belongs on and nothing would look obviously broken.
  it("projects dots with the same viewBox the outline was generated for", async () => {
    const container = await draw(parseMemberMap(summary));
    expect(container.querySelector(".member-map__plot")?.getAttribute("viewBox")).toBe(
      `0 0 ${WORLD_OUTLINE_VIEW.width} ${WORLD_OUTLINE_VIEW.height}`,
    );

    // Toronto (43.65N, 79.38W) lands in the upper-left quadrant; Zurich (47.37N, 8.54E) just right
    // of centre. Wrong axis signs would put them in the ocean and still render.
    const dots = [...container.querySelectorAll(".member-map__dot")];
    const toronto = dots[0];
    const zurich = dots[1];
    expect(Number(toronto.getAttribute("cx"))).toBeLessThan(WORLD_OUTLINE_VIEW.width / 2);
    expect(Number(zurich.getAttribute("cx"))).toBeGreaterThan(WORLD_OUTLINE_VIEW.width / 2);
    for (const dot of [toronto, zurich]) {
      expect(Number(dot.getAttribute("cy"))).toBeLessThan(WORLD_OUTLINE_VIEW.height / 2);
    }
  });

  // "Bigger" means the whole screen. A native <dialog> gets the top layer, Escape and focus
  // trapping; the panel only exists while open so the 44kB coastline is not in the DOM twice.
  it("opens full screen from the button and from the map itself, then closes", async () => {
    const container = await draw(parseMemberMap(summary));
    const element = container.querySelector("adminbot-member-map") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    const dialog = () =>
      container.querySelector<HTMLDialogElement>('[data-testid="member-map-dialog"]')!;
    const settled = async () => {
      await element.updateComplete;
      await element.updateComplete;
    };

    expect(dialog().open).toBe(false);
    expect(dialog().querySelector(".member-map__dialog-panel")).toBeNull();

    container.querySelector<HTMLButtonElement>('[data-testid="member-map-toggle"]')!.click();
    await settled();
    expect(dialog().open).toBe(true);
    expect(dialog().querySelector(".member-map__dialog-panel")).not.toBeNull();
    // The full-screen list is the long one.
    expect(dialog().querySelectorAll(".member-map__row-label").length).toBeGreaterThan(0);

    container.querySelector<HTMLButtonElement>('[data-testid="member-map-close"]')!.click();
    await settled();
    expect(dialog().open).toBe(false);
    expect(dialog().querySelector(".member-map__dialog-panel")).toBeNull();

    // The map itself is the affordance too — a map you cannot click to enlarge is one people squint
    // at.
    container.querySelector<HTMLButtonElement>('[data-testid="member-map-plot-button"]')!.click();
    await settled();
    expect(dialog().open).toBe(true);
  });

  it("closes when the dialog reports itself closed, as Escape does", async () => {
    const container = await draw(parseMemberMap(summary));
    const element = container.querySelector("adminbot-member-map") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    container.querySelector<HTMLButtonElement>('[data-testid="member-map-toggle"]')!.click();
    await element.updateComplete;
    await element.updateComplete;

    const dialog = container.querySelector<HTMLDialogElement>(
      '[data-testid="member-map-dialog"]',
    )!;
    // Escape closes the dialog natively and fires `close` without routing through our handler.
    // jsdom implements neither showModal nor close, so the component's fallback is what runs here —
    // which is the path this asserts.
    dialog.open = false;
    dialog.dispatchEvent(new Event("close"));
    await element.updateComplete;
    expect(
      container.querySelector('[data-testid="member-map-dialog"] .member-map__dialog-panel'),
    ).toBeNull();
  });

  // One card fewer beats an empty map on a dashboard whose other cards are waiting on the member.
  it("renders nothing at all when there is nothing to draw", async () => {
    // lit leaves a comment marker where `nothing` was, so assert on the card, not the markup.
    expect((await draw(null)).querySelector('[data-testid="dashboard-member-map"]')).toBeNull();
    expect(
      (await draw(parseMemberMap({ ...summary, places: [] }))).querySelector(
        '[data-testid="dashboard-member-map"]',
      ),
    ).toBeNull();
  });
});
