// Where the lab is, as a card on the Dashboard and on Collaborate.
//
// Plain SVG in a viewBox, so it scales with its container by itself: unlike the Leaflet page there
// is no tile layer to re-measure (no invalidateSize) after the card was in a hidden tab.
//
// An equirectangular plot: longitude maps linearly to x, latitude to y, over a real coastline.
//
// The coastline is Natural Earth 1:110m, pre-projected into this viewBox by
// scripts/generate-world-outline.mjs and committed as a 44kB path. Bundling it rather than pulling
// tiles keeps the card free of the network dependency the standalone Leaflet page carries, and
// pre-projecting keeps the browser from doing the arithmetic on every render. A graticule alone was
// the first attempt and it was unreadable: without continents nobody can tell which dot is which,
// and the card is meant to be glanceable.
//
// The list is not a fallback for the map; the two answer different questions. The plot shows spread
// — how far apart the lab is, and which timezones it straddles. The list shows rank — where most
// people actually are. Neither alone is the answer to "where is the lab".
import { html, LitElement, nothing, svg } from "lit";
import { t } from "../../../i18n/index.ts";
import type { MemberMap, MemberMapMember, MemberMapPlace } from "../data/member-map.ts";
import { layoutLabels, type LabelAnchor } from "./member-map-labels.ts";

// The projection data/world-outline.ts was generated for. Declared here rather than imported so the
// 43kB coastline stays out of the console's first load; member-map.test.ts asserts the two match,
// since a mismatch would slide every dot off the coastline it belongs on.
const VIEW_WIDTH = 360;
const VIEW_HEIGHT = 180;
// Latitude is clipped well short of the poles: nobody in the gazetteer lives past these, and the
// full ±90 range wastes a third of the height on empty ice.
const LAT_LIMIT = 72;

// The coastline arrives on its own: dots, grid and list draw at once and the land fills in under
// them when the chunk lands. A failed fetch is forgotten so the next element to connect retries.
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

const MIN_RADIUS = 3;
const MAX_RADIUS = 10;

// How many cities the list names. Collapsed it is a summary; expanded there is room for the roster
// of places, which is most of what the gazetteer holds.
const LIST_LIMIT = 6;
const LIST_LIMIT_EXPANDED = 24;

function projectX(lon: number): number {
  return ((lon + 180) / 360) * VIEW_WIDTH;
}

function projectY(lat: number): number {
  const clamped = Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, lat));
  return ((LAT_LIMIT - clamped) / (LAT_LIMIT * 2)) * VIEW_HEIGHT;
}

/**
 * Dot radius by headcount, on a square-root scale.
 *
 * Area is what the eye compares, so scaling the radius linearly would make a city of ten look a
 * hundred times the size of a city of one. Square root keeps area proportional to headcount.
 */
function radiusFor(count: number, busiest: number): number {
  if (busiest <= 1) {
    return MIN_RADIUS;
  }
  const share = Math.sqrt(Math.max(count, 1)) / Math.sqrt(busiest);
  return MIN_RADIUS + share * (MAX_RADIUS - MIN_RADIUS);
}

const DAY_MS = 86_400_000;

function startOfLocalDay(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** "from sign-in today", "… yesterday", "… 5 days ago", by the viewer's own calendar. */
function signInPhrase(at: string | undefined, now: number): string {
  const seen = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(seen)) {
    return t("dashboard.memberMap.fromSignIn");
  }
  const days = Math.max(0, Math.round((startOfLocalDay(now) - startOfLocalDay(seen)) / DAY_MS));
  if (days === 0) {
    return t("dashboard.memberMap.fromSignInToday");
  }
  return days === 1
    ? t("dashboard.memberMap.fromSignInYesterday")
    : t("dashboard.memberMap.fromSignInDaysAgo", { count: String(days) });
}

