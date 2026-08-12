// Where the lab is, as a dashboard card.
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
import type { MemberMap, MemberMapPlace } from "../data/member-map.ts";
import { WORLD_OUTLINE_PATH, WORLD_OUTLINE_VIEW } from "../data/world-outline.ts";

// Taken from the generated outline rather than declared twice: the path is baked into this exact
// projection, so a mismatch here would slide every dot off the coastline it belongs on.
const VIEW_WIDTH = WORLD_OUTLINE_VIEW.width;
const VIEW_HEIGHT = WORLD_OUTLINE_VIEW.height;
// Latitude is clipped well short of the poles: nobody in the gazetteer lives past these, and the
// full ±90 range wastes a third of the height on empty ice.
const LAT_LIMIT = WORLD_OUTLINE_VIEW.latLimit;

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

function placeTitle(place: MemberMapPlace): string {
  const where = place.country ? `${place.label}, ${place.country}` : place.label;
  // An admin gets names; everyone else gets the headcount, which is all the service sent.
  const names = place.members?.map((member) => member.name).join(", ");
  return names
    ? `${where} — ${names}`
    : t("dashboard.memberMap.placeCount", { place: where, count: String(place.count) });
}

// How many of the busiest cities are named on the plot itself. Enough to anchor the reader without
// the labels colliding into a smear across Europe, which is where most of them land.
const LABELLED_PLACES = 5;

function renderPlot(map: MemberMap) {
  const busiest = Math.max(...map.places.map((place) => place.count), 1);
  const labelled = new Set(map.places.slice(0, LABELLED_PLACES).map((place) => place.key));
  return svg`
    <svg
      class="member-map__plot"
      viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}"
      role="img"
      aria-label=${t("dashboard.memberMap.plotAria", {
        cities: String(map.places.length),
        count: String(map.counts.placed),
      })}
    >
      <title>${t("dashboard.memberMap.plotAria", {
        cities: String(map.places.length),
        count: String(map.counts.placed),
      })}</title>
      <rect class="member-map__ocean" x="0" y="0" width=${VIEW_WIDTH} height=${VIEW_HEIGHT}></rect>
      <path class="member-map__land" d=${WORLD_OUTLINE_PATH}></path>
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
            class=${`member-map__grid ${lat === 0 ? "member-map__grid--equator" : ""}`}
            x1="0"
            x2=${VIEW_WIDTH}
            y1=${projectY(lat)}
            y2=${projectY(lat)}
          ></line>
        `,
      )}
      ${map.places.map((place) => {
        const x = projectX(place.lon);
        const y = projectY(place.lat);
        const r = radiusFor(place.count, busiest);
        return svg`
          <g class="member-map__place">
            <circle class="member-map__halo" cx=${x} cy=${y} r=${r + 2}></circle>
            <circle class="member-map__dot" cx=${x} cy=${y} r=${r}>
              <title>${placeTitle(place)}</title>
            </circle>
            ${
              labelled.has(place.key)
                ? svg`<text
                    class="member-map__label"
                    x=${x}
                    y=${y - r - 2.5}
                    text-anchor=${x > VIEW_WIDTH - 40 ? "end" : x < 40 ? "start" : "middle"}
                  >${place.label}</text>`
                : nothing
            }
          </g>
        `;
      })}
    </svg>
  `;
}

function renderList(map: MemberMap, expanded: boolean) {
  const shown = map.places.slice(0, expanded ? LIST_LIMIT_EXPANDED : LIST_LIMIT);
  const rest = map.places.length - shown.length;
  return html`
    <ul class="member-map__list">
      ${shown.map(
        (place) => html`
          <li class="member-map__row" title=${placeTitle(place)}>
            <span class="member-map__row-label">${place.label}</span>
            <span class="member-map__row-count">${place.count}</span>
          </li>
        `,
      )}
      ${rest > 0
        ? html`<li class="member-map__row member-map__row--more">
            ${t("dashboard.more", { count: String(rest) })}
          </li>`
        : nothing}
    </ul>
  `;
}

/**
 * The card.
 *
 * A custom element rather than a render function because it owns one piece of state -- whether it
 * is expanded -- and that has to survive the dashboard re-rendering underneath it, which happens
 * every time any other card's data lands. Same reason the deadline board is one.
 *
 * Collapsed it spans the dashboard grid rather than taking a single column: a world map in a 288px
 * column is a row of specks. Expanded it drops the list underneath and gives the plot the whole
 * width, which is the only way the closer cities separate at all.
 */
class AdminbotMemberMap extends LitElement {
  static override properties = { map: { attribute: false }, expanded: { state: true } };

  public map: MemberMap | null = null;

  private expanded = false;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  private toggle(): void {
    this.expanded = !this.expanded;
  }

  protected override render() {
    const map = this.map;
    if (!map || map.places.length === 0) {
      return nothing;
    }
    return html`
      <article
        class="dashboard-summary member-map"
        data-testid="dashboard-member-map"
        ?data-expanded=${this.expanded}
      >
        <div class="member-map__head">
          <div>
            <h3 class="dashboard-summary__title">${t("dashboard.memberMap.title")}</h3>
            <p class="dashboard-summary__headline">
              ${t("dashboard.memberMap.headline", {
                count: String(map.counts.placed),
                cities: String(map.places.length),
              })}
            </p>
          </div>
          <button
            type="button"
            class="btn btn--sm"
            data-testid="member-map-toggle"
            aria-expanded=${this.expanded ? "true" : "false"}
            @click=${() => this.toggle()}
          >
            ${this.expanded
              ? t("dashboard.memberMap.collapse")
              : t("dashboard.memberMap.expand")}
          </button>
        </div>
        <div class="member-map__body">
          ${renderPlot(map)} ${renderList(map, this.expanded)}
        </div>
        ${map.unplaced > 0
          ? html`<p class="dashboard-summary__detail" data-testid="member-map-unplaced">
              ${t("dashboard.memberMap.unplaced", { count: String(map.unplaced) })}
            </p>`
          : nothing}
      </article>
    `;
  }
}

if (!customElements.get("adminbot-member-map")) {
  customElements.define("adminbot-member-map", AdminbotMemberMap);
}

export function renderMemberMap(map: MemberMap | null) {
  if (!map || map.places.length === 0) {
    return nothing;
  }
  return html`<adminbot-member-map .map=${map}></adminbot-member-map>`;
}
