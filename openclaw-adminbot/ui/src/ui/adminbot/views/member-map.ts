// Where the lab is, as a card on the Dashboard and on Collaborate, and full screen behind it.
//
// Two layers over one box. The land is SVG: the Natural Earth coastline, pre-projected to Equal
// Earth by scripts/generate-world-outline.mjs and drawn under a transform, so zooming and panning
// only rewrite one attribute and the strokes stay a hairline at any scale. The markers, their
// labels and the tooltip are HTML positioned in CSS pixels over it -- buttons, so every city and
// cluster is reachable by keyboard and screen reader, and sized in pixels, so a city of one is a
// small dot at every zoom instead of a blob that grows with the map.
//
// What is drawn is recomputed for the box's pixel size and the current zoom (member-map-layout.ts):
// cities that would touch merge into a cluster showing the total, labels go to the busiest places
// first and only where they fit. At world scale Zürich and Tübingen are one marker; zoomed into
// Europe they separate.
//
// The list is not a fallback for the map; the two answer different questions. The plot shows
// spread, the list shows rank. Neither alone is the answer to "where is the lab".
//
// Where a pin came from ("IP today", "stated 3d ago") is an admin's question, not a reader's, so
// the default view shows a name and a city and nothing else. An admin turns on "How we placed
// people" to see the service's own phrase beside each name.
import { html, LitElement, nothing, svg } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../../i18n/index.ts";
import type {
  MemberMap,
  MemberMapAbsenceReason,
  MemberMapAbsentMember,
  MemberMapMember,
  MemberMapPlace,
} from "../data/member-map.ts";
import {
  clusterPoints,
  layoutLabels,
  type Cluster,
  type PlacedLabel,
  type RadiusScale,
} from "./member-map-layout.ts";
import {
  clampViewport,
  fitViewport,
  lerpViewport,
  MAX_ZOOM,
  NORTH,
  project,
  SOUTH,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  viewportForBounds,
  zoomAt,
  type Size,
  type Viewport,
} from "./member-map-projection.ts";
import {
  foldForSearch,
  searchMemberMap,
  searchResultKey,
  type MemberMapSearchResult,
} from "./member-map-search.ts";

// The coastline arrives on its own: markers and list draw at once and the land fills in under them
// when the chunk lands. A failed fetch is forgotten so the next element to connect retries.
let worldOutlinePath: string | null = null;
let worldOutlineLoad: Promise<void> | undefined;

export function loadWorldOutline(): Promise<void> {
  worldOutlineLoad ??= import("../data/world-outline.ts").then(
    (mod) => {
      worldOutlinePath = mod.WORLD_OUTLINE_PATH;
    },
    () => {
      worldOutlineLoad = undefined;
    },
  );
  return worldOutlineLoad;
}

// A faint graticule in map units: meridians curve under Equal Earth, parallels stay straight.
function graticulePath(): string {
  const parts: string[] = [];
  for (let lon = -150; lon <= 150; lon += 30) {
    const points: string[] = [];
    for (let lat = SOUTH; lat <= NORTH; lat += 5) {
      const { x, y } = project(lon, Math.min(lat, NORTH));
      points.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    parts.push(`M${points.join("L")}`);
  }
  for (const lat of [-30, 0, 30, 60]) {
    const west = project(-180, lat);
    const east = project(180, lat);
    parts.push(
      `M${west.x.toFixed(1)} ${west.y.toFixed(1)}L${east.x.toFixed(1)} ${east.y.toFixed(1)}`,
    );
  }
  return parts.join("");
}

const GRATICULE = graticulePath();

// How many cities the list names. Collapsed it is a summary; expanded there is room for the roster
// of places, which is most of what the gazetteer holds.
const LIST_LIMIT = 6;
const LIST_LIMIT_EXPANDED = 60;

// Faces per city row and people per tooltip before "+N more".
const AVATAR_LIMIT = 3;
const TOOLTIP_PEOPLE = 4;
const TOOLTIP_PLACES = 5;
// Names an aria-label reads out before "+N more": enough to be useful, short enough to listen to.
const ARIA_NAMES = 8;

const DAY_MS = 86_400_000;

function startOfUtcDay(time: number): number {
  const day = new Date(time);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

type AgeKeys = { undated: string; today: string; yesterday: string; daysAgo: string };

const IP_AGE: AgeKeys = {
  undated: "dashboard.memberMap.sourceIp",
  today: "dashboard.memberMap.sourceIpToday",
  yesterday: "dashboard.memberMap.sourceIpYesterday",
  daysAgo: "dashboard.memberMap.sourceIpDaysAgo",
};

const STATED_AGE: AgeKeys = {
  undated: "dashboard.memberMap.sourceStated",
  today: "dashboard.memberMap.sourceStatedToday",
  yesterday: "dashboard.memberMap.sourceStatedYesterday",
  daysAgo: "dashboard.memberMap.sourceStatedDaysAgo",
};

// UTC days, as the service counts them, so the fallback agrees with the service's own phrase.
function agePhrase(at: string | undefined, now: number, keys: AgeKeys): string {
  const seen = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(seen)) {
    return t(keys.undated);
  }
  const days = Math.max(0, Math.round((startOfUtcDay(now) - startOfUtcDay(seen)) / DAY_MS));
  if (days === 0) {
    return t(keys.today);
  }
  return days === 1 ? t(keys.yesterday) : t(keys.daysAgo, { count: String(days) });
}

// For a service too old to send `source_label`: the same vocabulary, worked out from the fields.
function derivedSource(member: MemberMapMember, now: number): string | undefined {
  const timezone = member.precision === "timezone";
  switch (member.source) {
    case "login":
      return agePhrase(
        member.ip_observed_at ?? member.located_at ?? member.last_login_at,
        now,
        IP_AGE,
      );
    case "checkin":
      return agePhrase(member.located_at, now, STATED_AGE);
    case "roster":
      return t(
        timezone
          ? "dashboard.memberMap.sourceProfileTimezone"
          : "dashboard.memberMap.sourceProfile",
      );
    case "slack":
      return t(
        timezone ? "dashboard.memberMap.sourceSlackTimezone" : "dashboard.memberMap.sourceSlack",
      );
    case "device":
      return t("dashboard.memberMap.sourceDevice");
    default:
      return undefined;
  }
}

/** "Slack time zone Europe/Berlin is 6 h off": the pin stays put, but an admin sees the doubt. */
function mismatchPhrase(member: MemberMapMember): string | undefined {
  const mismatch = member.tz_mismatch;
  if (!mismatch) {
    return undefined;
  }
  const hours = String(Math.round(mismatch.hours * 2) / 2);
  return t("dashboard.memberMap.tzMismatch", { zone: mismatch.slack_tz, hours });
}

/**
 * How a member was placed and how fresh it is, for the admin-only detail. The service's own
 * `source_label` wins verbatim; only an older service that sends none gets a phrase worked out
 * here. Never shown unless an admin asks for it.
 */
export function memberSource(
  member: MemberMapMember,
  now: number = Date.now(),
): string | undefined {
  const base =
    member.source_label ??
    [
      derivedSource(member, now),
      member.ip_ignored === "suspected_vpn" ? t("dashboard.memberMap.sourceIpIgnored") : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  const parts = [base, mismatchPhrase(member)].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** "Updated just now" / "Updated 4 min ago" / "Updated 2 h ago". */
export function updatedAgo(loadedAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - loadedAt) / 60_000));
  if (minutes < 1) {
    return t("dashboard.memberMap.updatedJustNow");
  }
  return minutes < 60
    ? t("dashboard.memberMap.updatedMinutes", { count: String(minutes) })
    : t("dashboard.memberMap.updatedHours", { count: String(Math.floor(minutes / 60)) });
}

function placeWhere(place: MemberMapPlace): string {
  // A country-level place's label already is the country, so "France, France" would be noise.
  if (place.approximate) {
    return t("dashboard.memberMap.approximatePlace", { place: place.label });
  }
  return place.country ? `${place.label}, ${place.country}` : place.label;
}

// Why a member is not on the map, as the search shows it. "IP logging blocked" is a member who
// stated their location as none: the service then never looks their sign-in address up.
const ABSENCE_KEYS: Record<MemberMapAbsenceReason, string> = {
  hidden: "dashboard.memberMap.absentHidden",
  ip_off: "dashboard.memberMap.absentIpOff",
  suspected_vpn: "dashboard.memberMap.absentVpn",
  browser_blocked: "dashboard.memberMap.absentBrowserBlocked",
  unrecognised: "dashboard.memberMap.absentUnrecognised",
  no_location: "dashboard.memberMap.absentNoLocation",
};

