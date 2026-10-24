import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memberMapFixture } from "../../../test-helpers/member-map-fixture.ts";
import { parseMemberMap, type MemberMap } from "../data/member-map.ts";
import { WORLD_OUTLINE_VIEW } from "../data/world-outline.ts";
import {
  boxesIntersect,
  clusterPoints,
  labelBox,
  layoutLabels,
  radiusFor,
  type MapPoint,
} from "./member-map-layout.ts";
import {
  clampViewport,
  fitViewport,
  NORTH,
  project,
  SOUTH,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  viewportForBounds,
  zoomAt,
} from "./member-map-projection.ts";
import {
  loadWorldOutline,
  memberSource,
  radiusScale,
  renderMemberMap,
  updatedAgo,
  type MemberMapOptions,
} from "./member-map.ts";

type MapElement = HTMLElement & { updateComplete: Promise<unknown> };

function mapElement(container: HTMLElement): MapElement {
  return container.querySelector("adminbot-member-map") as MapElement;
}

// The marker's radius in CSS pixels, as the view laid it out.
function radiusOf(marker: Element): number {
  return Number.parseFloat((marker as HTMLElement).style.getPropertyValue("--r"));
}

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

// --- Layout: clustering, sizing and labels in screen pixels ---

function fixturePoints(size: "lab" | "large", width: number): MapPoint[] {
  const map = parseMemberMap(memberMapFixture({ mode: "summary", size }))!;
  const view = fitViewport({ width, height: Math.round((width * VIEW_HEIGHT) / VIEW_WIDTH) });
  return map.places.map((place) => {
    const at = project(place.lon, place.lat);
    return {
      key: place.key,
      label: place.label,
      count: place.count,
      x: at.x * view.k + view.x,
      y: at.y * view.k + view.y,
    };
  });
}

function expectNoMarkerOverlap(
  clusters: ReturnType<typeof clusterPoints>,
  gap: number,
  minSeparation = 0,
) {
  for (const [index, left] of clusters.entries()) {
    for (const right of clusters.slice(index + 1)) {
      const distance = Math.hypot(left.x - right.x, left.y - right.y);
      expect(
        distance,
        `${left.key} and ${right.key} are ${distance.toFixed(1)}px apart`,
      ).toBeGreaterThanOrEqual(Math.max(left.r + right.r + gap, minSeparation) - 1e-9);
    }
  }
}

describe("member map layout", () => {
  it("sizes markers by area: a city of one is small, the busiest is the largest", () => {
    const scale = radiusScale(720, 29);
    expect(radiusFor(1, scale)).toBe(scale.min);
    expect(radiusFor(29, scale)).toBeCloseTo(scale.max);
    // Four times the people, twice the radius: the disc's area is what the eye compares.
    expect(radiusFor(16, scale) / radiusFor(4, scale)).toBeCloseTo(2);
    // Capped, so a merged continent cannot swallow the map.
    expect(radiusFor(500, scale, true)).toBeLessThanOrEqual(scale.max * 1.2);
    // A merged marker is never smaller than its count can be printed in.
    expect(radiusFor(2, scale, true)).toBeGreaterThanOrEqual(scale.clusterMin);
    // Wider boxes draw bigger markers, up to a cap.
    expect(radiusScale(1440, 29).max).toBeGreaterThan(radiusScale(358, 29).max);
    expect(radiusScale(4000, 29).max).toBe(18);
  });

  for (const width of [358, 720, 1200, 1440]) {
    it(`leaves no two markers overlapping at ${width}px`, () => {
      const points = fixturePoints("lab", width);
      const scale = radiusScale(width, 29);
      const clusters = clusterPoints(points, { scale, gap: 3, minSeparation: 0 });
      expectNoMarkerOverlap(clusters, 3);
      // Merging moves people, it never loses them.
      expect(clusters.reduce((sum, cluster) => sum + cluster.count, 0)).toBe(101);
      expect(new Set(clusters.flatMap((cluster) => cluster.keys)).size).toBe(points.length);
    });
  }

  it("keeps markers a fingertip apart on a touch screen", () => {
    const points = fixturePoints("lab", 358);
    const clusters = clusterPoints(points, {
      scale: radiusScale(358, 29),
      gap: 3,
      minSeparation: 40,
    });
    expectNoMarkerOverlap(clusters, 3, 40);
  });

  it("keeps Toronto and Zürich the two largest markers on the card", () => {
    const clusters = clusterPoints(fixturePoints("lab", 720), {
      scale: radiusScale(720, 29),
      gap: 3,
      minSeparation: 0,
    });
    const biggest = clusters.toSorted((a, b) => b.r - a.r).slice(0, 2);
    expect(biggest.map((cluster) => cluster.lead).toSorted()).toEqual(["toronto", "zurich"]);
  });

  it("gives the same clusters whatever order the places arrive in", () => {
    const points = fixturePoints("lab", 720);
    const options = { scale: radiusScale(720, 29), gap: 3, minSeparation: 0 };
    const reference = clusterPoints(points, options);
    const shuffled = points.toReversed();
    const rotated = [...points.slice(11), ...points.slice(0, 11)];
    expect(clusterPoints(shuffled, options)).toEqual(reference);
    expect(clusterPoints(rotated, options)).toEqual(reference);
  });

  it("labels the busiest places first and never lets two labels or a label and a marker touch", () => {
    const width = 720;
    const height = Math.round((width * VIEW_HEIGHT) / VIEW_WIDTH);
    const clusters = clusterPoints(fixturePoints("lab", width), {
      scale: radiusScale(width, 29),
      gap: 3,
      minSeparation: 0,
    });
    const inputs = clusters.map((cluster) => ({
      key: cluster.key,
      text: cluster.lead,
      x: cluster.x,
      y: cluster.y,
      r: cluster.r,
    }));
    const placed = layoutLabels(inputs, { fontSize: 11, width, height });
    expect(placed.has(inputs[0]!.key)).toBe(true);
    expect(placed.has(inputs[1]!.key)).toBe(true);
    const boxes = [...placed.values()].map((label) => label.box);
    for (const [index, box] of boxes.entries()) {
      expect(box.x0).toBeGreaterThanOrEqual(0);
      expect(box.x1).toBeLessThanOrEqual(width);
      for (const other of boxes.slice(index + 1)) {
        expect(boxesIntersect(box, other)).toBe(false);
      }
      for (const marker of inputs) {
        const nx = Math.max(box.x0, Math.min(marker.x, box.x1));
        const ny = Math.max(box.y0, Math.min(marker.y, box.y1));
        expect(Math.hypot(marker.x - nx, marker.y - ny)).toBeGreaterThanOrEqual(marker.r);
      }
    }
  });

  it("drops the smaller of two colliding labels rather than printing one over the other", () => {
    // Two markers side by side with long names: there is room for exactly one.
    const placed = layoutLabels(
      [
        { key: "big", text: "Somewhere Large", x: 60, y: 20, r: 8 },
        { key: "small", text: "Somewhere Small", x: 60, y: 32, r: 4 },
      ],
      { fontSize: 12, width: 200, height: 50 },
    );
    expect(placed.has("big")).toBe(true);
    expect(placed.has("small")).toBe(false);
    expect(labelBox("ab", 0, 0, "start", 10).x1).toBeGreaterThan(
      labelBox("a", 0, 0, "start", 10).x1,
    );
  });

  it("lays out 250 people in 60 cities quickly enough to redo on every zoom frame", () => {
    const points = fixturePoints("large", 1440);
    expect(points).toHaveLength(60);
    const scale = radiusScale(1440, Math.max(...points.map((point) => point.count)));
    const started = performance.now();
    for (let run = 0; run < 20; run++) {
      const clusters = clusterPoints(points, { scale, gap: 3, minSeparation: 0 });
      layoutLabels(
        clusters.map((cluster) => ({ ...cluster, text: cluster.lead })),
        { fontSize: 12, width: 1440, height: 607, budget: 40 },
      );
    }
    // Generous for a slow CI box; locally this is well under a millisecond a frame.
    expect((performance.now() - started) / 20).toBeLessThan(16);
  });
});

