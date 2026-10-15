import { render } from "lit";
import { describe, expect, it } from "vitest";
import { parseMemberMap, type MemberMap } from "../data/member-map.ts";
import { WORLD_OUTLINE_VIEW } from "../data/world-outline.ts";
import { boxesIntersect, labelBox, type LabelAnchor } from "./member-map-labels.ts";
import {
  loadWorldOutline,
  memberDetail,
  renderMemberMap,
  updatedAgo,
  type MemberMapOptions,
} from "./member-map.ts";

async function draw(map: MemberMap | null, options?: MemberMapOptions): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderMemberMap(map, options), container);
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

  it("reads the unplaced count the full map sends in place of the list", () => {
    const map = parseMemberMap({
      mode: "full",
      places: [],
      unplaced_count: 3,
      counts: { placed: 0, unplaced: 2, unknown: 1 },
    })!;
    expect(map.unplaced).toBe(3);
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
    expect(container.querySelector(".member-map__body .member-map__avatar-more")).not.toBeNull();
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
      [...expandedRow.querySelectorAll(".member-map__name-list .member-map__name")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["Ada", "Bob", "Cy", "Di"]);

    // Clicking again collapses it.
    expandedButton.click();
    await element.updateComplete;
    expect(container.querySelector(".member-map__body .member-map__name-list")).toBeNull();
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

  // A country-level place sits on a centroid; drawing it like a city would claim a precision the
  // sign-in geolocation never had.
  it("draws country-only places hollow and says why, and only when there are some", async () => {
    const container = await draw(
      parseMemberMap({
        ...summary,
        places: [
          ...summary.places,
          { key: "country:france", label: "France", country: "France", lat: 46, lon: 2, count: 1 },
        ],
      }),
    );
    const approximate = container.querySelectorAll(".member-map__place--approximate");
    expect(approximate).toHaveLength(1);
    expect(approximate[0]?.querySelector("title")?.textContent).toContain("France (country only)");
    expect(container.querySelector('[data-testid="member-map-approximate"]')).not.toBeNull();

    const cityOnly = await draw(parseMemberMap(summary));
    expect(cityOnly.querySelector(".member-map__place--approximate")).toBeNull();
    expect(cityOnly.querySelector('[data-testid="member-map-approximate"]')).toBeNull();
  });

  describe("labels", () => {
    // Synthetic: four European cities within a dozen viewBox units of each other, where the
    // unplaced labels used to print on top of each other at every font size.
    const europe = parseMemberMap({
      mode: "summary",
      places: [
        {
          key: "london",
          label: "London",
          country: "United Kingdom",
          lat: 51.51,
          lon: -0.13,
          count: 6,
        },
        { key: "berlin", label: "Berlin", country: "Germany", lat: 52.52, lon: 13.4, count: 5 },
        { key: "zurich", label: "Zürich", country: "Switzerland", lat: 47.37, lon: 8.54, count: 4 },
        { key: "paris", label: "Paris", country: "France", lat: 48.86, lon: 2.35, count: 3 },
      ],
      unplaced: [],
      counts: { placed: 18, unplaced: 0, unknown: 0 },
    });

    function visibleLabelBoxes(plot: Element) {
      return [...plot.querySelectorAll<SVGTextElement>(".member-map__label")]
        .filter((text) => !text.classList.contains("member-map__label--hover"))
        .map((text) => {
          const fontSize = Number.parseFloat(text.style.fontSize);
          const strokeWidth = Number.parseFloat(text.style.strokeWidth);
          return {
            text: text.textContent ?? "",
            box: labelBox(
              text.textContent ?? "",
              Number(text.getAttribute("x")),
              Number(text.getAttribute("y")),
              text.getAttribute("text-anchor") as LabelAnchor,
              fontSize,
              strokeWidth,
            ),
          };
        });
    }

    function expectNoOverlap(labels: ReturnType<typeof visibleLabelBoxes>) {
      for (const [index, left] of labels.entries()) {
        for (const right of labels.slice(index + 1)) {
          expect(boxesIntersect(left.box, right.box), `${left.text} overlaps ${right.text}`).toBe(
            false,
          );
        }
      }
    }

    it("never draws two visible labels on top of each other", async () => {
      const container = await draw(europe);
      const labels = visibleLabelBoxes(container.querySelector(".member-map__plot")!);
      // The busiest city is always named; the rest only where there is room.
      expect(labels.map((label) => label.text)).toContain("London");
      expect(labels.length).toBeGreaterThanOrEqual(2);
      expectNoOverlap(labels);
    });

    it("keeps every city's name reachable on hover when it had no room", async () => {
      const container = await draw(europe);
      const plot = container.querySelector(".member-map__plot")!;
      const named = [...plot.querySelectorAll(".member-map__label")].map(
        (text) => text.textContent,
      );
      expect(named.toSorted()).toEqual(["Berlin", "London", "Paris", "Zürich"]);
    });

    it("fits more labels without overlap at full screen", async () => {
      const container = await draw(europe);
      (container.querySelector('[data-testid="member-map-toggle"]') as HTMLButtonElement).click();
      const element = container.querySelector("adminbot-member-map") as unknown as {
        updateComplete: Promise<unknown>;
      };
      await element.updateComplete;
      const plot = container.querySelector(".member-map__dialog-plot .member-map__plot")!;
      const cardCount = visibleLabelBoxes(
        container.querySelector(".member-map__body .member-map__plot")!,
      ).length;
      const labels = visibleLabelBoxes(plot);
      expect(labels.length).toBeGreaterThanOrEqual(cardCount);
      expectNoOverlap(labels);
    });
  });

  describe("where each person's pin comes from", () => {
    // Local noon, so "today" and "yesterday" are the same calendar days in any test time zone.
    const now = new Date(2026, 9, 15, 12, 0, 0).getTime();
    const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const sf = { label: "San Francisco" };

    it("dates a sign-in by the viewer's calendar and names a profile or Slack source", () => {
      const login = (at?: string) => ({
        member_id: "a",
        name: "Ada",
        source: "login" as const,
        last_login_at: at,
      });
      expect(memberDetail(login(hoursAgo(2)), sf, now)).toBe("San Francisco · from sign-in today");
      expect(memberDetail(login(hoursAgo(24)), sf, now)).toBe(
        "San Francisco · from sign-in yesterday",
      );
      expect(memberDetail(login(hoursAgo(24 * 5)), sf, now)).toBe(
        "San Francisco · from sign-in 5 days ago",
      );
      expect(memberDetail(login(), sf, now)).toBe("San Francisco · from sign-in");
      const toronto = { label: "Toronto" };
      expect(
        memberDetail(
          { member_id: "b", name: "Bo", source: "roster", precision: "city" },
          toronto,
          now,
        ),
      ).toBe("Toronto · from profile");
      expect(
        memberDetail(
          { member_id: "b", name: "Bo", source: "roster", precision: "timezone" },
          toronto,
          now,
        ),
      ).toBe("Toronto · from profile time zone");
      expect(
        memberDetail(
          { member_id: "c", name: "Cy", source: "slack", precision: "city" },
          toronto,
          now,
        ),
      ).toBe("Toronto · from Slack profile");
      expect(
        memberDetail(
          { member_id: "c", name: "Cy", source: "slack", precision: "timezone" },
          toronto,
          now,
        ),
      ).toBe("Toronto · from Slack time zone");
      // An older service that sends no source: the city alone, rather than a guess.
      expect(memberDetail({ member_id: "d", name: "Di" }, toronto, now)).toBe("Toronto");
    });

    it("puts the line in each pin's title for an admin", async () => {
      const container = await draw(
        parseMemberMap({
          mode: "full",
          places: [
            {
              key: "san-francisco",
              label: "San Francisco",
              country: "United States",
              lat: 37.77,
              lon: -122.42,
              members: [
                {
                  member_id: "a",
                  name: "Ada",
                  source: "login",
                  precision: "city",
                  last_login_at: hoursAgo(1),
                },
              ],
            },
            {
              key: "toronto",
              label: "Toronto",
              country: "Canada",
              lat: 43.65,
              lon: -79.38,
              members: [{ member_id: "b", name: "Bo", source: "roster", precision: "city" }],
            },
          ],
          unplaced: [],
          counts: { placed: 2, unplaced: 0, unknown: 0 },
        }),
        { now },
      );
      const titles = [...container.querySelectorAll(".member-map__plot .member-map__dot title")]
        .map((title) => title.textContent ?? "")
        .join("\n");
      expect(titles).toContain("Ada (San Francisco · from sign-in today)");
      expect(titles).toContain("Bo (Toronto · from profile)");
    });
  });

  it("says how long ago the map was read", async () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(updatedAgo(now - 20_000, now)).toBe("Updated just now");
    expect(updatedAgo(now - 4 * 60_000, now)).toBe("Updated 4 min ago");
    expect(updatedAgo(now - 130 * 60_000, now)).toBe("Updated 2 h ago");

    const map = { ...parseMemberMap(summary)!, loadedAt: now - 3 * 60_000 };
    const container = await draw(map, { now });
    expect(container.querySelector('[data-testid="member-map-updated"]')?.textContent).toContain(
      "Updated 3 min ago",
    );
    // A map with no read time (an older caller) just leaves the line out.
    const undated = await draw(parseMemberMap(summary), { now });
    expect(undated.querySelector('[data-testid="member-map-updated"]')).toBeNull();
  });

  it("lifts a city's pin, dims the rest and opens its popover from the list", async () => {
    const container = await draw(parseMemberMap(summary));
    const element = container.querySelector("adminbot-member-map") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    const card = container.querySelector(".member-map__body")!;
    const zurichRow = card.querySelector<HTMLElement>('.member-map__row[data-place="zurich"]')!;

    zurichRow.dispatchEvent(new MouseEvent("mouseenter"));
    await element.updateComplete;
    expect(card.querySelector(".member-map__plot")?.classList).toContain("member-map__plot--focus");
    expect(
      [...card.querySelectorAll(".member-map__place--active")].map((node) =>
        node.getAttribute("data-place"),
      ),
    ).toEqual(["zurich"]);
    expect(zurichRow.classList).toContain("member-map__row--active");
    expect(card.querySelector('[data-testid="member-map-popover"]')?.textContent).toContain(
      "Zurich, Switzerland",
    );

    zurichRow.dispatchEvent(new MouseEvent("mouseleave"));
    await element.updateComplete;
    expect(card.querySelector(".member-map__place--active")).toBeNull();
    expect(card.querySelector('[data-testid="member-map-popover"]')).toBeNull();

    // A tap on a phone: pick, then tap again to let go. A real tap sends the emulated mouseenter and
    // the focus before the click, each followed by a render, so the click must not undo them.
    const button = zurichRow.querySelector<HTMLButtonElement>(".member-map__row-top")!;
    const tap = async () => {
      zurichRow.dispatchEvent(new MouseEvent("mouseenter"));
      await element.updateComplete;
      button.dispatchEvent(new FocusEvent("focus"));
      await element.updateComplete;
      button.click();
      await element.updateComplete;
    };
    await tap();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(card.querySelector(".member-map__place--active")?.getAttribute("data-place")).toBe(
      "zurich",
    );
    expect(card.querySelector('[data-testid="member-map-popover"]')).not.toBeNull();
    await tap();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(card.querySelector(".member-map__place--active")).toBeNull();

    // And the other way round: pointing at a pin lights its row.
    card
      .querySelector('.member-map__place[data-place="toronto"]')!
      .dispatchEvent(new MouseEvent("mouseenter"));
    await element.updateComplete;
    expect(card.querySelector('.member-map__row[data-place="toronto"]')?.classList).toContain(
      "member-map__row--active",
    );
  });

  it("names who is at a pin, and how they were placed, only for an admin", async () => {
    const now = new Date(2026, 9, 15, 12, 0, 0).getTime();
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
            members: [{ member_id: "b", name: "Bo", source: "roster", precision: "city" }],
          },
        ],
        unplaced: [],
        counts: { placed: 1, unplaced: 0, unknown: 0 },
      }),
      { now },
    );
    const element = container.querySelector("adminbot-member-map") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    container
      .querySelector<HTMLElement>(".member-map__body .member-map__row")!
      .dispatchEvent(new MouseEvent("mouseenter"));
    await element.updateComplete;
    const popover = container.querySelector('[data-testid="member-map-popover"]')!;
    expect(popover.querySelector(".member-map__name")?.textContent).toBe("Bo");
    expect(popover.querySelector(".member-map__name-detail")?.textContent).toBe(
      "Toronto · from profile",
    );

    const summaryCard = await draw(parseMemberMap(summary));
    const summaryElement = summaryCard.querySelector("adminbot-member-map") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    summaryCard
      .querySelector<HTMLElement>(".member-map__body .member-map__row")!
      .dispatchEvent(new MouseEvent("mouseenter"));
    await summaryElement.updateComplete;
    const summaryPopover = summaryCard.querySelector('[data-testid="member-map-popover"]')!;
    expect(summaryPopover.querySelector(".member-map__people")).toBeNull();
    expect(summaryPopover.querySelector(".member-map__popover-count")?.textContent).toBe("9");
  });

  it("wears a Collaborate section's header and panel there, with its own loading and empty states", async () => {
    const section = await draw(parseMemberMap(summary), { variant: "section" });
    const root = section.querySelector('[data-testid="dashboard-member-map"]')!;
    expect(root.tagName).toBe("SECTION");
    expect(root.querySelector("h2.member-map__title")?.textContent).toBe("Where the lab is");
    expect(root.querySelector(".member-map__panel .member-map__dot")).not.toBeNull();
    expect(root.querySelector(".member-map__legend")?.textContent).toContain("City");

    const card = await draw(parseMemberMap(summary));
    expect(card.querySelector('[data-testid="dashboard-member-map"]')?.tagName).toBe("ARTICLE");

    const loading = await draw(null, { variant: "section", loading: true });
    expect(loading.querySelector('[data-testid="member-map-loading"]')?.textContent).toContain(
      "Loading the map",
    );
    const empty = await draw(parseMemberMap({ ...summary, places: [] }), { variant: "section" });
    expect(empty.querySelector('[data-testid="member-map-empty"]')).not.toBeNull();
    // A failed read is not "nobody is here": the section steps aside rather than say so.
    expect((await draw(null, { variant: "section" })).querySelector(".member-map")).toBeNull();
  });

  it("credits the IP geolocation provider when the service names one, and only over https", async () => {
    const credited = await draw(
      parseMemberMap({
        ...summary,
        attribution: { text: "IP geolocation by DB-IP", url: "https://db-ip.com" },
      }),
    );
    const link = credited.querySelector<HTMLAnchorElement>(
      '[data-testid="member-map-attribution"] a',
    );
    expect(link?.textContent?.trim()).toBe("IP geolocation by DB-IP");
    expect(link?.getAttribute("href")).toBe("https://db-ip.com");
    expect(link?.getAttribute("rel")).toContain("noopener");

    const plain = await draw(parseMemberMap(summary));
    expect(plain.querySelector('[data-testid="member-map-attribution"]')).toBeNull();
    expect(
      parseMemberMap({ ...summary, attribution: { text: "x", url: "javascript:alert(1)" } })
        ?.attribution,
    ).toBeUndefined();
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
    await loadWorldOutline();
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

    const dialog = container.querySelector<HTMLDialogElement>('[data-testid="member-map-dialog"]')!;
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