function absenceText(reason: MemberMapAbsenceReason): string {
  return t(ABSENCE_KEYS[reason]);
}

function seenAt(member: MemberMapMember): string | undefined {
  return member.ip_observed_at ?? member.last_login_at;
}

/**
 * A place's members, most recently seen first, for the faces and the first names shown.
 *
 * Display-only ordering: `place.members` itself is untouched. Someone never seen sorts after
 * everyone who has been, rather than colliding at some fake epoch.
 */
function recentActiveMembers(place: MemberMapPlace, limit = AVATAR_LIMIT): MemberMapMember[] {
  return (place.members ?? [])
    .toSorted((left, right) => {
      const a = seenAt(left);
      const b = seenAt(right);
      if (!a || !b) {
        return a ? -1 : b ? 1 : 0;
      }
      return b.localeCompare(a);
    })
    .slice(0, limit);
}

function namesPhrase(names: string[], total: number): string {
  const shown = names.slice(0, ARIA_NAMES).join(", ");
  return total > ARIA_NAMES
    ? `${shown} ${t("dashboard.more", { count: String(total - ARIA_NAMES) })}`
    : shown;
}

// --- Scene: what one box draws at its size and zoom ---

type StageKind = "card" | "dialog";

type Marker = Cluster & { places: MemberMapPlace[] };

type Scene = {
  kind: StageKind;
  size: Size;
  view: Viewport;
  markers: Marker[];
  labels: Map<string, PlacedLabel>;
  fontSize: number;
};

// Without a ResizeObserver (the test DOM) the box cannot be measured; these stand in.
const FALLBACK_SIZE: Record<StageKind, Size> = {
  card: { width: 720, height: Math.round((720 * VIEW_HEIGHT) / VIEW_WIDTH) },
  dialog: { width: 1200, height: Math.round((1200 * VIEW_HEIGHT) / VIEW_WIDTH) },
};

const LABEL_FONT: Record<StageKind, number> = { card: 11, dialog: 12 };
const LABEL_BUDGET: Record<StageKind, number> = { card: 8, dialog: 40 };

// Markers merge closer than this on a touch screen or a phone-sized box, so no two share a
// fingertip and each keeps its 40px tap target to itself.
const TOUCH_SEPARATION = 40;

const projectedCache = new WeakMap<MemberMap, Map<string, { x: number; y: number }>>();

function projected(map: MemberMap): Map<string, { x: number; y: number }> {
  let cached = projectedCache.get(map);
  if (!cached) {
    cached = new Map(map.places.map((place) => [place.key, project(place.lon, place.lat)]));
    projectedCache.set(map, cached);
  }
  return cached;
}

function coarsePointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Marker sizes for a box this wide: the busiest single city gets `max`, a city of one `min`, area
 * proportional between. A wider box gets bigger markers, up to a cap, so the card and the full
 * screen look like the same map rather than one of them shouting.
 */
export function radiusScale(width: number, reference: number): RadiusScale {
  const max = Math.min(18, Math.max(9, width / 52));
  return { min: Math.max(3, max * 0.26), max, reference, clusterMin: Math.min(max, 9) };
}

function markerLabel(marker: Marker): string {
  const lead = marker.places[0]!;
  return marker.places.length === 1
    ? lead.label
    : t("dashboard.memberMap.clusterLabel", {
        place: lead.label,
        count: String(marker.places.length - 1),
      });
}

function buildScene(map: MemberMap, kind: StageKind, size: Size, view: Viewport): Scene {
  const positions = projected(map);
  const byKey = new Map(map.places.map((place) => [place.key, place]));
  const points = map.places.map((place) => {
    const at = positions.get(place.key)!;
    return {
      key: place.key,
      label: place.label,
      count: place.count,
      x: at.x * view.k + view.x,
      y: at.y * view.k + view.y,
    };
  });
  const reference = Math.max(...map.places.map((place) => place.count), 1);
  const scale = radiusScale(size.width, reference);
  const touch = coarsePointer() || size.width < 480;
  const clusters = clusterPoints(points, {
    scale,
    gap: 3,
    minSeparation: touch ? TOUCH_SEPARATION : 0,
  });
  const markers = clusters
    // Off the box entirely once zoomed in: not drawn, and not a tab stop nobody can see.
    .filter(
      (cluster) =>
        cluster.x >= -cluster.r &&
        cluster.y >= -cluster.r &&
        cluster.x <= size.width + cluster.r &&
        cluster.y <= size.height + cluster.r,
    )
    .map((cluster) => ({ ...cluster, places: cluster.keys.map((key) => byKey.get(key)!) }));
  const fontSize = LABEL_FONT[kind];
  const labels = layoutLabels(
    markers.map((marker) => ({
      key: marker.key,
      text: markerLabel(marker),
      x: marker.x,
      y: marker.y,
      r: marker.r,
    })),
    { fontSize, width: size.width, height: size.height, budget: LABEL_BUDGET[kind] },
  );
  return { kind, size, view, markers, labels, fontSize };
}

function markerAria(marker: Marker): string {
  const lead = marker.places[0]!;
  if (marker.places.length > 1) {
    return t("dashboard.memberMap.clusterAria", {
      count: String(marker.count),
      place: lead.label,
      more: String(marker.places.length - 1),
    });
  }
  const members = lead.members ?? [];
  if (members.length === 0) {
    return t("dashboard.memberMap.placeCount", {
      place: placeWhere(lead),
      count: String(lead.count),
    });
  }
  return t("dashboard.memberMap.placeAria", {
    place: placeWhere(lead),
    count: String(lead.count),
    names: namesPhrase(
      members.map((member) => member.name),
      members.length,
    ),
  });
}

// --- Pieces shared by the stage and the list ---

function renderAvatar(member: MemberMapMember) {
  return member.avatar_url
    ? html`<img class="member-map__avatar" src=${member.avatar_url} alt="" title=${member.name} />`
    : html`<span class="member-map__avatar member-map__avatar--fallback" title=${member.name}
        >${member.name.slice(0, 1).toUpperCase()}</span
      >`;
}

/**
 * Faces for a place's most recently active members, admin/full mode only (`members` is absent in
 * `summary` mode, so this renders nothing for anyone who cannot already see names).
 */
function renderAvatars(place: MemberMapPlace) {
  if (!place.members || place.members.length === 0) {
    return nothing;
  }
  return html`
    <span class="member-map__avatars">
      ${recentActiveMembers(place).map(renderAvatar)}
      ${place.members.length > AVATAR_LIMIT
        ? html`<span class="member-map__avatar-more">+${place.members.length - AVATAR_LIMIT}</span>`
        : nothing}
    </span>
  `;
}

function renderPersonLine(member: MemberMapMember, sources: boolean, now: number) {
  const source = sources ? memberSource(member, now) : undefined;
  return html`<li>
    <span class="member-map__name">${member.name}</span>
    ${source
      ? html`<span class="member-map__source" data-testid="member-map-source">${source}</span>`
      : nothing}
  </li>`;
}

/**
 * Which place is picked out, and how to change it. The list and the markers share one highlight:
 * point at "Toronto" in the list and its marker lifts while the rest dim, and the reverse.
 */
interface PlaceFocus {
  /** The place lit by hovering or focusing its row: transient. */
  active?: string;
  /** The place a click or tap picked, which stays lit after the pointer or focus moves on. */
  picked?: string;
  /** The person a search found: their place's tooltip lists them first, wherever they rank. */
  spotlight?: { place: string; member: string };
  sources: boolean;
  now: number;
}

/**
 * The tooltip's faces: the most recently seen, unless a search found someone here, who goes first
 * -- otherwise searching for the fifth-most-recent person in Toronto would light Toronto and show
 * four other people.
 */
function tooltipPeople(place: MemberMapPlace, focus: PlaceFocus): MemberMapMember[] {
  const recent = recentActiveMembers(place, TOOLTIP_PEOPLE);
  const spotlight = focus.spotlight;
  const found =
    spotlight?.place === place.key
      ? place.members?.find((member) => member.member_id === spotlight.member)
      : undefined;
  return found
    ? [found, ...recent.filter((member) => member !== found)].slice(0, TOOLTIP_PEOPLE)
    : recent;
}

/**
 * The card over a marker: the city (or the cluster's places), its headcount and, for an admin, the
 * first few faces and names. Decoration only -- `pointer-events: none`, `aria-hidden` -- since the
 * marker's own label already says all of it to a screen reader, and the list says it to everyone.
 */
