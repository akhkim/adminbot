// A member's committed time: an hours-per-week chart over a timeline, the commitments behind it,
// and the dated milestones they are planning back from.
//
// Ported from `ui/src/ui/views/adminbot-time-availability.ts` on the lab branch
// `luke/time-allocation` (commit a4c560bd). That branch was merged into lab main and then lost
// when a later dev→lab sync replaced the tree wholesale, so this is the surviving copy, moved into
// the post-refactor layout and extended.
//
// The chart is Luke's segmentation, not a calendar one. This briefly rendered fixed day/week/month
// buckets behind a granularity switch; that is a different picture of the same data and it lost the
// property his method exists for. His breakpoints come from the schedule itself -- every commitment
// start and end is a boundary, and each consecutive pair is one bar -- so within a bar the active
// set of commitments never changes, which is what makes stacking overlapping hours meaningful. A
// calendar bucket can straddle a change, so its stack is an average of two different weeks and its
// total belongs to neither. Bars are equal width and touch, so the x axis reads as "what am I
// committed to next, and next after that" rather than as elapsed time.
//
// Day / Week / Month therefore switch the *unit the hours are quoted in*, never the bars. The
// segmentation is identical in all three; only the y axis, the totals and the table column change
// between h/day, h/wk and h/mo. Nothing is ever bucketed or merged, so no view can round a
// commitment away or blend two of them into one figure -- picking a unit is a reading preference,
// not a different dataset.
//
// What the schedule is made of, and why it is three lists rather than one:
//
//   - `availability` rows are Jinesis commitments: hours per week over a date range.
//   - `time_off` rows are everything else — a holiday, a course, an internship, a non-Jinesis
//     project. They carry no hours because they are not lab work; a whole-day one (availability
//     "none") suppresses Jinesis hours for the days it covers, which is the holiday override.
//   - `milestones` are single dates to plan back from, not stretches of time.
//
// The chart reads in hours per week rather than percent of capacity. Percent needed a declared
// `hours_per_week` as a denominator, so a member who had not set one got no chart at all; hours are
// the number they typed in, and capacity becomes a reference line when it is known.
import { html, nothing, svg } from "lit";
import { i18n, t } from "../../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
import { icons } from "../../icons.ts";
import type { AdminBotLabMember } from "../controllers/admin.ts";
import {
  availabilityRows,
  milestoneRows,
  timeOffRows,
  type AvailabilityRow,
  type MilestoneRow,
  type TimeOffRow,
} from "../data/availability.ts";
import { upcomingMajorDeadlines } from "../data/deadline-time.ts";

type TimeAllocationTask = {
  key: string;
  name: string;
  start: string;
  end: string;
  /** Hours per week this commitment asks for. */
  hours: number;
};

type TimeAllocationSegment = {
  start: string;
  end: string;
  label: string;
  allocations: Array<{ key: string; name: string; hours: number }>;
  total: number;
  /** True when a whole-day time-off row covers this bucket entirely. */
  suppressed: boolean;
};

/**
 * The unit the chart and tables quote hours in. Purely a display choice — see the header: it never
 * changes the bars, only the number written on them.
 */
export type TimeAvailabilityHoursUnit = "day" | "week" | "month";

export const TIME_AVAILABILITY_HOURS_UNITS: readonly TimeAvailabilityHoursUnit[] = [
  "day",
  "week",
  "month",
];

/**
 * Weeks-per-unit, applied to the stored `hours_per_week` figure.
 *
 * A month is 52/12 weeks rather than a real calendar month: every bar spans an arbitrary stretch of
 * days, so there is no particular month to take the length of. The average is the only figure that
 * means the same thing on every bar, which is the whole point of this being a unit and not a bucket.
 */
const WEEKS_PER_UNIT: Record<TimeAvailabilityHoursUnit, number> = {
  day: 1 / 7,
  week: 1,
  month: 52 / 12,
};

/**
 * What a commitment is, which decides both which table it lands in and which list it is stored on.
 *
 * `jinesis` is the only one that costs weekly hours, so it is the only one written to
 * `availability`. The rest map onto `adminBotTimeOffKinds` in
 * extensions/adminbot/src/contracts/actions.ts — a closed enum so the categories mean the same
 * thing lab-wide — with `other` as the escape hatch that carries the member's own label.
 */
export const TIME_AVAILABILITY_CATEGORIES = [
  "jinesis",
  "vacation",
  "course_load",
  "personal",
  "other_project",
  "internship",
  "other",
] as const;

export type TimeAvailabilityCategory = (typeof TIME_AVAILABILITY_CATEGORIES)[number];

/** Draft state for the "add a commitment" form, kept on the app state so a re-render preserves it. */
export type TimeAvailabilityDraft = {
  category: TimeAvailabilityCategory;
  /** The member's own category name, used only when `category` is "other". */
  customLabel: string;
  project: string;
  start: string;
  end: string;
  hoursPerWeek: string;
  /**
   * Non-Jinesis only: whether the member is away for the whole day.
   *
   * Defaults true, because someone recording a holiday means they are gone — and only a whole-day
   * row suppresses the Jinesis hours underneath it, which is the override the tab exists to show.
   * Unticking it records "around, but at a reduced rate", which the chart deliberately does not
   * subtract from: nothing stored says by how much, and inventing a figure would put a number on
   * the chart that the member never typed.
   */
  wholeDay: boolean;
  note: string;
  link: string;
};

export const EMPTY_TIME_AVAILABILITY_DRAFT: TimeAvailabilityDraft = {
  category: "jinesis",
  customLabel: "",
  project: "",
  start: "",
  end: "",
  hoursPerWeek: "",
  wholeDay: true,
  note: "",
  link: "",
};

export type MilestoneDraft = {
  date: string;
  label: string;
  link: string;
};

export const EMPTY_MILESTONE_DRAFT: MilestoneDraft = { date: "", label: "", link: "" };

/** Everything the editor may rewrite. An omitted list is left as it is. */
export type SchedulePatch = {
  availability?: AvailabilityRow[];
  time_off?: TimeOffRow[];
  milestones?: MilestoneRow[];
};

