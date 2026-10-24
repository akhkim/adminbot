import { html, nothing } from "lit";
import type { WhereBin } from "../data/availability.ts";
// The where-strip under the Time Availability chart: one cell per period, saying where the member
// is. The trip editor that feeds it is views/time-availability.trip-editor.ts, the page's "Trip
// Away" tab; both read and write the schedule's `trips` field.

/**
 * A date range as a person reads it: "Sep 1 – Sep 30", or a single day as itself.
 *
 * Takes the two fields rather than a TripRow so the trips list and the where-strip's breakdown
 * format their dates through one function; they are the same fact in two places, and two copies
 * would eventually disagree about whether a one-day trip prints as a range.
 */
export function formatRange(row: { start: string; end: string }): string {
  const format = (value: string): string => {
    const [year, month, day] = value.split("-").map(Number);
    // Built field by field: new Date("2026-09-01") is UTC midnight, which prints as August 31 for
    // every reader west of Greenwich.
    return Number.isFinite(year)
      ? new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).toLocaleDateString([], {
          month: "short",
          day: "numeric",
        })
      : value;
  };
  return row.start === row.end ? format(row.start) : `${format(row.start)} – ${format(row.end)}`;
}

/**
 * The where-strip that runs under the chart: one cell per period, saying where the member is.
 *
 * Under the chart rather than in the trips box because it is the same question the bars answer,
 * asked about place instead of effort -- and because it has to follow the range switch. At "week"
 * that is a city per day, at "month" per week, at "year" per month, which is the granularity the
 * reader just chose for everything else on the screen.
 *
 * Home periods are drawn quietly. The strip would otherwise be a wall of the member's own city
 * with the interesting weeks hidden inside it, and where somebody lives is already on their
 * profile -- what this is for is the weeks when they are somewhere else.
 *
 * The breakdown is a real element revealed on hover and on keyboard focus, not a `title`. A native
 * tooltip gave a help cursor and then, often, nothing: it is slow, it is suppressed while a pointer
 * is moving, and there is no way to reach it from the keyboard at all -- so the "+2" on a cell
 * pointed at content that could not reliably be read.
 */
export function renderWhereStrip(bins: readonly WhereBin[]) {
  // Any travel at all in the horizon, not just a period that is *mostly* travel: a five-day
  // conference makes no month majority-away, and hiding the strip for it would hide exactly the
  // case the breakdown was added to explain.
  const travels = bins.some((bin) => bin.away || bin.segments.some((segment) => segment.away));
  if (!travels) {
    return nothing;
  }
  return html`
    <div class="adminbot-where-strip" data-testid="time-availability-where-strip">
      ${bins.map((bin) => {
        const detail = bin.segments.length
          ? bin.segments
          : [{ start: "", end: "", city: bin.city, away: bin.away }];
        return html`
          <div
            class="adminbot-where-strip__cell ${bin.away ? "adminbot-where-strip__cell--away" : ""}"
            tabindex="0"
          >
            <span class="adminbot-where-strip__label">${bin.label}</span>
            <span class="adminbot-where-strip__city">${bin.city}</span>
            <!-- How many other places the period also covers. A count rather than an asterisk:
                 "+2" says there is more here and roughly how much. -->
            ${bin.segments.length > 1
              ? html`<span class="adminbot-where-strip__more">+${bin.segments.length - 1}</span>`
              : nothing}
            <span class="adminbot-where-strip__detail" role="tooltip">
              <span class="adminbot-where-strip__detail-title">${bin.label}</span>
              ${detail.map(
                (segment) => html`
                  <span class="adminbot-where-strip__detail-row">
                    ${segment.start
                      ? html`<span class="adminbot-where-strip__detail-range"
                          >${formatRange(segment)}</span
                        >`
                      : nothing}
                    <span>${segment.city}</span>
                  </span>
                `,
              )}
            </span>
          </div>
        `;
      })}
    </div>
  `;
}