/**
 * `only` narrows a merged marker's tooltip to one of its places: pointing at Tübingen in the list
 * lights the cluster it sits in, but the question asked was about Tübingen.
 */
function renderTooltip(
  marker: Marker,
  scene: Scene,
  focus: PlaceFocus,
  only?: Marker["places"][number],
) {
  const { width, height } = scene.size;
  const boxWidth = Math.min(248, width - 16);
  const left = Math.min(Math.max(marker.x - boxWidth / 2, 8), width - boxWidth - 8);
  const above = marker.y > height * 0.45;
  const offset = marker.r + 10;
  const position = above
    ? `bottom: ${(height - marker.y + offset).toFixed(1)}px`
    : `top: ${(marker.y + offset).toFixed(1)}px`;
  const lead = only ?? marker.places[0]!;
  const cluster = !only && marker.places.length > 1;
  const count = only ? only.count : marker.count;
  const people = cluster ? [] : tooltipPeople(lead, focus);
  const total = lead.members?.length ?? 0;
  return html`
    <div
      class=${`member-map__popover${above ? " member-map__popover--above" : ""}`}
      style="left: ${left.toFixed(1)}px; width: ${boxWidth}px; ${position}"
      data-testid="member-map-popover"
      aria-hidden="true"
    >
      <p class="member-map__popover-head">
        <span class="member-map__popover-title"
          >${cluster
            ? t("dashboard.memberMap.clusterTitle", {
                place: lead.label,
                count: String(marker.places.length - 1),
              })
            : placeWhere(lead)}</span
        >
        <span class="member-map__count">${count}</span>
      </p>
      ${cluster
        ? html`<ul class="member-map__popover-places">
              ${marker.places
                .slice(0, TOOLTIP_PLACES)
                .map(
                  (place) =>
                    html`<li>
                      <span>${place.label}</span
                      ><span class="member-map__count-plain">${place.count}</span>
                    </li>`,
                )}
            </ul>
            ${marker.places.length > TOOLTIP_PLACES
              ? html`<p class="member-map__popover-more">
                  ${t("dashboard.more", { count: String(marker.places.length - TOOLTIP_PLACES) })}
                </p>`
              : nothing}
            <p class="member-map__popover-hint">${t("dashboard.memberMap.clusterHint")}</p>`
        : people.length > 0
          ? html`<ul class="member-map__people member-map__people--faces">
                ${people.map(
                  (member) => html`<li
                    class=${`member-map__person${
                      focus.spotlight?.place === lead.key &&
                      focus.spotlight.member === member.member_id
                        ? " member-map__person--found"
                        : ""
                    }`}
                  >
                    ${renderAvatar(member)}
                    <span class="member-map__person-text">
                      <span class="member-map__name">${member.name}</span>
                      ${focus.sources && memberSource(member, focus.now)
                        ? html`<span class="member-map__source" data-testid="member-map-source"
                            >${memberSource(member, focus.now)}</span
                          >`
                        : nothing}
                    </span>
                  </li>`,
                )}
              </ul>
              ${total > people.length
                ? html`<p class="member-map__popover-more">
                    ${t("dashboard.more", { count: String(total - people.length) })}
                  </p>`
                : nothing}`
          : nothing}
    </div>
  `;
}

type ListOptions = PlaceFocus & {
  expanded: boolean;
  expandedPlaces: ReadonlySet<string>;
  onToggleExpand: (key: string) => void;
  onFocus: (key: string | undefined) => void;
  onPick: (key: string) => void;
};

/**
 * The cities with their counts. Each row is a button: hovering or focusing it lifts that city's
 * marker, and picking it keeps it lit -- and, full screen, flies the map to it.
 */
function renderList(map: MemberMap, options: ListOptions) {
  const shown = map.places.slice(0, options.expanded ? LIST_LIMIT_EXPANDED : LIST_LIMIT);
  const rest = map.places.length - shown.length;
  return html`
    <ul class="member-map__list">
      ${shown.map((place) => {
        const memberCount = place.members?.length ?? 0;
        const canExpand = memberCount > AVATAR_LIMIT;
        const isPlaceExpanded = canExpand && options.expandedPlaces.has(place.key);
        const isActive = (options.active ?? options.picked) === place.key;
        return html`
          <li
            class=${`member-map__row${isActive ? " member-map__row--active" : ""}`}
            data-place=${place.key}
            @mouseenter=${() => options.onFocus(place.key)}
            @mouseleave=${() => options.onFocus(undefined)}
          >
            <button
              type="button"
              class="member-map__row-top"
              aria-pressed=${options.picked === place.key ? "true" : "false"}
              @focus=${() => options.onFocus(place.key)}
              @blur=${() => options.onFocus(undefined)}
              @click=${() => options.onPick(place.key)}
            >
              <span class="member-map__row-main">
                <span
                  class=${`member-map__swatch${place.approximate ? " member-map__swatch--country" : ""}`}
                ></span>
                <span class="member-map__row-label">${place.label}</span>
              </span>
              <span class="member-map__row-side">
                ${renderAvatars(place)}
                <span class="member-map__row-count">${place.count}</span>
              </span>
            </button>
            ${canExpand
              ? html`
                  <button
                    type="button"
                    class="member-map__expand-btn"
                    aria-expanded=${isPlaceExpanded ? "true" : "false"}
                    @click=${() => options.onToggleExpand(place.key)}
                  >
                    ${isPlaceExpanded
                      ? t("dashboard.memberMap.showFewerMembers")
                      : t("dashboard.memberMap.showAllMembers", { count: String(memberCount) })}
                  </button>
                  ${isPlaceExpanded && place.members
                    ? html`<ul class="member-map__people member-map__name-list">
                        ${place.members.map((member) =>
                          renderPersonLine(member, options.sources, options.now),
                        )}
                      </ul>`
                    : nothing}
                `
              : nothing}
          </li>
        `;
      })}
      ${rest > 0
        ? html`<li class="member-map__row member-map__row--more">
            ${t("dashboard.more", { count: String(rest) })}
          </li>`
        : nothing}
    </ul>
  `;
}

function hasSourceDetail(map: MemberMap): boolean {
  return (
    map.mode === "full" &&
    map.places.some((place) =>
      (place.members ?? []).some(
        (member) =>
          member.source_label !== undefined ||
          member.source !== undefined ||
          member.ip_ignored !== undefined ||
          member.tz_mismatch !== undefined,
      ),
    )
  );
}

/**
 * Legend, then the small print: who could not be placed, the provider credit, and for an admin the
 * "How we placed people" switch with what sits behind it.
 */
function renderFoot(map: MemberMap, sources: boolean, onToggleSources: () => void) {
  const canExplain = hasSourceDetail(map) || map.ipGeolocation !== undefined;
  return html`
    <div class="member-map__foot">
      <ul class="member-map__legend">
        <li>
          <span class="member-map__key member-map__key--size"></span>${t(
            "dashboard.memberMap.legendSize",
          )}
        </li>
        <li>
          <span class="member-map__key member-map__key--cluster"></span>${t(
            "dashboard.memberMap.legendCluster",
          )}
        </li>
        ${map.places.some((place) => place.approximate)
          ? html`<li
              data-testid="member-map-approximate"
              title=${t("dashboard.memberMap.approximateNote")}
            >
              <span class="member-map__key member-map__key--country"></span>${t(
                "dashboard.memberMap.legendCountry",
              )}
            </li>`
          : nothing}
      </ul>
      <div class="member-map__notes">
        ${map.unplaced > 0
          ? html`<p class="member-map__note" data-testid="member-map-unplaced">
              ${t("dashboard.memberMap.unplaced", { count: String(map.unplaced) })}
            </p>`
          : nothing}
        ${map.attribution || map.placeAttribution
          ? html`<p
              class="member-map__note member-map__credit"
              data-testid="member-map-attribution"
            >
              ${[map.attribution, map.placeAttribution]
                .filter((credit) => credit !== undefined)
                .map(
                  (credit, index) =>
                    html`${index > 0 ? " · " : nothing}<a
                        href=${credit.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        >${credit.text}</a
                      >`,
                )}
            </p>`
          : nothing}
        ${canExplain
          ? html`<button
              type="button"
              class="member-map__how"
              data-testid="member-map-how"
              aria-pressed=${sources ? "true" : "false"}
              @click=${onToggleSources}
            >
              ${t("dashboard.memberMap.howPlaced")}
            </button>`
          : nothing}
      </div>
      ${sources && canExplain
        ? html`<div class="member-map__how-detail" data-testid="member-map-how-detail">
            <p class="member-map__note">${t("dashboard.memberMap.howPlacedNote")}</p>
            ${map.ipGeolocation
              ? html`<p class="member-map__note" data-testid="member-map-ip-geolocation">
                  ${map.ipGeolocation.active
                    ? t("dashboard.memberMap.ipGeoActive", { provider: map.ipGeolocation.provider })
                    : t("dashboard.memberMap.ipGeoInactive")}
                </p>`
              : nothing}
          </div>`
        : nothing}
    </div>
  `;
}