describe("member map projection", () => {
  // The path is baked into one projection. If the view's constants drifted from the generator's,
  // every dot would slide off the coastline it belongs on and nothing would look obviously broken.
  it("matches the projection the coastline was generated with", () => {
    expect(WORLD_OUTLINE_VIEW).toEqual({
      projection: "equal-earth",
      width: VIEW_WIDTH,
      height: VIEW_HEIGHT,
      north: NORTH,
      south: SOUTH,
    });
    expect(project(-180, 0).x).toBeCloseTo(0);
    expect(project(180, 0).x).toBeCloseTo(VIEW_WIDTH);
    expect(project(0, NORTH).y).toBeCloseTo(0);
    expect(project(0, SOUTH).y).toBeCloseTo(VIEW_HEIGHT, 0);
    // Toronto upper left of centre, Zürich upper right: wrong signs would still render.
    const toronto = project(-79.38, 43.65);
    const zurich = project(8.54, 47.37);
    expect(toronto.x).toBeLessThan(VIEW_WIDTH / 2);
    expect(zurich.x).toBeGreaterThan(VIEW_WIDTH / 2);
    expect(toronto.y).toBeLessThan(VIEW_HEIGHT / 2);
  });

  it("fits, zooms about a point and stays inside the map", () => {
    const size = { width: 800, height: 400 };
    const fit = fitViewport(size);
    expect(VIEW_WIDTH * fit.k).toBeLessThanOrEqual(800 + 1e-9);
    const zoomed = zoomAt(fit, 2, 400, 200, size);
    // The map point under the cursor stays under it.
    expect((400 - zoomed.x) / zoomed.k).toBeCloseTo((400 - fit.x) / fit.k);
    // No zooming out past the fit, no panning off into empty space.
    expect(clampViewport({ ...fit, k: fit.k / 4 }, size).k).toBe(fit.k);
    const panned = clampViewport({ ...zoomed, x: 5000 }, size);
    expect(panned.x).toBe(0);
    // A tiny cluster's bounds zoom in, capped.
    const close = viewportForBounds({ x0: 500, y0: 100, x1: 501, y1: 101 }, size, 40);
    expect(close.k).toBeCloseTo(fit.k * 16);
    // ...and still centred on them once capped.
    expect(500.5 * close.k + close.x).toBeCloseTo(400);
    expect(100.5 * close.k + close.y).toBeCloseTo(200);
  });
});

// --- The element ---

// Zürich and Tübingen are a few pixels apart on the card and must share a marker there.
const nearby = {
  mode: "full",
  places: [
    {
      key: "toronto",
      label: "Toronto",
      country: "Canada",
      lat: 43.65,
      lon: -79.38,
      members: [{ member_id: "a", name: "Ada", source: "roster", source_label: "profile" }],
    },
    {
      key: "zurich",
      label: "Zürich",
      country: "Switzerland",
      lat: 47.37,
      lon: 8.54,
      members: [
        { member_id: "b", name: "Bo", source: "login", source_label: "IP today" },
        { member_id: "c", name: "Cy", source: "checkin", source_label: "stated 3d ago" },
      ],
    },
    {
      key: "tubingen",
      label: "Tübingen",
      country: "Germany",
      lat: 48.52,
      lon: 9.06,
      members: [
        {
          member_id: "d",
          name: "Di",
          source: "roster",
          source_label: "profile · IP ignored (VPN?)",
          ip_ignored: "suspected_vpn",
        },
      ],
    },
  ],
  unplaced_count: 0,
  counts: { placed: 4, unplaced: 0, unknown: 0 },
  ip_geolocation: { active: true, provider: "DB-IP Lite" },
};

