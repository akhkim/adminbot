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
 * The card, plus the full-screen view behind it.
 *
 * A native <dialog> rather than a positioned overlay: it renders in the top layer so no z-index in
 * the app can cover it, closes on Escape, and traps focus — all of which a hand-rolled overlay has
 * to reimplement and usually gets half right.
 *
 * A custom element because the open state has to survive the dashboard re-rendering underneath it,
 * which happens every time any other card's data lands. The deadline board is one for the same
 * reason.
 */
class AdminbotMemberMap extends LitElement {
  static override properties = { map: { attribute: false }, opened: { state: true } };

  public map: MemberMap | null = null;

  // The full-screen panel is only in the DOM while it is open. The coastline is a 44kB path
  // attribute, and rendering a second copy of it behind a closed dialog is the largest thing on
  // this page duplicated for nothing.
  private opened = false;

  protected override createRenderRoot(): HTMLElement {
    return this;
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

  protected override render() {
    const map = this.map;
    if (!map || map.places.length === 0) {
      return nothing;
    }
    const headline = t("dashboard.memberMap.headline", {
      count: String(map.counts.placed),
      cities: String(map.places.length),
    });
    return html`
      <article class="dashboard-summary member-map" data-testid="dashboard-member-map">
        <div class="member-map__head">
          <div>
            <h3 class="dashboard-summary__title">${t("dashboard.memberMap.title")}</h3>
            <p class="dashboard-summary__headline">${headline}</p>
          </div>
          <button
            type="button"
            class="btn btn--sm"
            data-testid="member-map-toggle"
            @click=${() => this.open()}
          >
            ${t("dashboard.memberMap.expand")}
          </button>
        </div>
        <div class="member-map__body">
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
            ${renderPlot(map)}
          </button>
          ${renderList(map, false)}
        </div>
        ${map.unplaced > 0
          ? html`<p class="dashboard-summary__detail" data-testid="member-map-unplaced">
              ${t("dashboard.memberMap.unplaced", { count: String(map.unplaced) })}
            </p>`
          : nothing}

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
              <div>
                <h2 class="dashboard-summary__title">${t("dashboard.memberMap.title")}</h2>
                <p class="dashboard-summary__headline">${headline}</p>
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
              <div class="member-map__dialog-plot">${renderPlot(map)}</div>
              ${renderList(map, true)}
            </div>`
            : nothing}
        </dialog>
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