/**
 * Where the map is drawn. "card" is a tile in the Dashboard's summary grid and wears that grid's
 * card; "section" is a Collaborate section -- an h2 header like the sections around it, over a
 * bordered panel -- so the same map reads as part of whichever page it is on.
 */
export type MemberMapVariant = "card" | "section";

export interface MemberMapOptions {
  variant?: MemberMapVariant;
  /** The render's clock. Passing a fresh one on every app render keeps "Updated N min ago" true. */
  now?: number;
  /** Still fetching the first copy: the Collaborate section shows its loading panel. */
  loading?: boolean;
  /**
   * The viewer's own-location line under the headline: the passive "Use my precise location"
   * control, or "📍 City · Change" once their device has named a city. Omitted, no line.
   */
  ownLocation?: unknown;
}

type PointerState = { x: number; y: number };

type Gesture = {
  view: Viewport;
  pointers: Map<number, PointerState>;
  moved: boolean;
};

// Per element, for the search box's option ids.
let searchInstances = 0;

function nextSearchId(): string {
  searchInstances += 1;
  return `member-map-search-${searchInstances}`;
}

const ZOOM_STEP = 1.8;
const ZOOM_DURATION_MS = 420;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function centroid(points: Iterable<PointerState>): PointerState & { spread: number } {
  const list = [...points];
  const x = list.reduce((sum, point) => sum + point.x, 0) / list.length;
  const y = list.reduce((sum, point) => sum + point.y, 0) / list.length;
  const spread = list.length < 2 ? 0 : Math.hypot(list[0]!.x - list[1]!.x, list[0]!.y - list[1]!.y);
  return { x, y, spread };
}

/**
 * The card, plus the full-screen view behind it.
 *
 * A native <dialog> rather than a positioned overlay: it renders in the top layer so no z-index in
 * the app can cover it, closes on Escape, and traps focus.
 *
 * A custom element because the open state, the zoom, the highlighted city and the expanded rows
 * have to survive the page re-rendering underneath them, which happens whenever other data lands.
 */
class AdminbotMemberMap extends LitElement {
  static override properties = {
    map: { attribute: false },
    variant: { attribute: false },
    now: { attribute: false },
    ownLocation: { attribute: false },
    opened: { state: true },
    active: { state: true },
    picked: { state: true },
    hover: { state: true },
    pinned: { state: true },
    sources: { state: true },
    dialogView: { state: true },
    query: { state: true },
    searchOpen: { state: true },
    searchActive: { state: true },
    spotlight: { state: true },
  };

  public map: MemberMap | null = null;
  public variant: MemberMapVariant = "card";
  public now: number | undefined = undefined;
  public ownLocation: unknown = nothing;

  // The full-screen panel is only in the DOM while it is open: no second copy of the coastline
  // behind a closed dialog.
  private opened = false;

  // The city lit by hovering or focusing its row. Transient: it follows the pointer.
  private active: string | undefined = undefined;

  // The city a click or tap picked. Kept apart from `active` because a tap on a phone sends an
  // emulated mouseenter and a focus before its click: were the click a toggle of `active`, it would
  // see the city already lit by those and switch it straight back off.
  private picked: string | undefined = undefined;

  // The marker under the pointer or keyboard focus, per box: its tooltip shows.
  private hover: { kind: StageKind; key: string } | undefined = undefined;

  // A cluster that cannot zoom apart any further (same coordinates, or at maximum zoom): its
  // places are listed in a tooltip that stays until the view moves. Keyed by its biggest place.
  private pinned: string | undefined = undefined;

  // The admin's "How we placed people" switch.
  private sources = false;

  // Full screen's zoom and pan. Null is the whole map, fitted to whatever size the box is.
  private dialogView: Viewport | null = null;

  // Which places' rows show every member. Mutated in place, so toggling calls requestUpdate().
  private expandedPlaces = new Set<string>();

  // The search box. One query for the card and full screen, so a search started on the card is
  // still there when picking a result opens full screen on it.
  private query = "";
  // Which box's results list is showing, if any. Closed by Escape, blur or a pick; the query stays.
  // Per box, so typing full screen does not also open the card's list under the dialog.
  private searchOpen: StageKind | undefined = undefined;
  // The option the arrow keys are on, or -1 for none (Enter then takes the first).
  private searchActive = -1;
  // The person the last pick found, if it was a person.
  private spotlight: PlaceFocus["spotlight"] = undefined;
  // Whether the current pick came from the search. Clearing the search lets go of that pick and
  // shows the whole map again, but must not undo a city somebody picked from the list instead.
  private searchPicked = false;
  // The member the last pick found who is not on the map. There is no city to fly to, so the box
  // says why under it instead, until the query changes.
  private searchAbsent: MemberMapAbsentMember | undefined = undefined;
  // The card and full screen each render a box; their option ids must not collide, nor collide
  // with another map element on the same page.
  private readonly searchId = nextSearchId();

  private sizes: Partial<Record<StageKind, Size>> = {};
  private observer: ResizeObserver | undefined;
  private observed = new WeakSet<Element>();
  private animation = 0;
  private gesture: Gesture | undefined;
  private suppressClick = false;
  // Map-unit bounds to fly to once the full-screen box has a size: a cluster tapped on the card.
  private pendingBounds: { x0: number; y0: number; x1: number; y1: number } | undefined;
  // A place to fly to once the full-screen box has a size: a search result picked on the card.
  private pendingPlace: string | undefined;
  // After a cluster opens, keyboard focus moves to its biggest place's marker.
  private focusAfterZoom: string | undefined;

  private readonly focusPlace = (key: string | undefined): void => {
    if (this.active !== key) {
      this.active = key;
    }
  };

  // Picking the picked city again lets it go, and drops the hover highlight with it: on a phone
  // nothing else would, since no mouseleave follows a tap.
  private readonly pickPlace = (key: string): void => {
    this.pinned = undefined;
    // A pick by hand supersedes whatever the search found.
    this.searchPicked = false;
    this.spotlight = undefined;
    if (this.picked === key) {
      this.picked = undefined;
      this.active = undefined;
    } else {
      this.picked = key;
    }
  };

  // A row picked full screen also brings its city into view, close enough to stand on its own.
  private readonly pickFromList = (key: string): void => {
    const wasPicked = this.picked === key;
    this.pickPlace(key);
    if (this.opened && !wasPicked) {
      this.flyToPlace(key);
    }
  };

  /** Centres full screen on one place, zoomed in at least far enough for it to stand on its own. */
  private flyToPlace(key: string): void {
    const size = this.stageSize("dialog");
    const at = this.map ? projected(this.map).get(key) : undefined;
    if (!size || !at) {
      return;
    }
    const current = this.dialogView ?? fitViewport(size);
    const base = fitViewport(size);
    const k = Math.max(current.k, base.k * 4);
    this.animateTo(
      clampViewport({ k, x: size.width / 2 - at.x * k, y: size.height / 2 - at.y * k }, size),
    );
  }

  // --- Search ---

  /**
   * Lights the result's city and shows its tooltip, the same as picking its row would. The card
   * does not zoom, so a pick there opens full screen on the city, as a cluster tapped there does.
   */
  private chooseResult(result: MemberMapSearchResult, kind: StageKind): void {
    if (result.kind === "absent") {
      // Nowhere to go: keep the map as it is and say why under the box.
      this.query = result.member.name;
      this.searchOpen = undefined;
      this.searchActive = -1;
      this.searchAbsent = result.member;
      return;
    }
    this.searchAbsent = undefined;
    const key = result.place.key;
    this.query = result.kind === "person" ? result.member.name : result.place.label;
    this.searchOpen = undefined;
    this.searchActive = -1;
    this.pinned = undefined;
    this.active = undefined;
    this.picked = key;
    this.searchPicked = true;
    this.spotlight =
      result.kind === "person" && result.member.member_id
        ? { place: key, member: result.member.member_id }
        : undefined;
    if (kind === "dialog" && this.opened) {
      this.flyToPlace(key);
    } else {
      this.open(undefined, key);
    }
  }