export type AdminBotTimeAvailabilityProps = {
  members: AdminBotLabMember[];
  loading: boolean;
  error: string | null;
  selectedMemberId: string;
  onMemberChange: (memberId: string) => void;
  hoursUnit: TimeAvailabilityHoursUnit;
  onHoursUnitChange: (unit: TimeAvailabilityHoursUnit) => void;
  /** The signed-in member. The editor renders only when this matches the selected member. */
  viewerMemberId: string | null;
  /** The Jinesis-commitment form's draft. Its category is always "jinesis". */
  draft: TimeAvailabilityDraft;
  onDraftChange: (draft: TimeAvailabilityDraft) => void;
  /** The time-away form's draft, kept separate so the two forms cannot clear each other. */
  awayDraft: TimeAvailabilityDraft;
  onAwayDraftChange: (draft: TimeAvailabilityDraft) => void;
  milestoneDraft: MilestoneDraft;
  onMilestoneDraftChange: (draft: MilestoneDraft) => void;
  onSaveSchedule: (memberId: string, patch: SchedulePatch) => void;
  saving: boolean;
};

const DAY_MS = 86_400_000;
const CHART_HEIGHT = 360;
const CHART_LEFT = 58;
const CHART_RIGHT = 20;
const CHART_TOP = 28;
const CHART_BOTTOM = 64;
const MIN_BAR_SLOT = 88;
// Copied from EffortStackChart: stable color per task name, assigned in first-seen order.
const CHART_COLORS = [
  "#3575DA",
  "#00676E",
  "#F6511D",
  "#188B3E",
  "#783810",
  "#F7615D",
  "#8B5CF6",
  "#D4A72C",
] as const;
const CHART_NEUTRAL_COLOR = "#9AA0AA";

// One bar per change in the schedule keeps the count near the number of commitments, but a member
// with a long history of short overlapping rows can still outrun the axis. Cap and say so, rather
// than rendering a smear.
const MAX_SEGMENTS = 40;

// How many rows the side table shows before it stops being a summary.
const BIG_DEADLINE_LIMIT = 6;

// Mirrors ADMINBOT_OPEN_PROJECT in extensions/adminbot/src/contracts/actions.ts: declared spare
// capacity, not a commitment, so it never takes a color slot or a bar.
const OPEN_PROJECT = "__open__";

function dateMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function exclusiveEnd(iso: string): string {
  return isoDate(dateMs(iso) + DAY_MS);
}

function shortDate(iso: string): string {
  return new Intl.DateTimeFormat(i18n.getLocale(), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(dateMs(iso)));
}

function tableDate(iso: string): string {
  return new Intl.DateTimeFormat(i18n.getLocale(), {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(dateMs(iso)));
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(i18n.getLocale(), { maximumFractionDigits: 1 }).format(value);
}

/**
 * Rescales a stored weekly-hours figure into the unit on screen.
 *
 * Storage is always hours per week — that is what the member typed and what the service validates
 * against 0–168 — so this is a display conversion and nothing writes the result back.
 */
export function hoursIn(weeklyHours: number, unit: TimeAvailabilityHoursUnit): number {
  return weeklyHours * WEEKS_PER_UNIT[unit];
}

function formatHours(weeklyHours: number, unit: TimeAvailabilityHoursUnit): string {
  return t(`adminbotTimeAvailability.hoursValue.${unit}`, {
    hours: formatNumber(hoursIn(weeklyHours, unit)),
  });
}

function taskName(project: string | undefined): string {
  return project?.trim() || t("adminbotTimeAvailability.termBaseline");
}

/** The label a non-Jinesis row shows: its own name when it has one, otherwise its category. */
export function timeOffLabel(row: TimeOffRow): string {
  const custom = row.label?.trim();
  if (custom) {
    return custom;
  }
  const kind = row.kind ?? "other";
  return (TIME_AVAILABILITY_CATEGORIES as readonly string[]).includes(kind)
    ? t(`adminbotTimeAvailability.category.${kind}`)
    : t("adminbotTimeAvailability.category.other");
}

/**
 * The days a whole-day time-off row covers.
 *
 * Only `availability: "none"` rows count. A "partial" row means the member is still around at a
 * reduced rate, and there is no stored number saying by how much — guessing one would put a made-up
 * figure on a chart that is otherwise entirely what they typed.
 */
function suppressedRanges(rows: readonly TimeOffRow[]): Array<{ start: string; end: string }> {
  return rows
    .filter((row) => row.availability !== "partial")
    .map((row) => ({ start: row.start, end: exclusiveEnd(row.end) }));
}

function fullyCovered(
  bucketStartIso: string,
  bucketEndIso: string,
  ranges: ReadonlyArray<{ start: string; end: string }>,
): boolean {
  return ranges.some((range) => range.start <= bucketStartIso && range.end >= bucketEndIso);
}

function jinesisTasks(member: AdminBotLabMember): TimeAllocationTask[] {
  return availabilityRows(member.availability).flatMap((row) => {
    if (row.project === OPEN_PROJECT) {
      return [];
    }
    const start = dateMs(row.start);
    const end = dateMs(row.end);
    const weeklyHours = row.hours_per_week;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start ||
      !Number.isFinite(weeklyHours) ||
      weeklyHours <= 0
    ) {
      return [];
    }
    return [
      {
        key: row.project ? `project:${row.project}` : "baseline",
        name: taskName(row.project),
        start: row.start,
        end: row.end,
        hours: weeklyHours,
      },
    ];
  });
}

function taskCategories(
  tasks: readonly TimeAllocationTask[],
): Array<{ key: string; name: string }> {
  return [...new Map(tasks.map((task) => [task.key, { key: task.key, name: task.name }])).values()];
}

function taskColors(tasks: readonly TimeAllocationTask[]): Map<string, string> {
  const categories = taskCategories(tasks);
  return new Map(
    categories.map((category, index) => [
      category.key,
      CHART_COLORS[index % CHART_COLORS.length] ?? CHART_NEUTRAL_COLOR,
    ]),
  );
}