function sourcePhrase(member: MemberMapMember, now: number): string | undefined {
  switch (member.source) {
    case "login":
      return signInPhrase(member.last_login_at, now);
    case "roster":
      return member.precision === "timezone"
        ? t("dashboard.memberMap.fromProfileTimezone")
        : t("dashboard.memberMap.fromProfile");
    case "slack":
      return member.precision === "timezone"
        ? t("dashboard.memberMap.fromSlackTimezone")
        : t("dashboard.memberMap.fromSlack");
    default:
      return undefined;
  }
}

/**
 * Where a named member is and what says so -- "San Francisco · from sign-in today", "Toronto ·
 * from profile" -- so a pin from a sign-in an hour ago reads differently from a city typed into a
 * profile last year. Only ever a city and one moment: the service sends no coordinates or history.
 */
export function memberDetail(
  member: MemberMapMember,
  place: Pick<MemberMapPlace, "label">,
  now: number = Date.now(),
): string {
  const source = sourcePhrase(member, now);
  return source ? `${place.label} · ${source}` : place.label;
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

function placeTitle(place: MemberMapPlace, now: number): string {
  const where = placeWhere(place);
  // An admin gets names; everyone else gets the headcount, which is all the service sent.
  const names = place.members
    ?.map((member) => `${member.name} (${memberDetail(member, place, now)})`)
    .join(", ");
  return names
    ? `${where} — ${names}`
    : t("dashboard.memberMap.placeCount", { place: where, count: String(place.count) });
}

// Label sizes in viewBox units, set inline on each <text> so the collision pass and the drawing use
// the same number (a stylesheet rule would win over a presentation attribute and could drift). The
// full-screen plot is drawn about three times larger, so its labels can be smaller in viewBox units
// and still read at the same size -- and then far more of them fit.
const PLOT_LABELS = {
  card: { fontSize: 5, strokeWidth: 1.6, budget: 6 },
  dialog: { fontSize: 3, strokeWidth: 1, budget: 16 },
} as const;

// The spot a label shows at on hover when the collision pass found it no room: above its dot, kept
// inside the plot at either edge.
function hoverAnchor(x: number): LabelAnchor {
  return x > VIEW_WIDTH - 40 ? "end" : x < 40 ? "start" : "middle";
}

/**
 * Which place is picked out, and how to change it. The list and the pins share one highlight: point
 * at "Toronto" in the list and its pin lifts while the rest dim, point at a pin and its row lights.
 */
interface PlaceFocus {
  active?: string;
  /** The place a click or tap picked, which stays lit after the pointer or focus moves on. */
  picked?: string;
  onFocus?: (key: string | undefined) => void;
  onPick?: (key: string) => void;
  now: number;
}

function renderPlot(map: MemberMap, size: keyof typeof PLOT_LABELS, focus: PlaceFocus) {
  const busiest = Math.max(...map.places.map((place) => place.count), 1);
  const style = PLOT_LABELS[size];
  const points = map.places.map((place) => ({
    key: place.key,
    label: place.label,
    x: projectX(place.lon),
    y: projectY(place.lat),
    r: radiusFor(place.count, busiest),
  }));
  // `places` is sorted busiest first, so the biggest clusters get first pick of the room.
  const labels = layoutLabels(points, {
    fontSize: style.fontSize,
    strokeWidth: style.strokeWidth,
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
    budget: style.budget,
  });
  const labelStyle = `font-size: ${style.fontSize}px; stroke-width: ${style.strokeWidth}px`;
  const aria = t("dashboard.memberMap.plotAria", {
    cities: String(map.places.length),
    count: String(map.counts.placed),
  });
  const active = focus.active && map.places.some((place) => place.key === focus.active);
  return svg`
    <svg
      class=${`member-map__plot${active ? " member-map__plot--focus" : ""}`}
      viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}"
      role="img"
      aria-label=${aria}
    >
      <title>${aria}</title>
      <rect class="member-map__ocean" x="0" y="0" width=${VIEW_WIDTH} height=${VIEW_HEIGHT}></rect>
      ${[-120, -60, 0, 60, 120].map(
        (lon) => svg`
          <line
            class="member-map__grid"
            x1=${projectX(lon)}
            x2=${projectX(lon)}
            y1="0"
            y2=${VIEW_HEIGHT}
          ></line>
        `,
      )}
      ${[-40, 0, 40].map(
        (lat) => svg`
          <line
            class="member-map__grid"
            x1="0"
            x2=${VIEW_WIDTH}
            y1=${projectY(lat)}
            y2=${projectY(lat)}
          ></line>
        `,
      )}
      ${worldOutlinePath ? svg`<path class="member-map__land" d=${worldOutlinePath}></path>` : nothing}
      ${map.places.map((place, index) => {
        const { x, y, r } = points[index]!;
        const label = labels.get(place.key);
        const classes = [
          "member-map__place",
          place.approximate ? "member-map__place--approximate" : "",
          place.key === focus.active ? "member-map__place--active" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return svg`
          <g
            class=${classes}
            data-place=${place.key}
            @mouseenter=${() => focus.onFocus?.(place.key)}
            @mouseleave=${() => focus.onFocus?.(undefined)}
          >
            <circle class="member-map__halo" cx=${x} cy=${y} r=${r + 2.5}></circle>
            <circle class="member-map__dot" cx=${x} cy=${y} r=${r}>
              <title>${placeTitle(place, focus.now)}</title>
            </circle>
            ${
              label
                ? svg`<text
                    class="member-map__label"
                    style=${labelStyle}
                    x=${label.x}
                    y=${label.y}
                    text-anchor=${label.anchor}
                  >${place.label}</text>`
                : svg`<text
                    class="member-map__label member-map__label--hover"
                    style=${labelStyle}
                    x=${x}
                    y=${y - r - 3.5}
                    text-anchor=${hoverAnchor(x)}
                  >${place.label}</text>`
            }
          </g>
        `;
      })}
    </svg>
  `;
}

// How many people a pin's popover names before it says "+N more"; the list row has the rest.
const POPOVER_NAMES = 4;

function renderPersonLine(member: MemberMapMember, place: MemberMapPlace, now: number) {
  return html`<li>
    <span class="member-map__name">${member.name}</span>
    <span class="member-map__name-detail">${memberDetail(member, place, now)}</span>
  </li>`;
}

/**
 * The small card over the picked pin: the city, its headcount and, for an admin, who is there and
 * what put them there. It is decoration over the plot -- `pointer-events: none` -- so it never steals
 * the hover from the pin underneath it, and everything in it is also in the list and the dot title.
 */
function renderPopover(map: MemberMap, key: string, now: number) {
  const place = map.places.find((candidate) => candidate.key === key);
  if (!place) {
    return nothing;
  }
  const left = (projectX(place.lon) / VIEW_WIDTH) * 100;
  const top = (projectY(place.lat) / VIEW_HEIGHT) * 100;
  const members = place.members ?? [];
  const shown = members.slice(0, POPOVER_NAMES);
  const classes = [
    "member-map__popover",
    left > 70 ? "member-map__popover--start" : left < 30 ? "member-map__popover--end" : "",
    top < 40 ? "member-map__popover--below" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div
      class=${classes}
      style="left: ${left.toFixed(2)}%; top: ${top.toFixed(2)}%"
      data-testid="member-map-popover"
      aria-hidden="true"
    >
      <p class="member-map__popover-head">
        <span class="member-map__popover-title">${placeWhere(place)}</span>
        <span class="member-map__popover-count">${place.count}</span>
      </p>
      ${shown.length > 0
        ? html`<ul class="member-map__people">
            ${shown.map((member) => renderPersonLine(member, place, now))}
          </ul>`
        : nothing}
      ${members.length > shown.length
        ? html`<p class="member-map__popover-more">
            ${t("dashboard.more", { count: String(members.length - shown.length) })}
          </p>`
        : nothing}
    </div>
  `;
}

// How many faces a city row shows before folding the rest into "…".
const AVATAR_LIMIT = 3;

/**
 * The `AVATAR_LIMIT` most recently logged-in members of a place, most recent first.
 *
 * Display-only ordering: it never touches `place.members` itself, which stays alphabetical for
 * `placeTitle`'s tooltip and for whatever the backend originally sorted it by. A member with no
 * `last_login_at` sorts after everyone who has one, rather than colliding at some fake epoch.
 */
function recentActiveMembers(place: MemberMapPlace, limit = AVATAR_LIMIT) {
  const members = place.members ?? [];
  return members
    .toSorted((left, right) => {
      if (!left.last_login_at && !right.last_login_at) {
        return 0;
      }
      if (!left.last_login_at) {
        return 1;
      }
      if (!right.last_login_at) {
        return -1;
      }
      return right.last_login_at.localeCompare(left.last_login_at);
    })
    .slice(0, limit);
}

/**
 * Circular faces for a place's most recently active members, admin/full mode only (`members` is
 * absent in `summary` mode, so this renders nothing for anyone who cannot already see names).
 */
function renderAvatars(place: MemberMapPlace) {
  if (!place.members || place.members.length === 0) {
    return nothing;
  }
  const recent = recentActiveMembers(place);
  return html`
    <span class="member-map__avatars">
      ${recent.map((member) =>
        member.avatar_url
          ? html`<img
              class="member-map__avatar"
              src=${member.avatar_url}
              alt=""
              title=${member.name}
            />`
          : html`<span class="member-map__avatar member-map__avatar--fallback" title=${member.name}
              >${member.name.slice(0, 1).toUpperCase()}</span
            >`,
      )}
      ${place.members.length > AVATAR_LIMIT
        ? html`<span class="member-map__avatar-more">…</span>`
        : nothing}
    </span>
  `;
}

interface ListOptions extends PlaceFocus {
  expanded: boolean;
  expandedPlaces: ReadonlySet<string>;
  onToggleExpand: (key: string) => void;
}

/**
 * The cities with their counts. Each row is a button: hovering, focusing or tapping it lifts that
 * city's pin, so the list doubles as the map's index on a phone, where pins are too small to aim at.
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
        const isActive = options.active === place.key;
        return html`
          <li
            class=${`member-map__row${isActive ? " member-map__row--active" : ""}`}
            data-place=${place.key}
            @mouseenter=${() => options.onFocus?.(place.key)}
            @mouseleave=${() => options.onFocus?.(undefined)}
          >
            <button
              type="button"
              class="member-map__row-top"
              aria-pressed=${options.picked === place.key ? "true" : "false"}
              title=${placeTitle(place, options.now)}
              @focus=${() => options.onFocus?.(place.key)}
              @blur=${() => options.onFocus?.(undefined)}
              @click=${() => options.onPick?.(place.key)}
            >
              <span class="member-map__row-main">
                <span
                  class=${`member-map__swatch${place.approximate ? " member-map__swatch--country" : ""}`}
                ></span>
                <span class="member-map__row-label">${place.label}</span>
                ${renderAvatars(place)}
              </span>
              <span class="member-map__row-count">${place.count}</span>
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
                          renderPersonLine(member, place, options.now),
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

/** Legend, then the small print: who could not be placed, and whose IP database placed the rest. */
function renderFoot(map: MemberMap) {
  return html`
    <div class="member-map__foot">
      <ul class="member-map__legend">
        <li>
          <span class="member-map__key member-map__key--city"></span>${t(
            "dashboard.memberMap.legendCity",
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
        <li>
          <span class="member-map__key member-map__key--size"></span>${t(
            "dashboard.memberMap.legendSize",
          )}
        </li>
      </ul>
      ${map.unplaced > 0
        ? html`<p class="member-map__note" data-testid="member-map-unplaced">
            ${t("dashboard.memberMap.unplaced", { count: String(map.unplaced) })}
          </p>`
        : nothing}
      ${map.attribution
        ? html`<p class="member-map__note member-map__credit" data-testid="member-map-attribution">
            <a href=${map.attribution.url} target="_blank" rel="noopener noreferrer"
              >${map.attribution.text}</a
            >
          </p>`
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
}

/**
 * The card, plus the full-screen view behind it.
 *
 * A native <dialog> rather than a positioned overlay: it renders in the top layer so no z-index in
 * the app can cover it, closes on Escape, and traps focus — all of which a hand-rolled overlay has
 * to reimplement and usually gets half right.
 *
 * A custom element because the open state, the highlighted city and the expanded rows have to
 * survive the page re-rendering underneath them, which happens every time any other data lands.
 */
class AdminbotMemberMap extends LitElement {
  static override properties = {
    map: { attribute: false },
    variant: { attribute: false },
    now: { attribute: false },
    opened: { state: true },
    active: { state: true },
    picked: { state: true },
  };

  public map: MemberMap | null = null;
  public variant: MemberMapVariant = "card";
  public now: number | undefined = undefined;

  // The full-screen panel is only in the DOM while it is open. The coastline is a 44kB path
  // attribute, and rendering a second copy of it behind a closed dialog is the largest thing on
  // this page duplicated for nothing.
  private opened = false;

  // The city picked out by hovering or focusing its row or pin. Transient: it follows the pointer.
  private active: string | undefined = undefined;

  // The city a click or tap picked. Kept apart from `active` because a tap on a phone sends an
  // emulated mouseenter and a focus before its click: were the click a toggle of `active`, it would
  // see the city already lit by those and switch it straight back off.
  private picked: string | undefined = undefined;

  // Which places' rows are showing every member instead of the capped few. Plain (non-reactive)
  // field rather than a Lit `state` property: mutating a Set in place would not change its
  // identity, so the usual `properties`-driven update would silently miss it anyway -- toggling
  // calls requestUpdate() itself instead.
  private expandedPlaces = new Set<string>();

  private readonly focusPlace = (key: string | undefined): void => {
    if (this.active !== key) {
      this.active = key;
    }
  };

  // Picking the picked city again lets it go, and drops the hover highlight with it: on a phone
  // nothing else would, since no mouseleave follows a tap.
  private readonly pickPlace = (key: string): void => {
    if (this.picked === key) {
      this.picked = undefined;
      this.active = undefined;
    } else {
      this.picked = key;
    }
  };

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

  private dialog(): HTMLDialogElement | null {
    return this.querySelector("dialog");
  }

  private open(): void {
    this.opened = true;
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
    this.opened = false;
  }

  private renderDialog(map: MemberMap, headline: unknown, focus: PlaceFocus) {
    return html`
      <dialog
        class="member-map__dialog"
        data-testid="member-map-dialog"
        aria-label=${t("dashboard.memberMap.title")}
        @close=${() => {
          // Fires for Escape too, which never routes through close().
          this.opened = false;
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
              <div class="member-map__dialog-plot">${renderPlot(map, "dialog", focus)}</div>
              ${renderList(map, {
                ...focus,
                expanded: true,
                expandedPlaces: this.expandedPlaces,
                onToggleExpand: (key) => this.toggleExpanded(key),
              })}
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
    const lit = this.active ?? this.picked;
    const focus: PlaceFocus = {
      active: lit,
      picked: this.picked,
      onFocus: this.focusPlace,
      onPick: this.pickPlace,
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
      <div class="member-map__body">
        <div class="member-map__figure">
          <!-- The plot is the affordance as well as the picture: a map you cannot click to enlarge
               is a map people squint at. -->
          <button
            type="button"
            class="member-map__plot-button"
            data-testid="member-map-plot-button"
            title=${t("dashboard.memberMap.expand")}
            aria-label=${t("dashboard.memberMap.expandAria")}
            @click=${() => this.open()}
          >
            ${renderPlot(map, "card", focus)}
          </button>
          ${lit ? renderPopover(map, lit, now) : nothing}
        </div>
        ${renderList(map, {
          ...focus,
          expanded: false,
          expandedPlaces: this.expandedPlaces,
          onToggleExpand: (key) => this.toggleExpanded(key),
        })}
      </div>
      ${renderFoot(map)}
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
  ></adminbot-member-map>`;
}