  /** Empties the box and, if the search had picked a city, lets it go and shows the whole map. */
  private clearSearch(): void {
    this.query = "";
    this.searchAbsent = undefined;
    this.searchOpen = undefined;
    this.searchActive = -1;
    if (!this.searchPicked) {
      return;
    }
    this.searchPicked = false;
    this.spotlight = undefined;
    this.picked = undefined;
    this.active = undefined;
    if (this.opened) {
      // The zoom control's own "Show the whole map".
      this.resetZoom();
    }
  }

  private onSearchInput(event: Event, kind: StageKind): void {
    const value = (event.currentTarget as HTMLInputElement).value;
    this.query = value;
    this.searchAbsent = undefined;
    this.searchActive = -1;
    this.searchOpen = kind;
    if (!foldForSearch(value)) {
      // Deleting the last character is clearing the search, the same as the clear button.
      this.clearSearch();
    }
  }

  // The combobox keys: arrows move through the options (wrapping), Enter picks the one the arrows
  // are on or else the best match, Escape closes the list and then, pressed again, clears the box.
  // An Escape the box uses is stopped here, or full screen's dialog would close on the same press.
  private onSearchKey(event: KeyboardEvent, kind: StageKind, results: MemberMapSearchResult[]) {
    const count = results.length;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (count === 0) {
          return;
        }
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        this.searchActive =
          this.searchOpen !== kind || this.searchActive < 0
            ? step > 0
              ? 0
              : count - 1
            : (this.searchActive + step + count) % count;
        this.searchOpen = kind;
        return;
      }
      case "Enter": {
        if (this.searchOpen !== kind || count === 0) {
          return;
        }
        event.preventDefault();
        this.chooseResult(results[this.searchActive >= 0 ? this.searchActive : 0]!, kind);
        return;
      }
      case "Escape": {
        if (this.searchOpen === kind && foldForSearch(this.query)) {
          this.searchOpen = undefined;
          this.searchActive = -1;
        } else if (this.query) {
          this.clearSearch();
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      }
    }
  }

  private renderSearch(map: MemberMap, kind: StageKind) {
    const base = `${this.searchId}-${kind}`;
    const listId = `${base}-list`;
    const hasQuery = foldForSearch(this.query) !== "";
    const search = hasQuery ? searchMemberMap(map, this.query) : { results: [], more: 0 };
    const expanded = this.searchOpen === kind && hasQuery;
    const activeIndex =
      expanded && this.searchActive < search.results.length ? this.searchActive : -1;
    // A summary map has no names in it, so offering to find a person would be a promise it cannot
    // keep; for that viewer the box finds cities.
    const names = map.places.some((place) => (place.members?.length ?? 0) > 0);
    const total = search.results.length + search.more;
    return html`
      <div class="member-map__search" data-testid=${`member-map-search-${kind}`}>
        <div class="member-map__search-field">
          <svg class="member-map__search-icon" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5"></circle>
            <path d="M10.5 10.5 14 14"></path>
          </svg>
          <input
            type="text"
            class="member-map__search-input"
            data-testid="member-map-search-input"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded=${expanded ? "true" : "false"}
            aria-controls=${listId}
            aria-activedescendant=${activeIndex >= 0 ? `${base}-opt-${activeIndex}` : nothing}
            aria-label=${t("dashboard.memberMap.searchLabel")}
            placeholder=${t(
              names
                ? "dashboard.memberMap.searchPlaceholder"
                : "dashboard.memberMap.searchPlaceholderPlaces",
            )}
            autocomplete="off"
            spellcheck="false"
            .value=${this.query}
            @input=${(event: Event) => this.onSearchInput(event, kind)}
            @keydown=${(event: KeyboardEvent) => this.onSearchKey(event, kind, search.results)}
            @focus=${() => (this.searchOpen = kind)}
            @blur=${() => {
              if (this.searchOpen === kind) {
                this.searchOpen = undefined;
                this.searchActive = -1;
              }
            }}
          />
          ${this.query
            ? html`<button
                type="button"
                class="member-map__search-clear"
                data-testid="member-map-search-clear"
                aria-label=${t("dashboard.memberMap.searchClear")}
                title=${t("dashboard.memberMap.searchClear")}
                @click=${() => this.clearSearch()}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8"></path>
                </svg>
              </button>`
            : nothing}
        </div>
        <div class="member-map__search-pop" ?hidden=${!expanded}>
          <ul
            id=${listId}
            class="member-map__search-results"
            role="listbox"
            aria-label=${t("dashboard.memberMap.searchResults")}
          >
            ${repeat(
              search.results,
              (result) => searchResultKey(result),
              (result, index) => {
                if (result.kind === "absent") {
                  return this.renderAbsentOption(result.member, kind, index, base, activeIndex);
                }
                const person = result.kind === "person";
                const name = person ? result.member.name : result.place.label;
                const where = person
                  ? placeWhere(result.place)
                  : result.place.approximate
                    ? t("dashboard.memberMap.searchPlaceMembers", {
                        count: String(result.place.count),
                      })
                    : [
                        result.place.country,
                        t("dashboard.memberMap.searchPlaceMembers", {
                          count: String(result.place.count),
                        }),
                      ]
                        .filter(Boolean)
                        .join(" · ");
                return html`<li
                  id=${`${base}-opt-${index}`}
                  class=${`member-map__search-option${index === activeIndex ? " member-map__search-option--active" : ""}`}
                  role="option"
                  aria-selected=${index === activeIndex ? "true" : "false"}
                  aria-label=${person
                    ? t("dashboard.memberMap.searchPersonAria", {
                        name,
                        place: placeWhere(result.place),
                      })
                    : t("dashboard.memberMap.searchPlaceAria", {
                        place: placeWhere(result.place),
                        count: String(result.place.count),
                      })}
                  data-place=${result.place.key}
                  data-kind=${result.kind}
                  @mousedown=${(event: Event) => {
                    // Keep focus in the box, so its blur does not close the list under the click.
                    event.preventDefault();
                  }}
                  @mouseenter=${() => (this.searchActive = index)}
                  @click=${() => this.chooseResult(result, kind)}
                >
                  ${person
                    ? renderAvatar(result.member)
                    : html`<span
                        class=${`member-map__swatch${result.place.approximate ? " member-map__swatch--country" : ""}`}
                      ></span>`}
                  <span class="member-map__search-text">
                    <span class="member-map__search-name">${name}</span>
                    <span class="member-map__search-where">${where}</span>
                  </span>
                </li>`;
              },
            )}
          </ul>
          ${search.results.length === 0
            ? html`<p class="member-map__search-note" data-testid="member-map-search-none">
                ${t("dashboard.memberMap.searchNone", { query: this.query.trim() })}
              </p>`
            : nothing}
          ${search.more > 0
            ? html`<p class="member-map__search-note">
                ${t("dashboard.more", { count: String(search.more) })}
              </p>`
            : nothing}
          ${map.unplaced > 0 && !map.notOnMap
            ? html`<p
                class="member-map__search-note member-map__search-note--unplaced"
                data-testid="member-map-search-unplaced"
              >
                ${t("dashboard.memberMap.searchUnplaced", { count: String(map.unplaced) })}
              </p>`
            : nothing}
        </div>
        ${this.searchAbsent && !expanded
          ? html`<p
              class="member-map__search-absent"
              data-testid="member-map-search-absent"
              role="status"
            >
              <span class="member-map__search-name">${this.searchAbsent.name}</span>
              <span class="member-map__search-where">${absenceText(this.searchAbsent.reason)}</span>
            </p>`
          : nothing}
        <span class="sr-only" role="status" aria-live="polite"
          >${expanded
            ? total > 0
              ? t("dashboard.memberMap.searchCount", { count: String(total) })
              : t("dashboard.memberMap.searchNone", { query: this.query.trim() })
            : ""}</span
        >
      </div>
    `;
  }

  // A member who is not on the map: their name and why, and no swatch, since there is no city.
  private renderAbsentOption(
    member: MemberMapAbsentMember,
    kind: StageKind,
    index: number,
    base: string,
    activeIndex: number,
  ) {
    const why = absenceText(member.reason);
    return html`<li
      id=${`${base}-opt-${index}`}
      class=${`member-map__search-option member-map__search-option--absent${index === activeIndex ? " member-map__search-option--active" : ""}`}
      role="option"
      aria-selected=${index === activeIndex ? "true" : "false"}
      aria-label=${t("dashboard.memberMap.searchAbsentAria", { name: member.name, reason: why })}
      data-kind="absent"
      data-reason=${member.reason}
      @mousedown=${(event: Event) => event.preventDefault()}
      @mouseenter=${() => (this.searchActive = index)}
      @click=${() => this.chooseResult({ kind: "absent", member, index }, kind)}
    >
      <span class="member-map__search-text">
        <span class="member-map__search-name">${member.name}</span>
        <span class="member-map__search-where">${why}</span>
      </span>
    </li>`;
  }

  private toggleExpanded(key: string): void {
    if (this.expandedPlaces.has(key)) {
      this.expandedPlaces.delete(key);
    } else {
      this.expandedPlaces.add(key);
    }
    this.requestUpdate();
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!worldOutlinePath) {
      void loadWorldOutline().then(() => this.requestUpdate());
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.observer?.disconnect();
    this.observer = undefined;
    this.observed = new WeakSet();
    this.stopAnimation();
  }

  protected override updated(): void {
    if (typeof ResizeObserver === "undefined") {
      this.flushPendingZoom();
      return;
    }
    this.observer ??= new ResizeObserver((entries) => this.onResize(entries));
    for (const stage of this.querySelectorAll(".member-map__stage")) {
      if (!this.observed.has(stage)) {
        this.observed.add(stage);
        this.observer.observe(stage);
      }
    }
    if (this.focusAfterZoom && this.animation === 0) {
      const key = this.focusAfterZoom;
      this.focusAfterZoom = undefined;
      this.querySelector<HTMLElement>(
        `.member-map__stage--dialog .member-map__marker[data-place="${CSS.escape(key)}"]`,
      )?.focus();
    }
  }

  private onResize(entries: ResizeObserverEntry[]): void {
    let changed = false;
    for (const entry of entries) {
      const kind = (entry.target as HTMLElement).dataset.stage as StageKind | undefined;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      // A box in a hidden tab measures 0: keep the last real size rather than collapse to nothing.
      if (!kind || width < 1 || height < 1) {
        continue;
      }
      const previous = this.sizes[kind];
      if (previous?.width === width && previous.height === height) {
        continue;
      }
      const size = { width, height };
      if (kind === "dialog" && this.dialogView && previous) {
        // Keep the same zoom relative to the fit, and the same map point at the centre.
        const ratio = this.dialogView.k / fitViewport(previous).k;
        const cx = (previous.width / 2 - this.dialogView.x) / this.dialogView.k;
        const cy = (previous.height / 2 - this.dialogView.y) / this.dialogView.k;
        const k = fitViewport(size).k * ratio;
        this.dialogView = clampViewport({ k, x: width / 2 - cx * k, y: height / 2 - cy * k }, size);
      }
      this.sizes[kind] = size;
      changed = true;
    }
    if (changed) {
      this.requestUpdate();
    }
    this.flushPendingZoom();
  }

  private stageSize(kind: StageKind): Size | undefined {
    return (
      this.sizes[kind] ?? (typeof ResizeObserver === "undefined" ? FALLBACK_SIZE[kind] : undefined)
    );
  }

  private flushPendingZoom(): void {
    const bounds = this.pendingBounds;
    const place = this.pendingPlace;
    const size = this.stageSize("dialog");
    if ((!bounds && !place) || !size || !this.opened) {
      return;
    }
    this.pendingBounds = undefined;
    this.pendingPlace = undefined;
    if (place) {
      this.flyToPlace(place);
    } else if (bounds) {
      this.animateTo(this.boundsView(bounds, size));
    }
  }

  private boundsView(bounds: { x0: number; y0: number; x1: number; y1: number }, size: Size) {
    return viewportForBounds(bounds, size, Math.max(56, Math.min(size.width, size.height) * 0.18));
  }

  private stopAnimation(): void {
    if (this.animation !== 0 && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.animation);
    }
    this.animation = 0;
  }

  /** Flies full screen to `target`, or jumps there for anyone who asked for less motion. */
  private animateTo(target: Viewport): void {
    const size = this.stageSize("dialog");
    if (!size) {
      return;
    }
    this.stopAnimation();
    const from = this.dialogView ?? fitViewport(size);
    if (prefersReducedMotion() || typeof requestAnimationFrame !== "function") {
      this.dialogView = target;
      return;
    }
    const start = performance.now();
    const step = (time: number) => {
      const progress = Math.min(1, (time - start) / ZOOM_DURATION_MS);
      this.dialogView =
        progress < 1 ? lerpViewport(from, target, easeInOutCubic(progress), size) : target;
      this.animation = progress < 1 ? requestAnimationFrame(step) : 0;
      if (progress >= 1) {
        // One more render after the last frame, so focusAfterZoom runs with animation === 0.
        this.requestUpdate();
      }
    };
    this.animation = requestAnimationFrame(step);
  }

  private zoomBy(factor: number): void {
    const size = this.stageSize("dialog");
    if (!size) {
      return;
    }
    this.pinned = undefined;
    const view = this.dialogView ?? fitViewport(size);
    this.animateTo(zoomAt(view, factor, size.width / 2, size.height / 2, size));
  }

  private resetZoom(): void {
    const size = this.stageSize("dialog");
    this.pinned = undefined;
    if (size) {
      this.animateTo(fitViewport(size));
    }
  }

  private clusterBounds(marker: Marker) {
    const positions = projected(this.map!);
    const points = marker.keys.map((key) => positions.get(key)!);
    return {
      x0: Math.min(...points.map((point) => point.x)),
      y0: Math.min(...points.map((point) => point.y)),
      x1: Math.max(...points.map((point) => point.x)),
      y1: Math.max(...points.map((point) => point.y)),
    };
  }

  private onMarkerClick(kind: StageKind, marker: Marker): void {
    if (marker.places.length === 1) {
      this.pickPlace(marker.key);
      return;
    }
    const bounds = this.clusterBounds(marker);
    if (kind === "card") {
      // The card does not zoom; full screen opens on the cluster instead.
      this.open(bounds);
      return;
    }
    const size = this.stageSize("dialog");
    if (!size) {
      return;
    }
    const current = this.dialogView ?? fitViewport(size);
    const target = this.boundsView(bounds, size);
    // No more room to separate them (same coordinates, or zoomed all the way in): list them.
    if (target.k <= current.k * 1.15) {
      this.pinned = this.pinned === marker.lead ? undefined : marker.lead;
      return;
    }
    this.pinned = undefined;
    this.focusAfterZoom = marker.lead;
    this.animateTo(target);
  }

  // --- Pointer: drag to pan, pinch or wheel to zoom (full screen only) ---

  private localPoint(event: PointerEvent | WheelEvent | MouseEvent): PointerState {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    const size = this.stageSize("dialog");
    if (!size) {
      return;
    }
    this.stopAnimation();
    const pointers = new Map(this.gesture?.pointers ?? []);
    pointers.set(event.pointerId, this.localPoint(event));
    this.gesture = {
      view: this.dialogView ?? fitViewport(size),
      pointers,
      moved: this.gesture?.moved ?? false,
    };
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    const size = this.stageSize("dialog");
    if (!gesture || !size || !gesture.pointers.has(event.pointerId)) {
      return;
    }
    const current = new Map(gesture.pointers);
    current.set(event.pointerId, this.localPoint(event));
    const before = centroid(gesture.pointers.values());
    const after = centroid(current.values());
    if (
      !gesture.moved &&
      Math.hypot(after.x - before.x, after.y - before.y) < 4 &&
      current.size < 2
    ) {
      return;
    }
    if (!gesture.moved) {
      gesture.moved = true;
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    }
    const factor = before.spread > 0 && after.spread > 0 ? after.spread / before.spread : 1;
    const zoomed = zoomAt(gesture.view, factor, before.x, before.y, size);
    this.pinned = undefined;
    this.dialogView = clampViewport(
      { k: zoomed.k, x: zoomed.x + after.x - before.x, y: zoomed.y + after.y - before.y },
      size,
    );
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || !gesture.pointers.has(event.pointerId)) {
      return;
    }
    if (gesture.moved) {
      this.suppressClick = true;
    }
    gesture.pointers.delete(event.pointerId);
    const size = this.stageSize("dialog");
    if (gesture.pointers.size === 0 || !size) {
      this.gesture = undefined;
      return;
    }
    // One finger lifted from a pinch: carry on panning from where the view is now.
    this.gesture = {
      view: this.dialogView ?? fitViewport(size),
      pointers: gesture.pointers,
      moved: true,
    };
  };

  // A drag that ends over a marker must not also click it.
  private readonly onClickCapture = {
    handleEvent: (event: Event) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        event.stopPropagation();
        event.preventDefault();
      }
    },
    capture: true,
  };

  private readonly onWheel = {
    handleEvent: (event: WheelEvent) => {
      const size = this.stageSize("dialog");
      if (!size) {
        return;
      }
      event.preventDefault();
      this.stopAnimation();
      this.pinned = undefined;
      const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
      const factor = Math.exp(-event.deltaY * lines * 0.0018);
      const point = this.localPoint(event);
      this.dialogView = zoomAt(
        this.dialogView ?? fitViewport(size),
        factor,
        point.x,
        point.y,
        size,
      );
    },
    passive: false,
  };

  private readonly onStageKey = (event: KeyboardEvent): void => {
    const size = this.stageSize("dialog");
    if (!size || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const view = this.dialogView ?? fitViewport(size);
    const pan = (dx: number, dy: number) =>
      clampViewport({ k: view.k, x: view.x + dx, y: view.y + dy }, size);
    const actions: Record<string, () => void> = {
      "+": () => this.zoomBy(ZOOM_STEP),
      "=": () => this.zoomBy(ZOOM_STEP),
      "-": () => this.zoomBy(1 / ZOOM_STEP),
      "0": () => this.resetZoom(),
      ArrowLeft: () => (this.dialogView = pan(80, 0)),
      ArrowRight: () => (this.dialogView = pan(-80, 0)),
      ArrowUp: () => (this.dialogView = pan(0, 80)),
      ArrowDown: () => (this.dialogView = pan(0, -80)),
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  };

  private dialog(): HTMLDialogElement | null {
    return this.querySelector("dialog");
  }

  private open(bounds?: { x0: number; y0: number; x1: number; y1: number }, place?: string): void {
    this.opened = true;
    this.dialogView = null;
    this.pinned = undefined;
    this.pendingBounds = bounds;
    this.pendingPlace = place;
    // The panel renders on the next update, so the dialog is only shown once its contents exist.
    void this.updateComplete.then(() => {
      const dialog = this.dialog();
      if (!dialog || dialog.open) {
        return;
      }
      // showModal is what puts it in the top layer and traps focus. The fallback keeps the view
      // reachable where it is not implemented rather than making the card dead.
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.open = true;
      }
      if (place) {
        // Opened by a search pick on the card: the search carries on in full screen's own box, so
        // the next Escape clears it there rather than landing on the close button.
        dialog.querySelector<HTMLInputElement>(".member-map__search-input")?.focus();
        // Focusing opens the list, but the pick is made: show the city, not the matches again.
        this.searchOpen = undefined;
      }
      this.flushPendingZoom();
    });
  }

  private close(): void {
    const dialog = this.dialog();
    if (dialog?.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.open = false;
      }
    }
    this.closed();
  }

  private closed(): void {
    this.opened = false;
    this.stopAnimation();
    this.gesture = undefined;
    this.pendingBounds = undefined;
    this.pendingPlace = undefined;
    this.dialogView = null;
    this.pinned = undefined;
    if (this.searchOpen === "dialog") {
      this.searchOpen = undefined;
    }
    if (this.hover?.kind === "dialog") {
      this.hover = undefined;
    }
    // A new dialog box will be measured afresh when it opens.
    delete this.sizes.dialog;
  }

  private renderStage(map: MemberMap, kind: StageKind, focus: PlaceFocus) {
    const size = this.stageSize(kind);
    const dialog = kind === "dialog";
    const base = size ? fitViewport(size) : undefined;
    const view = size ? (dialog && this.dialogView ? this.dialogView : base!) : undefined;
    const scene = size && view ? buildScene(map, kind, size, view) : undefined;
    const lit = focus.active ?? focus.picked;
    const hovered = this.hover?.kind === kind ? this.hover.key : undefined;
    const isLit = (marker: Marker) =>
      marker.key === hovered || (lit !== undefined && marker.keys.includes(lit));
    const anyLit = scene?.markers.some((marker) => lit !== undefined && marker.keys.includes(lit));
    const hoveredMarker = scene?.markers.find((marker) => marker.key === hovered);
    const tooltipFor =
      hoveredMarker ??
      (dialog && this.pinned
        ? scene?.markers.find((marker) => marker.keys.includes(this.pinned!))
        : undefined) ??
      (lit ? scene?.markers.find((marker) => marker.keys.includes(lit)) : undefined);
    // Lit from the list (not pointed at, not a pinned cluster): describe the one place asked about.
    const tooltipOnly =
      !hoveredMarker &&
      !(dialog && this.pinned) &&
      lit &&
      tooltipFor &&
      tooltipFor.places.length > 1
        ? tooltipFor.places.find((place) => place.key === lit)
        : undefined;
    const zoom = base && view ? view.k / base.k : 1;
    const aria = t("dashboard.memberMap.plotAria", {
      cities: String(map.places.length),
      count: String(map.counts.placed),
    });
    return html`
      <div class=${`member-map__figure member-map__figure--${kind}`}>
        <div
          class=${[
            "member-map__stage",
            `member-map__stage--${kind}`,
            anyLit ? "member-map__stage--focus" : "",
            zoom > 1.01 ? "member-map__stage--zoomed" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          data-stage=${kind}
          data-testid=${`member-map-stage-${kind}`}
          @pointerdown=${dialog ? this.onPointerDown : nothing}
          @pointermove=${dialog ? this.onPointerMove : nothing}
          @pointerup=${dialog ? this.onPointerEnd : nothing}
          @pointercancel=${dialog ? this.onPointerEnd : nothing}
          @wheel=${dialog ? this.onWheel : nothing}
          @click=${dialog ? this.onClickCapture : nothing}
          @keydown=${dialog ? this.onStageKey : nothing}
        >
          ${scene && view
            ? svg`
              <svg
                class="member-map__plot"
                width=${scene.size.width}
                height=${scene.size.height}
                viewBox="0 0 ${scene.size.width} ${scene.size.height}"
                aria-hidden="true"
                focusable="false"
              >
                <g transform="translate(${view.x.toFixed(2)} ${view.y.toFixed(2)}) scale(${view.k.toFixed(5)})">
                  <path class="member-map__grid" d=${GRATICULE} vector-effect="non-scaling-stroke"></path>
                  ${
                    worldOutlinePath
                      ? svg`<path class="member-map__land" d=${worldOutlinePath} vector-effect="non-scaling-stroke"></path>`
                      : nothing
                  }
                </g>
              </svg>`
            : nothing}
          ${kind === "card"
            ? html`<button
                type="button"
                class="member-map__plot-button"
                data-testid="member-map-plot-button"
                title=${t("dashboard.memberMap.expand")}
                aria-label=${t("dashboard.memberMap.expandAria")}
                @click=${() => this.open()}
              ></button>`
            : nothing}
          <div class="member-map__markers" role="group" aria-label=${aria}>
            ${scene
              ? repeat(
                  scene.markers,
                  (marker) => marker.key,
                  (marker) => {
                    const cluster = marker.places.length > 1;
                    const approximate = !cluster && marker.places[0]!.approximate;
                    const countInside = marker.r >= 8.5 && marker.count > 1;
                    return html`<button
                      type="button"
                      class=${[
                        "member-map__marker",
                        cluster ? "member-map__marker--cluster" : "",
                        approximate ? "member-map__marker--approximate" : "",
                        isLit(marker) ? "member-map__marker--active" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style="--x: ${marker.x.toFixed(1)}px; --y: ${marker.y.toFixed(
                        1,
                      )}px; --r: ${marker.r.toFixed(1)}px; --fs: ${Math.min(
                        12,
                        Math.max(9, marker.r * 0.8),
                      ).toFixed(1)}px"
                      data-place=${cluster ? nothing : marker.key}
                      data-cluster=${cluster ? marker.keys.join(" ") : nothing}
                      data-count=${marker.count}
                      aria-label=${markerAria(marker)}
                      aria-pressed=${cluster
                        ? nothing
                        : focus.picked === marker.key
                          ? "true"
                          : "false"}
                      @mouseenter=${() => (this.hover = { kind, key: marker.key })}
                      @mouseleave=${() => {
                        if (this.hover?.key === marker.key) {
                          this.hover = undefined;
                        }
                      }}
                      @focus=${() => (this.hover = { kind, key: marker.key })}
                      @blur=${() => {
                        if (this.hover?.key === marker.key) {
                          this.hover = undefined;
                        }
                      }}
                      @click=${() => this.onMarkerClick(kind, marker)}
                    >
                      <span class="member-map__dot">${countInside ? marker.count : nothing}</span>
                    </button>`;
                  },
                )
              : nothing}
          </div>
          <div class="member-map__labels" aria-hidden="true">
            ${scene
              ? scene.markers.map((marker) => {
                  const label = scene.labels.get(marker.key);
                  if (!label) {
                    return nothing;
                  }
                  const shift =
                    label.anchor === "start" ? "0" : label.anchor === "middle" ? "-50%" : "-100%";
                  return html`<span
                    class=${`member-map__label${isLit(marker) ? " member-map__label--active" : ""}`}
                    data-label=${marker.key}
                    style="left: ${label.x.toFixed(1)}px; top: ${label.y.toFixed(
                      1,
                    )}px; font-size: ${scene.fontSize}px; transform: translate(${shift}, -50%)"
                    >${markerLabel(marker)}</span
                  >`;
                })
              : nothing}
          </div>
          ${dialog && base && view
            ? html`<div
                class="member-map__controls"
                role="group"
                aria-label=${t("dashboard.memberMap.zoomControls")}
              >
                <button
                  type="button"
                  class="member-map__control"
                  data-testid="member-map-zoom-in"
                  aria-label=${t("dashboard.memberMap.zoomIn")}
                  title=${t("dashboard.memberMap.zoomIn")}
                  ?disabled=${zoom >= MAX_ZOOM - 0.01}
                  @click=${() => this.zoomBy(ZOOM_STEP)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"></path></svg>
                </button>
                <button
                  type="button"
                  class="member-map__control"
                  data-testid="member-map-zoom-out"
                  aria-label=${t("dashboard.memberMap.zoomOut")}
                  title=${t("dashboard.memberMap.zoomOut")}
                  ?disabled=${zoom <= 1.01}
                  @click=${() => this.zoomBy(1 / ZOOM_STEP)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10"></path></svg>
                </button>
                <button
                  type="button"
                  class="member-map__control"
                  data-testid="member-map-zoom-reset"
                  aria-label=${t("dashboard.memberMap.zoomReset")}
                  title=${t("dashboard.memberMap.zoomReset")}
                  ?disabled=${zoom <= 1.01}
                  @click=${() => this.resetZoom()}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M2.5 6V2.5H6M13.5 10v3.5H10M10 2.5h3.5V6M6 13.5H2.5V10"></path>
                  </svg>
                </button>
              </div>`
            : nothing}
        </div>
        ${scene && tooltipFor ? renderTooltip(tooltipFor, scene, focus, tooltipOnly) : nothing}
      </div>
    `;
  }

  private renderDialog(map: MemberMap, headline: unknown, focus: PlaceFocus) {
    return html`
      <dialog
        class="member-map__dialog"
        data-testid="member-map-dialog"
        aria-label=${t("dashboard.memberMap.title")}
        @close=${() => {
          // Fires for Escape too, which never routes through close().
          this.closed();
        }}
        @click=${(event: Event) => {
          // Clicking the backdrop closes. The panel below is a child, so a click inside it never
          // reaches the dialog element itself.
          if (event.target === event.currentTarget) {
            this.close();
          }
        }}
      >
        ${this.opened
          ? html`<div class="member-map__dialog-panel">
              <div class="member-map__head">
                <div class="member-map__heading">
                  <h2 class="member-map__title">${t("dashboard.memberMap.title")}</h2>
                  <p class="member-map__sub">${headline}</p>
                </div>
                <button
                  type="button"
                  class="btn btn--sm"
                  data-testid="member-map-close"
                  @click=${() => this.close()}
                >
                  ${t("dashboard.memberMap.collapse")}
                </button>
              </div>
              ${this.renderSearch(map, "dialog")} ${this.renderStage(map, "dialog", focus)}
              ${renderList(map, {
                ...focus,
                expanded: true,
                expandedPlaces: this.expandedPlaces,
                onToggleExpand: (key) => this.toggleExpanded(key),
                onFocus: this.focusPlace,
                onPick: this.pickFromList,
              })}
              ${renderFoot(map, this.sources, () => (this.sources = !this.sources))}
            </div>`
          : nothing}
      </dialog>
    `;
  }

  protected override render() {
    const map = this.map;
    if (!map || map.places.length === 0) {
      return nothing;
    }
    const now = this.now ?? Date.now();
    const focus: PlaceFocus = {
      // Pointing at a city's marker lights its row too, the same as the other way round.
      active: this.active ?? this.hover?.key,
      picked: this.picked,
      spotlight: this.spotlight,
      sources: this.sources,
      now,
    };
    const updated = map.loadedAt === undefined ? undefined : updatedAgo(map.loadedAt, now);
    const headline = html`${t("dashboard.memberMap.headline", {
      count: String(map.counts.placed),
      cities: String(map.places.length),
    })}${updated
      ? html`<span class="member-map__updated" data-testid="member-map-updated">
          · ${updated}</span
        >`
      : nothing}`;
    const toggle = html`<button
      type="button"
      class="btn btn--sm member-map__expand"
      data-testid="member-map-toggle"
      @click=${() => this.open()}
    >
      ${t("dashboard.memberMap.expand")}
    </button>`;
    const body = html`
      ${this.renderSearch(map, "card")}
      <div class="member-map__body">
        ${this.renderStage(map, "card", focus)}
        ${renderList(map, {
          ...focus,
          expanded: false,
          expandedPlaces: this.expandedPlaces,
          onToggleExpand: (key) => this.toggleExpanded(key),
          onFocus: this.focusPlace,
          onPick: this.pickPlace,
        })}
      </div>
      ${renderFoot(map, this.sources, () => (this.sources = !this.sources))}
    `;
    if (this.variant === "section") {
      return html`
        <section
          class="lab-sharing-map member-map member-map--section"
          data-testid="dashboard-member-map"
        >
          <div class="member-map__head">
            <div class="member-map__heading">
              <h2 class="member-map__title">${t("dashboard.memberMap.title")}</h2>
              <p class="member-map__sub">${headline}</p>
            </div>
            ${toggle}
          </div>
          <div class="member-map__panel">${body}</div>
          ${this.renderDialog(map, headline, focus)}
        </section>
      `;
    }
    return html`
      <article
        class="dashboard-summary member-map member-map--card"
        data-testid="dashboard-member-map"
      >
        <div class="member-map__head">
          <div class="member-map__heading">
            <h3 class="dashboard-summary__title">${t("dashboard.memberMap.title")}</h3>
            <p class="dashboard-summary__headline member-map__sub">${headline}</p>
            ${this.ownLocation === nothing || this.ownLocation === undefined
              ? nothing
              : html`<div class="member-map__own" data-testid="member-map-own-location">
                  ${this.ownLocation}
                </div>`}
          </div>
          ${toggle}
        </div>
        ${body} ${this.renderDialog(map, headline, focus)}
      </article>
    `;
  }
}