/**
 * Cuts the schedule at every date something changes, and sums the weekly hours active in each
 * resulting stretch.
 *
 * This is Luke's `buildSegments`, which he took from EffortStackChart: every commitment's start and
 * its exclusive end is a breakpoint, and each consecutive pair of breakpoints becomes one stacked
 * bar. The point of cutting this way rather than on calendar boundaries is that the active set of
 * commitments cannot change inside a segment, which is what makes it correct to add up overlapping
 * hours into one stack. Stored end dates are inclusive, so the boundary used for breakpoints and
 * for overlap tests is the next calendar day.
 *
 * Two departures from his version, both to carry features his branch did not have:
 *
 *   - Time-off dates are breakpoints too. He had no time-off list; without cutting on those dates a
 *     holiday landing inside a commitment could not zero out its own days, because there would be
 *     no segment boundary at the point the member goes away. This is what makes "holiday overrides
 *     task duration" work.
 *   - A segment fully covered by a whole-day time-off row is zeroed and flagged `suppressed`
 *     instead of dropped, so it renders as "away" rather than as a gap. Partial coverage is left
 *     alone: half a week off does not zero the week, and nothing stored says by how much it should.
 *
 * A segment with no allocations and no time off is dropped outright, as his did — those are the
 * gaps between commitments, and a bar of nothing is not worth an axis slot.
 *
 * `truncated` is true when the schedule produced more segments than the axis can carry.
 */
export function allocationSegments(
  tasks: readonly TimeAllocationTask[],
  timeOff: readonly TimeOffRow[] = [],
): { segments: TimeAllocationSegment[]; truncated: boolean } {
  if (tasks.length === 0) {
    return { segments: [], truncated: false };
  }
  const categories = taskCategories(tasks);
  const suppressed = suppressedRanges(timeOff);
  // Time-off boundaries only matter where they fall inside the span the commitments cover; a
  // holiday six months after the last commitment ends would otherwise stretch the axis over an
  // empty year.
  const firstDay = tasks.map((task) => task.start).reduce((a, b) => (a < b ? a : b));
  const lastDay = tasks.map((task) => exclusiveEnd(task.end)).reduce((a, b) => (a > b ? a : b));
  const breakpoints = [
    ...new Set([
      ...tasks.flatMap((task) => [task.start, exclusiveEnd(task.end)]),
      ...suppressed
        .flatMap((range) => [range.start, range.end])
        .filter((day) => day > firstDay && day < lastDay),
    ]),
  ].toSorted();

  const segments: TimeAllocationSegment[] = [];
  let truncated = false;
  for (let index = 0; index < breakpoints.length - 1; index += 1) {
    if (segments.length >= MAX_SEGMENTS) {
      truncated = true;
      break;
    }
    const start = breakpoints[index];
    const end = breakpoints[index + 1];
    const isSuppressed = fullyCovered(start, end, suppressed);
    const byKey = new Map<string, number>();
    if (!isSuppressed) {
      for (const task of tasks) {
        // Active while [task.start, exclusiveEnd(task.end)) overlaps this segment.
        if (task.start < end && exclusiveEnd(task.end) > start) {
          byKey.set(task.key, (byKey.get(task.key) ?? 0) + task.hours);
        }
      }
    }
    const allocations = categories.flatMap((category) => {
      const hours = byKey.get(category.key);
      return hours ? [{ ...category, hours }] : [];
    });
    if (allocations.length === 0 && !isSuppressed) {
      continue;
    }
    segments.push({
      start,
      end,
      // His label: the stretch the bar covers, end shown as the inclusive last day it contains.
      label: `${shortDate(start)} → ${shortDate(isoDate(dateMs(end) - DAY_MS))}`,
      allocations,
      total: allocations.reduce((sum, allocation) => sum + allocation.hours, 0),
      suppressed: isSuppressed,
    });
  }
  return { segments, truncated };
}

// Rounds up to a tick step that suits the magnitude, so an h/day axis does not jump in 5s (its
// whole range is often under 8) and an h/mo axis does not need forty gridlines.
function axisStep(highest: number): number {
  if (highest <= 8) {
    return 1;
  }
  return highest <= 40 ? 5 : 20;
}

// Works in the displayed unit, so the axis is round numbers of what is written on it.
function yAxisMaximum(
  segments: readonly TimeAllocationSegment[],
  capacity: number,
  unit: TimeAvailabilityHoursUnit,
): number {
  const highest = hoursIn(Math.max(capacity, ...segments.map((segment) => segment.total), 1), unit);
  return Math.ceil(highest / axisStep(highest)) * axisStep(highest);
}

