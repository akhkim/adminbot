import { render } from "lit";
import { describe, expect, it } from "vitest";
import { parseMemberMap, type MemberMap } from "../data/member-map.ts";
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

  it("returns null for a body that is not a map", () => {
    expect(parseMemberMap(null)).toBeNull();
    expect(parseMemberMap({ error: "nope" })).toBeNull();
  });
});

describe("renderMemberMap", () => {
  it("plots one dot per city and lists them by headcount", async () => {
    const container = await draw(parseMemberMap(summary));
    expect(container.querySelectorAll(".member-map__dot")).toHaveLength(2);
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

  it("mentions members it could not place", async () => {
    const container = await draw(
      parseMemberMap({ ...summary, unplaced: [{ member_id: "c", name: "Cy" }] }),
    );
    expect(container.querySelector('[data-testid="member-map-unplaced"]')?.textContent).toContain(
      "1",
    );
  });

  // A world map in one dashboard column is a row of specks, so the card spans the grid and can be
  // opened further. The state lives on the element so a dashboard re-render cannot close it.
  it("expands and collapses, showing more places when open", async () => {
    const many = {
      ...summary,
      places: Array.from({ length: 10 }, (_, index) => ({
        key: `city-${index}`,
        label: `City ${index}`,
        country: "Somewhere",
        lat: 10 + index,
        lon: 10 + index,
        count: 10 - index,
      })),
    };
    const container = await draw(parseMemberMap(many));
    const card = () => container.querySelector('[data-testid="dashboard-member-map"]')!;
    const toggle = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="member-map-toggle"]')!;
    const rows = () => container.querySelectorAll(".member-map__row-label").length;

    expect(card().hasAttribute("data-expanded")).toBe(false);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    const collapsedRows = rows();

    toggle().click();
    await (
      container.querySelector("adminbot-member-map") as { updateComplete?: Promise<unknown> }
    ).updateComplete;

    expect(card().hasAttribute("data-expanded")).toBe(true);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(rows()).toBeGreaterThan(collapsedRows);

    toggle().click();
    await (
      container.querySelector("adminbot-member-map") as { updateComplete?: Promise<unknown> }
    ).updateComplete;
    expect(card().hasAttribute("data-expanded")).toBe(false);
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