if (!customElements.get("adminbot-member-map")) {
  customElements.define("adminbot-member-map", AdminbotMemberMap);
}

/** The Collaborate section's own loading and empty panels, under the same header. */
function renderSectionState(kind: "loading" | "empty") {
  return html`
    <section
      class="lab-sharing-map member-map member-map--section"
      data-testid=${`member-map-${kind}`}
    >
      <div class="member-map__head">
        <div class="member-map__heading">
          <h2 class="member-map__title">${t("dashboard.memberMap.title")}</h2>
        </div>
      </div>
      <div class="member-map__panel member-map__panel--state" aria-busy=${kind === "loading"}>
        ${kind === "loading" ? html`<span class="member-map__spinner"></span>` : nothing}
        <p class="member-map__state">${t(`dashboard.memberMap.${kind}`)}</p>
      </div>
    </section>
  `;
}

/**
 * The map, or on the Dashboard nothing at all when there is nothing to draw: one card fewer beats
 * an empty one in a grid whose other cards are waiting on the member. On Collaborate the section
 * stays and says it is loading or that nobody is on the map yet, like the sections around it.
 */
export function renderMemberMap(map: MemberMap | null, options: MemberMapOptions = {}) {
  const variant = options.variant ?? "card";
  if (!map || map.places.length === 0) {
    if (variant !== "section") {
      return nothing;
    }
    if (map) {
      return renderSectionState("empty");
    }
    return options.loading ? renderSectionState("loading") : nothing;
  }
  return html`<adminbot-member-map
    .map=${map}
    .variant=${variant}
    .now=${options.now ?? Date.now()}
    .ownLocation=${options.ownLocation ?? nothing}
  ></adminbot-member-map>`;
}