function renderTimeChart(
  tasks: readonly TimeAllocationTask[],
  memberName: string,
  timeOff: readonly TimeOffRow[],
  capacity: number,
  unit: TimeAvailabilityHoursUnit,
) {
  const { segments, truncated } = allocationSegments(tasks, timeOff);
  const colors = taskColors(tasks);
  const categories = taskCategories(tasks);
  const yMaximum = yAxisMaximum(segments, capacity, unit);
  const tickStep = axisStep(yMaximum);
  const hourTicks: number[] = [];
  for (let value = 0; value <= yMaximum; value += tickStep) {
    hourTicks.push(value);
  }
  if (hourTicks.at(-1) !== yMaximum) {
    hourTicks.push(yMaximum);
  }

  const chartWidth = Math.max(640, CHART_LEFT + CHART_RIGHT + segments.length * MIN_BAR_SLOT);
  const plotWidth = chartWidth - CHART_LEFT - CHART_RIGHT;
  const plotHeight = CHART_HEIGHT - CHART_TOP - CHART_BOTTOM;
  const barWidth = plotWidth / Math.max(1, segments.length);
  // Takes stored weekly hours and lands them on the axis, which is drawn in the display unit.
  const y = (weeklyHours: number) =>
    CHART_TOP + ((yMaximum - hoursIn(weeklyHours, unit)) / yMaximum) * plotHeight;
  const hasCapacity = capacity > 0;
  const segmentSummary = segments
    .map((segment) =>
      segment.suppressed
        ? t("adminbotTimeAvailability.segmentSummaryOff", {
            start: tableDate(segment.start),
            end: tableDate(isoDate(dateMs(segment.end) - DAY_MS)),
          })
        : t("adminbotTimeAvailability.segmentSummary", {
            start: tableDate(segment.start),
            end: tableDate(isoDate(dateMs(segment.end) - DAY_MS)),
            allocations: segment.allocations
              .map((allocation) => `${allocation.name} ${formatHours(allocation.hours, unit)}`)
              .join(", "),
            total: formatHours(segment.total, unit),
          }),
    )
    .join(" ");

  return html`
    <div class="adminbot-time-chart__legend">
      ${categories.map(
        (category) => html`
          <span>
            <i style=${`background:${colors.get(category.key) ?? CHART_NEUTRAL_COLOR}`}></i>
            ${category.name}
          </span>
        `,
      )}
      ${segments.some((segment) => segment.suppressed)
        ? html`<span>
            <i class="adminbot-time-chart__legend-off"></i>
            ${t("adminbotTimeAvailability.legendTimeOff")}
          </span>`
        : nothing}
    </div>
    ${svg`
      <svg
        class="adminbot-time-chart"
        viewBox="0 0 ${chartWidth} ${CHART_HEIGHT}"
        role="img"
        aria-label=${t("adminbotTimeAvailability.chartAria", { member: memberName })}
      >
        <title>${t("adminbotTimeAvailability.chartAria", { member: memberName })}</title>
        <desc>${segmentSummary}</desc>
        ${hourTicks.map((hours) => {
          const tickY = y(hours);
          return svg`
            <line
              class="adminbot-time-chart__grid"
              x1=${CHART_LEFT}
              x2=${chartWidth - CHART_RIGHT}
              y1=${tickY}
              y2=${tickY}
            ></line>
            <text
              class="adminbot-time-chart__axis-label"
              x=${CHART_LEFT - 10}
              y=${tickY + 4}
              text-anchor="end"
            >${formatNumber(hours)}</text>
          `;
        })}
        ${
          hasCapacity
            ? svg`<line
              class="adminbot-time-chart__capacity-line"
              x1=${CHART_LEFT}
              x2=${chartWidth - CHART_RIGHT}
              y1=${y(capacity)}
              y2=${y(capacity)}
            ></line>`
            : nothing
        }
        <line
          class="adminbot-time-chart__axis"
          x1=${CHART_LEFT}
          x2=${chartWidth - CHART_RIGHT}
          y1=${CHART_HEIGHT - CHART_BOTTOM}
          y2=${CHART_HEIGHT - CHART_BOTTOM}
        ></line>
        <line
          class="adminbot-time-chart__axis"
          x1=${CHART_LEFT}
          x2=${CHART_LEFT}
          y1=${CHART_TOP}
          y2=${CHART_HEIGHT - CHART_BOTTOM}
        ></line>
        ${segments.map((segment, index) => {
          const barX = CHART_LEFT + index * barWidth;
          if (segment.suppressed) {
            // The whole bucket is time off. Shade the column rather than drawing a zero bar, so it
            // reads as "away" instead of "nothing scheduled".
            return svg`
              <rect
                class="adminbot-time-chart__off"
                x=${barX}
                y=${CHART_TOP}
                width=${barWidth}
                height=${plotHeight}
              >
                <title>${t("adminbotTimeAvailability.segmentTooltipOff", {
                  start: tableDate(segment.start),
                  end: tableDate(isoDate(dateMs(segment.end) - DAY_MS)),
                })}</title>
              </rect>
              <text
                class="adminbot-time-chart__axis-label adminbot-time-chart__axis-label--timeline"
                x=${barX + barWidth / 2}
                y=${CHART_HEIGHT - 28}
                text-anchor="middle"
              >${segment.label}</text>
            `;
          }
          let accumulated = 0;
          const bars = segment.allocations.map((allocation) => {
            const bottom = y(accumulated);
            accumulated += allocation.hours;
            const top = y(accumulated);
            return svg`
              <rect
                class="adminbot-time-chart__segment"
                x=${barX}
                y=${top}
                width=${barWidth}
                height=${Math.max(1, bottom - top)}
                fill=${colors.get(allocation.key) ?? CHART_NEUTRAL_COLOR}
              >
                <title>${t("adminbotTimeAvailability.segmentTooltip", {
                  task: allocation.name,
                  hours: formatHours(allocation.hours, unit),
                  start: tableDate(segment.start),
                  end: tableDate(isoDate(dateMs(segment.end) - DAY_MS)),
                  total: formatHours(segment.total, unit),
                })}</title>
              </rect>
            `;
          });
          const overCapacity = hasCapacity && segment.total > capacity;
          const nearCapacity = hasCapacity && !overCapacity && segment.total >= capacity * 0.9;
          const totalClass = overCapacity
            ? "adminbot-time-chart__total adminbot-time-chart__total--over"
            : nearCapacity
              ? "adminbot-time-chart__total adminbot-time-chart__total--near"
              : "adminbot-time-chart__total";
          return svg`
            ${bars}
            ${
              segment.allocations.length
                ? svg`<text
                  class=${totalClass}
                  x=${barX + barWidth / 2}
                  y=${y(segment.total) - 8}
                  text-anchor="middle"
                >${formatHours(segment.total, unit)}</text>`
                : nothing
            }
            <text
              class="adminbot-time-chart__axis-label adminbot-time-chart__axis-label--timeline"
              x=${barX + barWidth / 2}
              y=${CHART_HEIGHT - 28}
              text-anchor="middle"
            >${segment.label}</text>
          `;
        })}
      </svg>
    `}
    ${truncated
      ? html`<div class="adminbot-time-chart__capacity-note">
          ${t("adminbotTimeAvailability.truncated", { count: String(MAX_SEGMENTS) })}
        </div>`
      : nothing}
    <div class="adminbot-time-chart__capacity-note">
      ${hasCapacity
        ? t("adminbotTimeAvailability.capacityNote")
        : t("adminbotTimeAvailability.capacityNoteUnset")}
    </div>
  `;
}

