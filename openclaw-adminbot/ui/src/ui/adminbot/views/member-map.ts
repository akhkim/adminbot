// Where the lab is, as a dashboard card.
//
// An equirectangular plot: longitude maps linearly to x, latitude to y. No landmasses are drawn.
// That is a decision, not a shortcut — a coarse coastline at this size is a smear that reads as
// decoration, and the honest alternatives are a CDN tile layer (which the served page at
// /lab_stats/member_map already provides, and which the Control UI should not take a network
// dependency on) or a graticule. The graticule plus a named ranked list makes every dot
// identifiable without asking the reader to recognise a continent from its silhouette.
//
// The list is not a fallback for the map; the two answer different questions. The plot shows spread
// — how far apart the lab is, and which timezones it straddles. The list shows rank — where most
// people actually are. Neither alone is the answer to "where is the lab".
import { html, nothing, svg } from "lit";
import { t } from "../../../i18n/index.ts";
import type { MemberMap, MemberMapPlace } from "../data/member-map.ts";

const VIEW_WIDTH = 360;
const VIEW_HEIGHT = 180;
// Latitude is clipped well short of the poles: nobody in the gazetteer lives past these, and the
// full ±90 range wastes a third of the height on empty ice.
const LAT_LIMIT = 72;

const MIN_RADIUS = 3;
const MAX_RADIUS = 10;

// How many cities the list names before it stops being a summary.
const LIST_LIMIT = 5;

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

function renderPlot(map: MemberMap) {
  const busiest = Math.max(...map.places.map((place) => place.count), 1);
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
      ${map.places.map(
        (place) => svg`
          <circle
            class="member-map__dot"
            cx=${projectX(place.lon)}
            cy=${projectY(place.lat)}
            r=${radiusFor(place.count, busiest)}
          >
            <title>${placeTitle(place)}</title>
          </circle>
        `,
      )}
    </svg>
  `;
}

function renderList(map: MemberMap) {
  const shown = map.places.slice(0, LIST_LIMIT);
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
 * The card, or nothing at all.
 *
 * Nothing is the right answer for a service that has not answered yet, or that placed nobody: an
 * empty map is a worse thing to show a member than one card fewer, and this sits beside cards that
 * are actually waiting on them.
 */
export function renderMemberMap(map: MemberMap | null) {
  if (!map || map.places.length === 0) {
    return nothing;
  }
  return html`
    <article class="dashboard-summary member-map" data-testid="dashboard-member-map">
      <h3 class="dashboard-summary__title">${t("dashboard.memberMap.title")}</h3>
      <p class="dashboard-summary__headline">
        ${t("dashboard.memberMap.headline", {
          count: String(map.counts.placed),
          cities: String(map.places.length),
        })}
      </p>
      <div class="member-map__body">${renderPlot(map)} ${renderList(map)}</div>
      ${map.unplaced > 0
        ? html`<p class="dashboard-summary__detail" data-testid="member-map-unplaced">
            ${t("dashboard.memberMap.unplaced", { count: String(map.unplaced) })}
          </p>`
        : nothing}
    </article>
  `;
}