function reduceMotion() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.includes("reduce"),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderMemberMap", () => {
  it("plots one marker per city and lists them by headcount", async () => {
    const container = await draw(parseMemberMap(summary));
    // Scoped to the card: the full-screen view renders its own copy of the plot.
    const card = container.querySelector(".member-map__body")!;
    expect(card.querySelectorAll(".member-map__dot")).toHaveLength(2);
    expect(
      [...container.querySelectorAll(".member-map__row-label")].map((node) => node.textContent),
    ).toEqual(["Toronto", "Zurich"]);
  });

  // Area is what the eye compares, so a busier city must be a visibly bigger dot.
  it("sizes markers by headcount and prints the count inside the big ones", async () => {
    const container = await draw(parseMemberMap(summary));
    const toronto = container.querySelector('.member-map__marker[data-place="toronto"]')!;
    const zurich = container.querySelector('.member-map__marker[data-place="zurich"]')!;
    expect(radiusOf(toronto)).toBeGreaterThan(radiusOf(zurich));
    expect(radiusOf(toronto) / radiusOf(zurich)).toBeCloseTo(Math.sqrt(9 / 4), 1);
    expect(toronto.querySelector(".member-map__dot")?.textContent?.trim()).toBe("9");
  });

  it("makes every marker a keyboard stop that says who is there, and nothing about how", async () => {
    const container = await draw(parseMemberMap(nearby));
    const toronto = container.querySelector<HTMLButtonElement>(
      '.member-map__body .member-map__marker[data-place="toronto"]',
    )!;
    expect(toronto.tagName).toBe("BUTTON");
    expect(toronto.tabIndex).toBe(0);
    expect(toronto.getAttribute("aria-label")).toBe("Toronto, Canada, 1 members: Ada");

    const anonymous = await draw(parseMemberMap(summary));
    const label = anonymous
      .querySelector('.member-map__marker[data-place="toronto"]')
      ?.getAttribute("aria-label");
    expect(label).toBe("Toronto, Canada — 9 members");
  });

  it("names the person on a dot of one, with the city in its tooltip", async () => {
    const container = await draw(parseMemberMap(nearby));
    const card = container.querySelector(".member-map__body")!;
    const toronto = card.querySelector('.member-map__marker[data-place="toronto"]')!;
    expect(toronto.getAttribute("title")).toBe("Ada · Toronto, Canada");
    expect(card.querySelector('.member-map__label[data-label="toronto"]')?.textContent).toBe("Ada");

    // A viewer who sees counts only gets the city, as before, and no name anywhere.
    const anonymous = await draw(parseMemberMap(summary));
    const counted = anonymous.querySelector('.member-map__marker[data-place="toronto"]')!;
    expect(counted.hasAttribute("title")).toBe(false);
  });

  it("merges cities that would touch into one marker with the total", async () => {
    const container = await draw(parseMemberMap(nearby));
    const card = container.querySelector(".member-map__body")!;
    const cluster = card.querySelector<HTMLElement>(".member-map__marker--cluster")!;
    expect(cluster).not.toBeNull();
    expect(cluster.dataset.cluster).toBe("zurich tubingen");
    expect(cluster.dataset.count).toBe("3");
    expect(cluster.getAttribute("aria-label")).toContain("3 members around Zürich and 1 nearby");
    expect(card.querySelectorAll(".member-map__dot")).toHaveLength(2);
    // The busiest place names the cluster.
    expect(card.querySelector('[data-label="cluster:tubingen|zurich"]')?.textContent).toBe(
      "Zürich +1",
    );
  });

  it("opens full screen on a cluster's members, now far enough apart to stand alone", async () => {
    reduceMotion();
    const container = await draw(parseMemberMap(nearby));
    const element = mapElement(container);
    container
      .querySelector<HTMLButtonElement>(".member-map__body .member-map__marker--cluster")!
      .click();
    await element.updateComplete;
    await element.updateComplete;
    const dialog = container.querySelector<HTMLDialogElement>('[data-testid="member-map-dialog"]')!;
    expect(dialog.open).toBe(true);
    const stage = dialog.querySelector(".member-map__stage--dialog")!;
    expect(stage.classList).toContain("member-map__stage--zoomed");
    expect(stage.querySelector('.member-map__marker[data-place="zurich"]')).not.toBeNull();
    expect(stage.querySelector('.member-map__marker[data-place="tubingen"]')).not.toBeNull();
    // Toronto is off screen at this zoom: not drawn, and not a tab stop nobody can see.
    expect(stage.querySelector('.member-map__marker[data-place="toronto"]')).toBeNull();

    // The whole map again, then zoom in and out with the buttons.
    dialog.querySelector<HTMLButtonElement>('[data-testid="member-map-zoom-reset"]')!.click();
    await element.updateComplete;
    expect(stage.classList).not.toContain("member-map__stage--zoomed");
    expect(
      dialog.querySelector<HTMLButtonElement>('[data-testid="member-map-zoom-out"]')!.disabled,
    ).toBe(true);
    dialog.querySelector<HTMLButtonElement>('[data-testid="member-map-zoom-in"]')!.click();
    await element.updateComplete;
    expect(stage.classList).toContain("member-map__stage--zoomed");
  });

  it("flies full screen to a city picked from its list", async () => {
    reduceMotion();
    const container = await draw(parseMemberMap(nearby));
    const element = mapElement(container);
    container.querySelector<HTMLButtonElement>('[data-testid="member-map-toggle"]')!.click();
    await element.updateComplete;
    await element.updateComplete;
    const dialog = container.querySelector('[data-testid="member-map-dialog"]')!;
    const stage = dialog.querySelector(".member-map__stage--dialog")!;
    expect(stage.classList).not.toContain("member-map__stage--zoomed");
    dialog
      .querySelector<HTMLButtonElement>(
        '.member-map__row[data-place="toronto"] .member-map__row-top',
      )!
      .click();
    await element.updateComplete;
    expect(stage.classList).toContain("member-map__stage--zoomed");
    const toronto = stage.querySelector<HTMLElement>('.member-map__marker[data-place="toronto"]')!;
    expect(toronto.classList).toContain("member-map__marker--active");
    // Centred in the box.
    expect(Number.parseFloat(toronto.style.getPropertyValue("--x"))).toBeCloseTo(600, 0);
  });

  it("keeps where a pin came from out of sight until an admin asks", async () => {
    const container = await draw(parseMemberMap(nearby));
    const element = mapElement(container);
    const sources = ["IP today", "stated 3d ago", "profile", "IP ignored"];
    const text = () => container.textContent ?? "";
    const ariaText = () =>
      [...container.querySelectorAll("[aria-label]")]
        .map((node) => node.getAttribute("aria-label"))
        .join("\n");

    // Point at Zürich's row so its tooltip is up, and expand nothing else.
    container
      .querySelector<HTMLElement>('.member-map__body .member-map__row[data-place="zurich"]')!
      .dispatchEvent(new MouseEvent("mouseenter"));
    await element.updateComplete;
    expect(container.querySelector('[data-testid="member-map-popover"]')?.textContent).toContain(
      "Bo",
    );
    for (const source of sources) {
      expect(text()).not.toContain(source);
      expect(ariaText()).not.toContain(source);
    }
    expect(container.querySelector('[data-testid="member-map-ip-geolocation"]')).toBeNull();

    const how = container.querySelector<HTMLButtonElement>('[data-testid="member-map-how"]')!;
    expect(how.getAttribute("aria-pressed")).toBe("false");
    how.click();
    await element.updateComplete;
    expect(how.getAttribute("aria-pressed")).toBe("true");
    // The service's own phrase, verbatim.
    expect(
      [
        ...container.querySelectorAll(
          '[data-testid="member-map-popover"] [data-testid="member-map-source"]',
        ),
      ].map((node) => node.textContent?.trim()),
    ).toEqual(expect.arrayContaining(["IP today", "stated 3d ago"]));
    expect(
      container.querySelector('[data-testid="member-map-ip-geolocation"]')?.textContent,
    ).toContain("on (DB-IP Lite)");
    // Still never read out: the label is a name and a city.
    expect(ariaText()).not.toContain("IP today");
  });

  it("offers no 'how we placed people' switch to someone who only sees counts", async () => {
    const container = await draw(parseMemberMap(summary));
    expect(container.querySelector('[data-testid="member-map-how"]')).toBeNull();
  });

  describe("memberSource", () => {
    // UTC noon: the service counts days in UTC, and so does the fallback.
    const now = Date.parse("2026-10-15T12:00:00Z");
    const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

    it("uses the service's phrase verbatim when it sends one", () => {
      expect(
        memberSource(
          { member_id: "a", name: "Ada", source: "login", source_label: "IP 4d ago" },
          now,
        ),
      ).toBe("IP 4d ago");
    });

    it("works the same phrase out for an older service", () => {
      const login = (at?: string) => ({
        member_id: "a",
        name: "Ada",
        source: "login" as const,
        ...(at ? { ip_observed_at: at } : {}),
      });
      expect(memberSource(login(hoursAgo(2)), now)).toBe("IP today");
      expect(memberSource(login(hoursAgo(24)), now)).toBe("IP yesterday");
      expect(memberSource(login(hoursAgo(24 * 5)), now)).toBe("IP 5d ago");
      expect(memberSource(login(), now)).toBe("IP");
      expect(
        memberSource(
          { member_id: "e", name: "Ed", source: "checkin", located_at: hoursAgo(72) },
          now,
        ),
      ).toBe("stated 3d ago");
      expect(
        memberSource({ member_id: "b", name: "Bo", source: "roster", precision: "city" }, now),
      ).toBe("profile");
      expect(
        memberSource({ member_id: "b", name: "Bo", source: "roster", precision: "timezone" }, now),
      ).toBe("profile time zone");
      expect(
        memberSource({ member_id: "c", name: "Cy", source: "slack", precision: "timezone" }, now),
      ).toBe("Slack time zone");
      expect(
        memberSource({ member_id: "f", name: "Fi", source: "device", precision: "timezone" }, now),
      ).toBe("device time zone");
      expect(
        memberSource(
          { member_id: "g", name: "Gu", source: "roster", ip_ignored: "suspected_vpn" },
          now,
        ),
      ).toBe("profile · IP ignored (VPN?)");
      expect(memberSource({ member_id: "d", name: "Di" }, now)).toBeUndefined();
    });

    it("flags a Slack zone that disagrees", () => {
      expect(
        memberSource(
          {
            member_id: "e",
            name: "Ed",
            source_label: "stated today",
            tz_mismatch: { slack_tz: "Europe/Berlin", place_tz: "America/Toronto", hours: 6 },
          },
          now,
        ),
      ).toBe("stated today · Slack time zone Europe/Berlin is 6 h off");
    });
  });

  it("shows up to 3 avatars per city, most recently seen first, with a count for the rest", async () => {
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
              // An older sign-in but a fresher daily IP reading: the reading is what counts.
              {
                member_id: "c",
                name: "Cy",
                source: "login",
                last_login_at: "2025-12-01T00:00:00.000Z",
                ip_observed_at: "2026-01-02T00:00:00.000Z",
              },
              { member_id: "d", name: "Di", avatar_url: "https://example.com/di.png" },
            ],
          },
        ],
        unplaced: [],
        counts: { placed: 4, unplaced: 0, unknown: 0 },
      }),
    );
    const avatars = container.querySelectorAll(
      ".member-map__body .member-map__row .member-map__avatar",
    );
    expect(avatars).toHaveLength(3);
    // Bob seen most recently, then Cy, then Ada; Di (never seen) is left out.
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
    const element = mapElement(container);
    const row = container.querySelector(".member-map__body .member-map__row")!;
    const button = row.querySelector<HTMLButtonElement>(".member-map__expand-btn")!;
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

    expandedButton.click();
    await element.updateComplete;
    expect(container.querySelector(".member-map__body .member-map__name-list")).toBeNull();
  });

  it("omits the expand button for a city with 3 or fewer members", async () => {
    const container = await draw(
      parseMemberMap({
        ...FOUR_MEMBER_TORONTO,
        places: [
          {
            ...FOUR_MEMBER_TORONTO.places[0],
            members: FOUR_MEMBER_TORONTO.places[0].members.slice(0, 2),
          },
        ],
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
          { key: "country:BR", label: "Brazil", country: "Brazil", lat: -10, lon: -52, count: 1 },
        ],
      }),
    );
    const approximate = container.querySelectorAll(
      ".member-map__body .member-map__marker--approximate",
    );
    expect(approximate).toHaveLength(1);
    expect(approximate[0]?.getAttribute("aria-label")).toContain("Brazil (country only)");
    expect(container.querySelector('[data-testid="member-map-approximate"]')).not.toBeNull();

    const cityOnly = await draw(parseMemberMap(summary));
    expect(cityOnly.querySelector(".member-map__marker--approximate")).toBeNull();
    expect(cityOnly.querySelector('[data-testid="member-map-approximate"]')).toBeNull();
  });

  it("labels the busiest cities on the card and more of them full screen, none overlapping", async () => {
    const map = parseMemberMap(memberMapFixture({ mode: "summary" }))!;
    const container = await draw(map);
    const element = mapElement(container);
    const labelsIn = (root: Element) =>
      [...root.querySelectorAll<HTMLElement>(".member-map__label")].map(
        (node) => node.dataset.label,
      );
    const card = labelsIn(container.querySelector(".member-map__stage--card")!);
    // At card scale both home cities lead a cluster of their neighbours, and both are named.
    expect(card.some((key) => key?.includes("toronto"))).toBe(true);
    expect(card.some((key) => key?.includes("zurich"))).toBe(true);
    expect(card.length).toBeLessThanOrEqual(8);

    container.querySelector<HTMLButtonElement>('[data-testid="member-map-toggle"]')!.click();
    await element.updateComplete;
    await element.updateComplete;
    const full = labelsIn(container.querySelector(".member-map__stage--dialog")!);
    expect(full.length).toBeGreaterThan(card.length);
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
    const undated = await draw(parseMemberMap(summary), { now });
    expect(undated.querySelector('[data-testid="member-map-updated"]')).toBeNull();
  });

  it("lifts a city's marker, dims the rest and shows its tooltip from the list", async () => {
    const container = await draw(parseMemberMap(summary));
    const element = mapElement(container);
    const card = container.querySelector(".member-map__body")!;
    const zurichRow = card.querySelector<HTMLElement>('.member-map__row[data-place="zurich"]')!;
    const active = () =>
      [...card.querySelectorAll(".member-map__marker--active")].map((node) =>
        node.getAttribute("data-place"),
      );

    zurichRow.dispatchEvent(new MouseEvent("mouseenter"));
    await element.updateComplete;
    expect(card.querySelector(".member-map__stage")?.classList).toContain(
      "member-map__stage--focus",
    );
    expect(active()).toEqual(["zurich"]);
    expect(zurichRow.classList).toContain("member-map__row--active");
    const popover = card.querySelector('[data-testid="member-map-popover"]')!;
    expect(popover.textContent).toContain("Zurich, Switzerland");
    expect(popover.querySelector(".member-map__count")?.textContent).toBe("4");
    // No names to show someone who only sees counts.
    expect(popover.querySelector(".member-map__people")).toBeNull();

    zurichRow.dispatchEvent(new MouseEvent("mouseleave"));
    await element.updateComplete;
    expect(active()).toEqual([]);
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
    expect(active()).toEqual(["zurich"]);
    expect(card.querySelector('[data-testid="member-map-popover"]')).not.toBeNull();
    await tap();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(active()).toEqual([]);

    // And the other way round: pointing at a marker lights its row and shows its tooltip.
    card
      .querySelector('.member-map__marker[data-place="toronto"]')!
      .dispatchEvent(new MouseEvent("mouseenter"));
    await element.updateComplete;
    expect(card.querySelector('.member-map__row[data-place="toronto"]')?.classList).toContain(
      "member-map__row--active",
    );
    expect(card.querySelector('[data-testid="member-map-popover"]')?.textContent).toContain(
      "Toronto, Canada",
    );
  });

  it("wears a Collaborate section's header and panel there, with its own loading and empty states", async () => {
    const section = await draw(parseMemberMap(summary), { variant: "section" });
    const root = section.querySelector('[data-testid="dashboard-member-map"]')!;
    expect(root.tagName).toBe("SECTION");
    expect(root.querySelector("h2.member-map__title")?.textContent).toBe("Where the lab is");
    expect(root.querySelector(".member-map__panel .member-map__dot")).not.toBeNull();
    expect(root.querySelector(".member-map__legend")?.textContent).toContain("more people");

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

  it("credits GeoNames beside DB-IP, and shows the viewer's own-location line when given", async () => {
    const both = await draw(
      parseMemberMap({
        ...summary,
        attribution: { text: "IP geolocation by DB-IP", url: "https://db-ip.com" },
        place_attribution: { text: "Places by GeoNames", url: "https://www.geonames.org" },
      }),
      { ownLocation: html`<span data-testid="synthetic-own">📍 Synthville · Change</span>` },
    );
    const links = [
      ...both.querySelectorAll<HTMLAnchorElement>('[data-testid="member-map-attribution"] a'),
    ];
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      "IP geolocation by DB-IP",
      "Places by GeoNames",
    ]);
    expect(
      both.querySelector('[data-testid="member-map-own-location"] [data-testid="synthetic-own"]'),
    ).not.toBeNull();
    const without = await draw(parseMemberMap(summary));
    expect(without.querySelector('[data-testid="member-map-own-location"]')).toBeNull();
    expect(
      parseMemberMap({ ...summary, place_attribution: { text: "x", url: "http://geonames.test" } })
        ?.placeAttribution,
    ).toBeUndefined();
  });

  it("tells an admin whether sign-in geolocation is on, behind the switch", async () => {
    const base = { places: summary.places, unplaced: 0 };
    const reveal = async (body: Record<string, unknown>) => {
      const container = await draw(parseMemberMap(body));
      container.querySelector<HTMLButtonElement>('[data-testid="member-map-how"]')?.click();
      await mapElement(container)?.updateComplete;
      return container.querySelector('[data-testid="member-map-ip-geolocation"]')?.textContent;
    };
    expect(
      await reveal({ ...base, mode: "full", ip_geolocation: { active: true, provider: "mmdb" } }),
    ).toContain("on (mmdb)");
    expect(
      await reveal({ ...base, mode: "full", ip_geolocation: { active: false, provider: "off" } }),
    ).toContain("off");
    // A summary never shows it, even if a service sent one.
    expect(
      await reveal({ ...summary, ip_geolocation: { active: true, provider: "mmdb" } }),
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
  it("draws the world outline under the markers, sharp at any zoom", async () => {
    await loadWorldOutline();
    const container = await draw(parseMemberMap(summary));
    const land = container.querySelector(".member-map__land");
    expect((land?.getAttribute("d") ?? "").length).toBeGreaterThan(1000);
    expect(land?.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    // The SVG is drawn at the box's own pixel size, not stretched from a fixed viewBox.
    const plot = container.querySelector(".member-map__stage--card .member-map__plot")!;
    expect(plot.getAttribute("viewBox")).toBe(
      `0 0 ${plot.getAttribute("width")} ${plot.getAttribute("height")}`,
    );
    // Land is painted before the markers, so a coastal city sits on top of its coastline.
    const stage = container.querySelector(".member-map__stage--card")!;
    const nodes = [...stage.querySelectorAll(".member-map__land, .member-map__dot")];
    expect(nodes[0]?.classList.contains("member-map__land")).toBe(true);
  });

  // "Bigger" means the whole screen. A native <dialog> gets the top layer, Escape and focus
  // trapping; the panel only exists while open so the coastline is not in the DOM twice.
  it("opens full screen from the button and from the map itself, then closes", async () => {
    const container = await draw(parseMemberMap(summary));
    const element = mapElement(container);
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
    expect(dialog().querySelectorAll(".member-map__row-label").length).toBeGreaterThan(0);
    expect(dialog().querySelector('[data-testid="member-map-zoom-in"]')).not.toBeNull();

    container.querySelector<HTMLButtonElement>('[data-testid="member-map-close"]')!.click();
    await settled();
    expect(dialog().open).toBe(false);
    expect(dialog().querySelector(".member-map__dialog-panel")).toBeNull();

    container.querySelector<HTMLButtonElement>('[data-testid="member-map-plot-button"]')!.click();
    await settled();
    expect(dialog().open).toBe(true);
  });

  it("closes when the dialog reports itself closed, as Escape does", async () => {
    const container = await draw(parseMemberMap(summary));
    const element = mapElement(container);
    container.querySelector<HTMLButtonElement>('[data-testid="member-map-toggle"]')!.click();
    await element.updateComplete;
    await element.updateComplete;

    const dialog = container.querySelector<HTMLDialogElement>('[data-testid="member-map-dialog"]')!;
    dialog.open = false;
    dialog.dispatchEvent(new Event("close"));
    await element.updateComplete;
    expect(
      container.querySelector('[data-testid="member-map-dialog"] .member-map__dialog-panel'),
    ).toBeNull();
  });

  // The card's plot is as wide as the card now, not what a side-by-side list leaves it, so the
  // scene has to be laid out for the box it measures: same projection, bigger box, fewer merges.
  it("redraws and re-clusters the card for whatever size its box measures", async () => {
    let report: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          report = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const container = await draw(parseMemberMap(memberMapFixture({ mode: "summary" })));
    const element = mapElement(container);
    const stage = container.querySelector<HTMLElement>('[data-stage="card"]')!;
    const resize = async (width: number, height: number) => {
      report!(
        [{ target: stage, contentRect: { width, height } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      await element.updateComplete;
      const plot = stage.querySelector("svg.member-map__plot")!;
      return {
        width: Number(plot.getAttribute("width")),
        height: Number(plot.getAttribute("height")),
        markers: stage.querySelectorAll(".member-map__marker").length,
      };
    };
    // What the card used to give the plot beside the list, then the card's full width.
    const narrow = await resize(371, 156);
    const full = await resize(579, 244);
    expect(narrow).toMatchObject({ width: 371, height: 156 });
    expect(full).toMatchObject({ width: 579, height: 244 });
    expect(full.markers).toBeGreaterThan(narrow.markers);
    // Fills the box: the box is the projection's own shape, so the fit leaves no letterbox.
    const fit = fitViewport({ width: 579, height: 244 });
    expect(579 - VIEW_WIDTH * fit.k).toBeLessThan(2);
    expect(244 - VIEW_HEIGHT * fit.k).toBeLessThan(2);
  });

  // One card fewer beats an empty map on a dashboard whose other cards are waiting on the member.
  it("renders nothing at all when there is nothing to draw", async () => {
    expect((await draw(null)).querySelector('[data-testid="dashboard-member-map"]')).toBeNull();
    expect(
      (await draw(parseMemberMap({ ...summary, places: [] }))).querySelector(
        '[data-testid="dashboard-member-map"]',
      ),
    ).toBeNull();
  });
});

describe("member map search", () => {
  const key = (target: Element, name: string) => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const cardSearch = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>(
      '[data-testid="member-map-search-card"] [data-testid="member-map-search-input"]',
    )!;
  const options = (scope: Element) =>
    [...scope.querySelectorAll('[role="option"]')].map((node) => node.textContent?.trim() ?? "");

  it("lists people by name with their city, and moves through them with the arrow keys", async () => {
    const container = await draw(parseMemberMap(nearby));
    const element = mapElement(container);
    const input = cardSearch(container);
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-label")).toBe("Find someone on the map");
    expect(input.placeholder).toBe("Find a person or city");
    expect(input.getAttribute("aria-expanded")).toBe("false");

    input.focus();
    type(input, "c");
    await element.updateComplete;
    const search = container.querySelector('[data-testid="member-map-search-card"]')!;
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const listbox = search.querySelector('[role="listbox"]')!;
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    // Cy by name first; then Toronto by its country, Canada, and Zürich mid-word. No one is listed
    // merely for living in Toronto.
    expect(options(search)).toEqual([
      expect.stringContaining("Cy"),
      expect.stringContaining("Toronto"),
      expect.stringContaining("Zürich"),
    ]);
    expect(search.querySelector('[role="option"]')?.getAttribute("aria-label")).toBe(
      "Cy, Zürich, Switzerland",
    );

    expect(key(input, "ArrowDown").defaultPrevented).toBe(true);
    await element.updateComplete;
    const first = search.querySelectorAll('[role="option"]')[0]!;
    expect(input.getAttribute("aria-activedescendant")).toBe(first.id);
    expect(first.getAttribute("aria-selected")).toBe("true");
    for (let i = 0; i < 3; i++) {
      key(input, "ArrowDown");
      await element.updateComplete;
    }
    // Wraps round to the top.
    expect(input.getAttribute("aria-activedescendant")).toBe(first.id);
    // And from the top back round to the bottom.
    key(input, "ArrowUp");
    await element.updateComplete;
    expect(input.getAttribute("aria-activedescendant")).toBe(
      search.querySelectorAll('[role="option"]')[2]!.id,
    );
  });

  it("flies full screen to the person's city on Enter, names them first, and clears back to the whole map", async () => {
    reduceMotion();
    const container = await draw(parseMemberMap(nearby));
    const element = mapElement(container);
    const settled = async () => {
      for (let i = 0; i < 4; i++) {
        await element.updateComplete;
      }
    };
    const input = cardSearch(container);
    input.focus();
    type(input, "cy");
    await element.updateComplete;
    expect(key(input, "Enter").defaultPrevented).toBe(true);
    await settled();

    const dialog = container.querySelector<HTMLDialogElement>('[data-testid="member-map-dialog"]')!;
    expect(dialog.open).toBe(true);
    const stage = dialog.querySelector(".member-map__stage--dialog")!;
    expect(stage.classList).toContain("member-map__stage--zoomed");
    const lit = stage.querySelector<HTMLElement>(".member-map__marker--active")!;
    expect([lit.dataset.place, ...(lit.dataset.cluster ?? "").split(" ")]).toContain("zurich");
    // Zürich's tooltip, with the person searched for first (Bo would otherwise lead).
    const popover = dialog.querySelector('[data-testid="member-map-popover"]')!;
    expect(popover.textContent).toContain("Zürich, Switzerland");
    const found = popover.querySelector(".member-map__person--found .member-map__name");
    expect(found?.textContent).toBe("Cy");
    expect(popover.querySelector(".member-map__person .member-map__name")?.textContent).toBe("Cy");
    expect(
      dialog
        .querySelector('.member-map__row[data-place="zurich"]')
        ?.classList.contains("member-map__row--active"),
    ).toBe(true);

    // The search carries on in full screen's own box, focused, with the list closed.
    const dialogInput = dialog.querySelector<HTMLInputElement>(
      '[data-testid="member-map-search-input"]',
    )!;
    expect(dialogInput.value).toBe("Cy");
    expect(document.activeElement).toBe(dialogInput);
    expect(dialogInput.getAttribute("aria-expanded")).toBe("false");

    dialog.querySelector<HTMLButtonElement>('[data-testid="member-map-search-clear"]')!.click();
    await settled();
    expect(dialogInput.value).toBe("");
    expect(stage.classList).not.toContain("member-map__stage--zoomed");
    expect(stage.querySelector(".member-map__marker--active")).toBeNull();
    expect(dialog.querySelector('[data-testid="member-map-search-clear"]')).toBeNull();
  });

  it("picks a result with a click and leaves a city picked by hand alone when cleared", async () => {
    reduceMotion();
    const container = await draw(parseMemberMap(nearby));
    const element = mapElement(container);
    container.querySelector<HTMLButtonElement>('[data-testid="member-map-toggle"]')!.click();
    await element.updateComplete;
    await element.updateComplete;
    const dialog = container.querySelector('[data-testid="member-map-dialog"]')!;
    const input = dialog.querySelector<HTMLInputElement>(
      '[data-testid="member-map-search-input"]',
    )!;
    input.focus();
    type(input, "tor");
    await element.updateComplete;
    const option = dialog.querySelector<HTMLElement>('[role="option"][data-place="toronto"]')!;
    // A mousedown must not take focus from the box, or its blur would close the list first.
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    option.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    option.click();
    await element.updateComplete;
    const stage = dialog.querySelector(".member-map__stage--dialog")!;
    expect(stage.querySelector('.member-map__marker[data-place="toronto"]')?.classList).toContain(
      "member-map__marker--active",
    );
    expect(input.value).toBe("Toronto");

    // Picking Zürich's row by hand replaces the search's pick; clearing the box then keeps it.
    dialog
      .querySelector<HTMLButtonElement>(
        '.member-map__row[data-place="zurich"] .member-map__row-top',
      )!
      .click();
    await element.updateComplete;
    type(input, "");
    await element.updateComplete;
    expect(
      dialog
        .querySelector('.member-map__row[data-place="zurich"] .member-map__row-top')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("closes the list on Escape, clears on the next, and only then lets Escape close full screen", async () => {
    const container = await draw(parseMemberMap(nearby));
    const element = mapElement(container);
    container.querySelector<HTMLButtonElement>('[data-testid="member-map-toggle"]')!.click();
    await element.updateComplete;
    await element.updateComplete;
    const dialog = container.querySelector('[data-testid="member-map-dialog"]')!;
    const input = dialog.querySelector<HTMLInputElement>(
      '[data-testid="member-map-search-input"]',
    )!;
    input.focus();
    type(input, "bo");
    await element.updateComplete;
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const reachedDialog = vi.fn();
    dialog.addEventListener("keydown", reachedDialog);

    expect(key(input, "Escape").defaultPrevented).toBe(true);
    await element.updateComplete;
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.value).toBe("bo");

    expect(key(input, "Escape").defaultPrevented).toBe(true);
    await element.updateComplete;
    expect(input.value).toBe("");
    expect(reachedDialog).not.toHaveBeenCalled();

    // Nothing left to clear: the press is the dialog's.
    expect(key(input, "Escape").defaultPrevented).toBe(false);
    expect(reachedDialog).toHaveBeenCalledTimes(1);
  });

  it("finds only cities for a viewer whose map has no names, and says when nothing matches", async () => {
    const container = await draw(parseMemberMap(summary));
    const element = mapElement(container);
    const input = cardSearch(container);
    expect(input.placeholder).toBe("Find a city");
    input.focus();
    type(input, "zur");
    await element.updateComplete;
    const search = container.querySelector('[data-testid="member-map-search-card"]')!;
    expect(options(search)).toEqual([expect.stringContaining("Zurich")]);
    expect(search.querySelector(".member-map__avatar")).toBeNull();

    // No names on this map, so a name finds nobody.
    type(input, "xyz");
    await element.updateComplete;
    expect(options(search)).toEqual([]);
    expect(search.querySelector('[data-testid="member-map-search-none"]')?.textContent).toContain(
      "Nobody on the map matches “xyz”.",
    );
    expect(search.querySelector('[role="status"]')?.textContent).toContain("Nobody on the map");
  });

  // Their names never reach the card, so they cannot be listed -- but they are not silently absent.
  it("says that members who could not be placed cannot be found", async () => {
    const container = await draw(parseMemberMap({ ...nearby, unplaced_count: 3 }));
    const element = mapElement(container);
    const input = cardSearch(container);
    input.focus();
    type(input, "zz");
    await element.updateComplete;
    expect(
      container.querySelector('[data-testid="member-map-search-unplaced"]')?.textContent,
    ).toContain("3 members are not on the map");

    const none = await draw(parseMemberMap(nearby));
    const noneInput = cardSearch(none);
    noneInput.focus();
    type(noneInput, "zz");
    await mapElement(none).updateComplete;
    expect(none.querySelector('[data-testid="member-map-search-unplaced"]')).toBeNull();
  });

  it("finds an admin a member who is not on the map, says why, and goes nowhere", async () => {
    const container = await draw(
      parseMemberMap({
        ...nearby,
        unplaced_count: 2,
        not_on_map: [
          { name: "Cyra Holt", reason: "ip_off" },
          { name: "Cyd Marsh", reason: "no_location" },
        ],
      }),
    );
    const element = mapElement(container);
    const input = cardSearch(container);
    input.focus();
    type(input, "cy");
    await element.updateComplete;
    const search = container.querySelector('[data-testid="member-map-search-card"]')!;
    expect(options(search)).toEqual([
      expect.stringContaining("Cy"),
      expect.stringContaining("Cyd Marsh"),
      expect.stringContaining("Cyra Holt"),
    ]);
    const absent = [...search.querySelectorAll<HTMLElement>('[data-kind="absent"]')];
    expect(absent.map((node) => node.getAttribute("aria-label"))).toEqual([
      "Cyd Marsh, not on the map: No location yet",
      "Cyra Holt, not on the map: Location hidden: IP logging blocked and no city given",
    ]);
    // No city to light, so no swatch and no place key.
    expect(absent[1]!.querySelector(".member-map__swatch")).toBeNull();
    expect(absent[1]!.hasAttribute("data-place")).toBe(false);
    // The list now names everyone, so the "cannot be found here" note would be wrong.
    expect(container.querySelector('[data-testid="member-map-search-unplaced"]')).toBeNull();

    absent[1]!.click();
    await element.updateComplete;
    expect(input.value).toBe("Cyra Holt");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    const dialog = container.querySelector<HTMLDialogElement>('[data-testid="member-map-dialog"]')!;
    expect(dialog.open).toBe(false);
    expect(container.querySelector(".member-map__marker--active")).toBeNull();
    expect(search.querySelector('[data-testid="member-map-search-absent"]')?.textContent).toContain(
      "IP logging blocked",
    );

    type(input, "cyr");
    await element.updateComplete;
    expect(search.querySelector('[data-testid="member-map-search-absent"]')).toBeNull();
  });

  it("never lists names off a summary map, whatever it carried", async () => {
    const container = await draw(
      parseMemberMap({ ...summary, not_on_map: [{ name: "Cyra Holt", reason: "ip_off" }] }),
    );
    const input = cardSearch(container);
    input.focus();
    type(input, "cyra");
    await mapElement(container).updateComplete;
    expect(container.querySelector('[data-kind="absent"]')).toBeNull();
    expect(container.textContent).not.toContain("Cyra");
  });
});