// Labelled "Show hours per" rather than "Display by": it picks a unit, not a bucket width, and the
// old wording is exactly the calendar-bucketing this chart does not do.
function renderHoursUnitSwitch(props: AdminBotTimeAvailabilityProps) {
  return html`
    <div
      class="adminbot-time-availability__unit"
      role="group"
      aria-label=${t("adminbotTimeAvailability.hoursUnitLabel")}
    >
      <span class="adminbot-time-availability__unit-label">
        ${t("adminbotTimeAvailability.hoursUnitLabel")}
      </span>
      ${TIME_AVAILABILITY_HOURS_UNITS.map(
        (unit) => html`
          <button
            type="button"
            class="btn btn--sm"
            data-testid=${`time-availability-unit-${unit}`}
            aria-pressed=${props.hoursUnit === unit}
            ?disabled=${props.hoursUnit === unit}
            @click=${() => props.onHoursUnitChange(unit)}
          >
            ${t(`adminbotTimeAvailability.hoursUnit.${unit}`)}
          </button>
        `,
      )}
    </div>
  `;
}

function renderLink(url: string | undefined) {
  if (!url) {
    return nothing;
  }
  return html`<a
    class="adminbot-time-allocation-table__link"
    href=${url}
    target=${EXTERNAL_LINK_TARGET}
    rel=${buildExternalLinkRel()}
    aria-label=${t("adminbotTimeAvailability.openLink")}
    >${icons.externalLink}</a
  >`;
}

// Validates the same things the service does (see validateMember in the kernel), so the common
// mistakes are caught before a round trip rather than coming back as a generic 400.
export function draftError(draft: TimeAvailabilityDraft): string | null {
  if (!draft.start || !draft.end) {
    return t("adminbotTimeAvailability.form.errorDates");
  }
  if (draft.end < draft.start) {
    return t("adminbotTimeAvailability.form.errorOrder");
  }
  // Only Jinesis commitments cost weekly hours; the rest are time away, which has no hours field.
  if (draft.category === "jinesis") {
    const hours = Number(draft.hoursPerWeek);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
      return t("adminbotTimeAvailability.form.errorHours");
    }
  }
  if (draft.category === "other" && !draft.customLabel.trim()) {
    return t("adminbotTimeAvailability.form.errorCustomLabel");
  }
  return linkError(draft.link);
}

// https only, matching validateExternalLink server-side: these render as anchors.
function linkError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    if (new URL(trimmed).protocol !== "https:") {
      return t("adminbotTimeAvailability.form.errorLink");
    }
  } catch {
    return t("adminbotTimeAvailability.form.errorLink");
  }
  return null;
}

export function milestoneDraftError(draft: MilestoneDraft): string | null {
  if (!draft.date) {
    return t("adminbotTimeAvailability.milestones.errorDate");
  }
  if (!draft.label.trim()) {
    return t("adminbotTimeAvailability.milestones.errorLabel");
  }
  return linkError(draft.link);
}

/** Splits the draft into the list it belongs on. Jinesis costs hours; everything else is time away. */
export function draftToPatch(
  draft: TimeAvailabilityDraft,
  existing: { availability: AvailabilityRow[]; timeOff: TimeOffRow[] },
): SchedulePatch {
  const note = draft.note.trim();
  const link = draft.link.trim();
  if (draft.category === "jinesis") {
    const project = draft.project.trim();
    return {
      availability: [
        ...existing.availability,
        {
          start: draft.start,
          end: draft.end,
          hours_per_week: Number(draft.hoursPerWeek),
          ...(project ? { project } : {}),
          ...(note ? { note } : {}),
          ...(link ? { link } : {}),
        },
      ],
    };
  }
  const label = draft.customLabel.trim();
  return {
    time_off: [
      ...existing.timeOff,
      {
        start: draft.start,
        end: draft.end,
        kind: draft.category,
        // Whole day off unless the member says otherwise -- see TimeAvailabilityDraft.wholeDay.
        // Only "none" suppresses the Jinesis hours underneath; "partial" is recorded and shown but
        // never subtracted, because no stored figure says by how much.
        availability: draft.wholeDay ? "none" : "partial",
        ...(label ? { label } : {}),
        ...(note ? { note } : {}),
        ...(link ? { link } : {}),
      },
    ],
  };
}

// Two separate add forms rather than one with a mode switch.
//
// A Jinesis commitment and time away are different acts recorded on different
// lists: one costs weekly hours and belongs to `availability`, the other is a
// stretch the member is not doing lab work at all and belongs to `time_off`. As
// one form behind a category dropdown they shared a submit button and a set of
// fields that appeared and vanished depending on the first control, so filling in
// "20 hours" and then switching category silently discarded it. Two forms means
// each one only ever shows the fields it actually stores, and neither can clear
// the other's half-typed input.
//
// They share this renderer because the date/link/note tail and the validation are
// genuinely identical; only the head differs.
type CommitmentFormProps = {
  props: AdminBotTimeAvailabilityProps;
  existing: { availability: AvailabilityRow[]; timeOff: TimeOffRow[] };
  draft: TimeAvailabilityDraft;
  onDraftChange: (draft: TimeAvailabilityDraft) => void;
  testId: string;
  titleKey: string;
  head: (helpers: {
    draft: TimeAvailabilityDraft;
    update: (patch: Partial<TimeAvailabilityDraft>) => void;
    field: (key: keyof TimeAvailabilityDraft) => (event: Event) => void;
  }) => unknown;
};

function renderCommitmentForm(form: CommitmentFormProps) {
  const { props, existing, draft, onDraftChange, testId, titleKey, head } = form;
  const error = draftError(draft);
  const touched = Boolean(draft.start || draft.end || draft.hoursPerWeek || draft.customLabel);
  const update = (patch: Partial<TimeAvailabilityDraft>) => onDraftChange({ ...draft, ...patch });
  const field = (key: keyof TimeAvailabilityDraft) => (event: Event) =>
    update({ [key]: (event.currentTarget as HTMLInputElement).value });

  return html`
    <section class="adminbot-time-availability__editor" data-testid=${testId}>
      <div class="card-title">${t(titleKey)}</div>
      <form
        class="adminbot-form adminbot-time-availability__form"
        @submit=${(event: Event) => {
          event.preventDefault();
          if (draftError(draft)) {
            return;
          }
          props.onSaveSchedule(props.selectedMemberId, draftToPatch(draft, existing));
        }}
      >
        ${head({ draft, update, field })}
        <label class="adminbot-form__field">
          <span>${t("adminbotTimeAvailability.startDate")}</span>
          <input type="date" .value=${draft.start} required @input=${field("start")} />
        </label>
        <label class="adminbot-form__field">
          <span>${t("adminbotTimeAvailability.endDate")}</span>
          <input type="date" .value=${draft.end} required @input=${field("end")} />
        </label>
        <label class="adminbot-form__field">
          <span>${t("adminbotTimeAvailability.form.link")}</span>
          <input
            type="url"
            data-testid="time-availability-link"
            placeholder=${t("adminbotTimeAvailability.form.linkPlaceholder")}
            .value=${draft.link}
            @input=${field("link")}
          />
        </label>
        <label class="adminbot-form__field adminbot-time-availability__form-note">
          <span>${t("adminbotTimeAvailability.form.note")}</span>
          <input type="text" .value=${draft.note} @input=${field("note")} />
        </label>
        <div class="adminbot-time-availability__form-actions">
          ${error && touched
            ? html`<span class="adminbot-time-availability__form-error" role="alert"
                >${error}</span
              >`
            : nothing}
          <button
            type="submit"
            class="btn primary"
            data-testid=${`${testId}-submit`}
            ?disabled=${props.saving || error !== null}
          >
            ${props.saving
              ? t("adminbotTimeAvailability.form.saving")
              : t("adminbotTimeAvailability.form.submit")}
          </button>
        </div>
      </form>
    </section>
  `;
}

// Jinesis work: a project and the hours a week it takes. Category is pinned, so
// this form has no dropdown at all.
function renderJinesisEditor(
  props: AdminBotTimeAvailabilityProps,
  existing: { availability: AvailabilityRow[]; timeOff: TimeOffRow[] },
) {
  return renderCommitmentForm({
    props,
    existing,
    draft: props.draft,
    onDraftChange: (draft) => props.onDraftChange({ ...draft, category: "jinesis" }),
    testId: "time-availability-editor",
    titleKey: "adminbotTimeAvailability.form.jinesisTitle",
    head: ({ draft, field }) => html`
      <label class="adminbot-form__field">
        <span>${t("adminbotTimeAvailability.form.project")}</span>
        <input
          type="text"
          .value=${draft.project}
          placeholder=${t("adminbotTimeAvailability.form.projectPlaceholder")}
          @input=${field("project")}
        />
      </label>
      <label class="adminbot-form__field">
        <span>${t("adminbotTimeAvailability.form.hours")}</span>
        <input
          type="number"
          min="0.5"
          max="168"
          step="0.5"
          data-testid="time-availability-hours"
          .value=${draft.hoursPerWeek}
          @input=${field("hoursPerWeek")}
        />
      </label>
    `,
  });
}

// Everything that is not Jinesis work: a holiday, a course, an internship, another
// project. No hours field -- these are not lab work, so there is nothing to book
// against the week; what they carry instead is whether the member is away for the
// whole day, which is what suppresses the Jinesis hours underneath.
function renderTimeAwayEditor(
  props: AdminBotTimeAvailabilityProps,
  existing: { availability: AvailabilityRow[]; timeOff: TimeOffRow[] },
) {
  const categories = TIME_AVAILABILITY_CATEGORIES.filter((category) => category !== "jinesis");
  return renderCommitmentForm({
    props,
    existing,
    draft: props.awayDraft,
    onDraftChange: props.onAwayDraftChange,
    testId: "time-away-editor",
    titleKey: "adminbotTimeAvailability.form.awayTitle",
    head: ({ draft, update, field }) => html`
      <label class="adminbot-form__field">
        <span>${t("adminbotTimeAvailability.form.category")}</span>
        <select
          data-testid="time-away-category"
          .value=${draft.category}
          @change=${(event: Event) =>
            update({
              category: (event.currentTarget as HTMLSelectElement)
                .value as TimeAvailabilityCategory,
            })}
        >
          ${categories.map(
            (category) => html`
              <option value=${category} ?selected=${draft.category === category}>
                ${t(`adminbotTimeAvailability.category.${category}`)}
              </option>
            `,
          )}
        </select>
      </label>
      ${draft.category === "other"
        ? html`<label class="adminbot-form__field">
            <span>${t("adminbotTimeAvailability.form.customLabel")}</span>
            <input
              type="text"
              data-testid="time-availability-custom-label"
              .value=${draft.customLabel}
              @input=${field("customLabel")}
            />
          </label>`
        : nothing}
      <label class="adminbot-form__field adminbot-form__field--check">
        <input
          type="checkbox"
          data-testid="time-availability-whole-day"
          .checked=${draft.wholeDay}
          @change=${(event: Event) =>
            update({ wholeDay: (event.currentTarget as HTMLInputElement).checked })}
        />
        <span>${t("adminbotTimeAvailability.form.wholeDay")}</span>
      </label>
      <p class="adminbot-time-availability__form-hint">
        ${draft.wholeDay
          ? t("adminbotTimeAvailability.form.wholeDayHint")
          : t("adminbotTimeAvailability.form.partialHint")}
      </p>
    `,
  });
}

function renderMilestoneEditor(props: AdminBotTimeAvailabilityProps, existing: MilestoneRow[]) {
  const draft = props.milestoneDraft;
  const error = milestoneDraftError(draft);
  const touched = Boolean(draft.date || draft.label);
  const field = (key: keyof MilestoneDraft) => (event: Event) =>
    props.onMilestoneDraftChange({
      ...draft,
      [key]: (event.currentTarget as HTMLInputElement).value,
    });

  return html`
    <form
      class="adminbot-form adminbot-time-availability__milestone-form"
      data-testid="time-availability-milestone-form"
      @submit=${(event: Event) => {
        event.preventDefault();
        if (milestoneDraftError(draft)) {
          return;
        }
        const link = draft.link.trim();
        props.onSaveSchedule(props.selectedMemberId, {
          milestones: [
            ...existing,
            { date: draft.date, label: draft.label.trim(), ...(link ? { link } : {}) },
          ],
        });
      }}
    >
      <label class="adminbot-form__field">
        <span>${t("adminbotTimeAvailability.milestones.date")}</span>
        <input type="date" .value=${draft.date} @input=${field("date")} />
      </label>
      <label class="adminbot-form__field">
        <span>${t("adminbotTimeAvailability.milestones.label")}</span>
        <input
          type="text"
          data-testid="time-availability-milestone-label"
          .value=${draft.label}
          @input=${field("label")}
        />
      </label>
      <label class="adminbot-form__field">
        <span>${t("adminbotTimeAvailability.form.link")}</span>
        <input type="url" .value=${draft.link} @input=${field("link")} />
      </label>
      ${error && touched
        ? html`<span class="adminbot-time-availability__form-error" role="alert">${error}</span>`
        : nothing}
      <button
        type="submit"
        class="btn btn--sm"
        data-testid="time-availability-milestone-add"
        ?disabled=${props.saving || error !== null}
      >
        ${t("adminbotTimeAvailability.milestones.submit")}
      </button>
    </form>
  `;
}

/**
 * The side panel: the member's own milestones merged with the lab's conference deadlines.
 *
 * Conference dates come from the bundled venue snapshot the Deadlines tab already ships rather than
 * being retyped per member — the lab tracks them once, and a member's list stays the handful of
 * dates only they know about.
 */
function renderBigDeadlines(
  milestones: readonly MilestoneRow[],
  props: AdminBotTimeAvailabilityProps,
  editable: boolean,
) {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const own = milestones
    .filter((row) => row.date >= today)
    .map((row) => ({ date: row.date, label: row.label, link: row.link, own: true }));
  const venues = upcomingMajorDeadlines(now, BIG_DEADLINE_LIMIT).map((entry) => ({
    date: entry.venue.deadline_aoe.slice(0, 10),
    label: entry.venue.name,
    link: entry.venue.link,
    own: false,
  }));
  const rows = [...own, ...venues]
    .toSorted((left, right) => left.date.localeCompare(right.date))
    .slice(0, BIG_DEADLINE_LIMIT);

  return html`
    <aside class="adminbot-time-availability__deadlines" data-testid="time-availability-deadlines">
      <div class="card-title">${t("adminbotTimeAvailability.milestones.title")}</div>
      ${rows.length
        ? html`<ul class="adminbot-time-availability__deadline-list">
            ${rows.map(
              (row) => html`
                <li data-own=${String(row.own)}>
                  <span class="adminbot-time-availability__deadline-date">
                    ${tableDate(row.date)}
                  </span>
                  <span class="adminbot-time-availability__deadline-label">${row.label}</span>
                  ${renderLink(row.link)}
                  ${editable && row.own
                    ? html`<button
                        type="button"
                        class="btn btn--sm"
                        ?disabled=${props.saving}
                        @click=${() =>
                          props.onSaveSchedule(props.selectedMemberId, {
                            milestones: milestones.filter(
                              (candidate) =>
                                !(candidate.date === row.date && candidate.label === row.label),
                            ),
                          })}
                      >
                        ${t("adminbotTimeAvailability.form.remove")}
                      </button>`
                    : nothing}
                </li>
              `,
            )}
          </ul>`
        : html`<p class="adminbot-time-availability__empty-note">
            ${t("adminbotTimeAvailability.milestones.empty")}
          </p>`}
      ${editable ? renderMilestoneEditor(props, [...milestones]) : nothing}
    </aside>
  `;
}

function renderJinesisTable(
  tasks: readonly TimeAllocationTask[],
  rows: AvailabilityRow[],
  props: AdminBotTimeAvailabilityProps,
  editable: boolean,
  unit: TimeAvailabilityHoursUnit,
) {
  const colors = taskColors(tasks);
  return html`
    <div class="adminbot-time-allocation-table-wrap" data-testid="time-availability-jinesis-table">
      <div class="card-sub">${t("adminbotTimeAvailability.tables.jinesis")}</div>
      <table class="adminbot-time-allocation-table">
        <thead>
          <tr>
            <th>${t("adminbotTimeAvailability.taskName")}</th>
            <th>${t("adminbotTimeAvailability.startDate")}</th>
            <th>${t("adminbotTimeAvailability.endDate")}</th>
            <th>${t(`adminbotTimeAvailability.hoursColumn.${unit}`)}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map((task) => {
            const row = rows.find(
              (candidate) =>
                candidate.start === task.start &&
                candidate.end === task.end &&
                taskName(candidate.project) === task.name,
            );
            return html`
              <tr>
                <td>
                  <i
                    class="adminbot-time-allocation-table__task"
                    style=${`background:${colors.get(task.key) ?? CHART_NEUTRAL_COLOR}`}
                  ></i>
                  ${task.name}
                </td>
                <td>${tableDate(task.start)}</td>
                <td>${tableDate(task.end)}</td>
                <td>${formatHours(task.hours, unit)}</td>
                <td>
                  ${renderLink(row?.link)}
                  ${editable
                    ? html`<button
                        type="button"
                        class="btn btn--sm"
                        ?disabled=${props.saving}
                        @click=${() =>
                          props.onSaveSchedule(props.selectedMemberId, {
                            // Matched on the row's own identity, not on the derived task: two
                            // commitments can share a project name and differ only by dates.
                            availability: rows.filter(
                              (candidate) =>
                                !(
                                  candidate.start === task.start &&
                                  candidate.end === task.end &&
                                  taskName(candidate.project) === task.name
                                ),
                            ),
                          })}
                      >
                        ${t("adminbotTimeAvailability.form.remove")}
                      </button>`
                    : nothing}
                </td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    </div>
  `;
}

function renderOtherTable(
  rows: TimeOffRow[],
  props: AdminBotTimeAvailabilityProps,
  editable: boolean,
) {
  return html`
    <div class="adminbot-time-allocation-table-wrap" data-testid="time-availability-other-table">
      <div class="card-sub">${t("adminbotTimeAvailability.tables.other")}</div>
      <table class="adminbot-time-allocation-table">
        <thead>
          <tr>
            <th>${t("adminbotTimeAvailability.tables.commitment")}</th>
            <th>${t("adminbotTimeAvailability.startDate")}</th>
            <th>${t("adminbotTimeAvailability.endDate")}</th>
            <th>${t("adminbotTimeAvailability.tables.availability")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (row) => html`
              <tr>
                <td>
                  <i
                    class="adminbot-time-allocation-table__task adminbot-time-allocation-table__task--off"
                  ></i>
                  ${timeOffLabel(row)}
                </td>
                <td>${tableDate(row.start)}</td>
                <td>${tableDate(row.end)}</td>
                <td>
                  ${row.availability === "partial"
                    ? t("adminbotTimeAvailability.tables.partial")
                    : t("adminbotTimeAvailability.tables.wholeDay")}
                </td>
                <td>
                  ${renderLink(row.link)}
                  ${editable
                    ? html`<button
                        type="button"
                        class="btn btn--sm"
                        ?disabled=${props.saving}
                        @click=${() =>
                          props.onSaveSchedule(props.selectedMemberId, {
                            time_off: rows.filter(
                              (candidate) =>
                                !(
                                  candidate.start === row.start &&
                                  candidate.end === row.end &&
                                  candidate.kind === row.kind &&
                                  candidate.label === row.label
                                ),
                            ),
                          })}
                      >
                        ${t("adminbotTimeAvailability.form.remove")}
                      </button>`
                    : nothing}
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

export function renderAdminBotTimeAvailability(props: AdminBotTimeAvailabilityProps) {
  const emptyOptionLabel = props.loading
    ? t("adminbotTimeAvailability.loadingUsers")
    : t("adminbotTimeAvailability.selectUser");
  const selectedMember = props.members.find((member) => member.id === props.selectedMemberId);
  const storedAvailability = selectedMember ? availabilityRows(selectedMember.availability) : [];
  const storedTimeOff = selectedMember ? timeOffRows(selectedMember.time_off) : [];
  const storedMilestones = selectedMember ? milestoneRows(selectedMember.milestones) : [];
  const tasks = selectedMember ? jinesisTasks(selectedMember) : [];
  const weeklyCapacity = Number(selectedMember?.hours_per_week);
  const capacity = Number.isFinite(weeklyCapacity) && weeklyCapacity > 0 ? weeklyCapacity : 0;
  // Editing is self-only: the service routes a member session to its own record, so offering the
  // form on someone else's schedule would just produce a 403 the person cannot act on.
  const editable = Boolean(
    selectedMember && props.viewerMemberId && selectedMember.id === props.viewerMemberId,
  );
  const hasAnything = tasks.length > 0 || storedTimeOff.length > 0;

  return html`
    <div class="card adminbot-card adminbot-card--wide adminbot-time-availability">
      <div class="adminbot-form adminbot-time-availability__controls">
        <label class="adminbot-form__field">
          <span class="card-title">${t("adminbotTimeAvailability.label")}</span>
          <select
            aria-label=${t("adminbotTimeAvailability.selectUser")}
            .value=${selectedMember?.id ?? ""}
            ?disabled=${props.loading || props.members.length === 0}
            @change=${(event: Event) =>
              props.onMemberChange((event.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">${emptyOptionLabel}</option>
            ${props.members.map(
              (member) => html`<option value=${member.id}>${member.name}</option>`,
            )}
          </select>
        </label>
        ${renderHoursUnitSwitch(props)}
      </div>
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
      ${selectedMember
        ? html`
            <div class="adminbot-time-availability__body">
              <section class="adminbot-time-availability__report">
                <div class="adminbot-time-availability__report-header">
                  <div>
                    <div class="card-title">${selectedMember.name}</div>
                    <div class="card-sub">${t("adminbotTimeAvailability.chartSubtitle")}</div>
                  </div>
                  ${capacity
                    ? html`<span class="pill">
                        ${t("adminbotTimeAvailability.capacity", {
                          hours: formatNumber(capacity),
                        })}
                      </span>`
                    : nothing}
                </div>
                ${tasks.length
                  ? html`<div class="adminbot-time-chart-wrap">
                      ${renderTimeChart(
                        tasks,
                        selectedMember.name,
                        storedTimeOff,
                        capacity,
                        props.hoursUnit,
                      )}
                    </div>`
                  : html`<div class="adminbot-time-availability__empty">
                      ${t("adminbotTimeAvailability.noAllocations")}
                    </div>`}
                ${tasks.length
                  ? renderJinesisTable(
                      tasks,
                      storedAvailability,
                      props,
                      editable,
                      props.hoursUnit,
                    )
                  : nothing}
                ${storedTimeOff.length ? renderOtherTable(storedTimeOff, props, editable) : nothing}
                ${!hasAnything && !editable
                  ? html`<div class="adminbot-time-availability__empty">
                      ${t("adminbotTimeAvailability.noAllocations")}
                    </div>`
                  : nothing}
              </section>
              ${renderBigDeadlines(storedMilestones, props, editable)}
            </div>
          `
        : html`
            <div class="adminbot-time-availability__empty">
              ${t("adminbotTimeAvailability.empty")}
            </div>
          `}
      ${editable
        ? html`<div class="adminbot-time-availability__editors">
            ${renderJinesisEditor(props, {
              availability: storedAvailability,
              timeOff: storedTimeOff,
            })}
            ${renderTimeAwayEditor(props, {
              availability: storedAvailability,
              timeOff: storedTimeOff,
            })}
          </div>`
        : nothing}
    </div>
  `;
}
