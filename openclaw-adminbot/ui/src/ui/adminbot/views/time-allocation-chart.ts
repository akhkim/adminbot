// The Time Allocation chart, as the time-allocation MVP built it: a recharts stacked bar of effort
// per interval, with a tooltip, a legend, and arrows to page through the timeline.
//
// React inside a lit page, mounted through a custom element -- the same arrangement the original
// used. recharts has no lit binding, and reimplementing its axes, stacking, tooltips and
// responsive container in raw SVG is what produced the flatter chart this replaces.
//
// The chart speaks in effort as a share of weekly capacity rather than in hours: the caller
// converts, so this module needs to know nothing about how a member's schedule is stored.
import { html } from "lit";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import {
  createElement,
  type ComponentProps,
  type FunctionComponent,
  Fragment,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useId,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { i18n, t } from "../../../i18n/index.ts";

export type TimeAllocationTask = {
  id: string;
  key: string;
  sourceIndex: number;
  source: "jinesis" | "outside";
  name: string;
  start: string;
  end: string;
  effort: number;
  color?: string;
  // Whatever the member wrote about this allocation ("Shared with Mei"). Shown under its row in
  // the tooltip, the same fact the table's hover text carries.
  note?: string;
};

export type TimeAllocationAwayRange = {
  id: string;
  name: string;
  start: string;
  end: string;
  note?: string;
};

type TimeAllocationCategory = {
  key: string;
  name: string;
  source: TimeAllocationTask["source"];
};

type TimeAllocationSegment = {
  start: string;
  end: string;
  label: string;
  allocations: Array<{ key: string; name: string; effort: number }>;
  total: number;
  peakTotal: number;
  activeDays: number;
  dayCount: number;
  overCapacityDays: number;
  nearCapacityDays: number;
  awayDays: number;
  awayRanges: readonly TimeAllocationAwayRange[];
};

type TimeAllocationChartDatum = {
  start: string;
  end: string;
  label: string;
  total: number;
  peakTotal: number;
  activeDays: number;
  dayCount: number;
  overCapacityDays: number;
  nearCapacityDays: number;
  awayDays: number;
  awayRanges: readonly TimeAllocationAwayRange[];
  [key: string]: string | number | readonly TimeAllocationAwayRange[];
};

type TimeAllocationTooltipEntry = {
  dataKey?: string | number;
  fill?: string;
  color?: string;
  name?: string | number;
  value?: string | number;
  payload?: TimeAllocationChartDatum;
};

type TimeAllocationTooltipProps = {
  active?: boolean;
  payload?: readonly TimeAllocationTooltipEntry[];
  label?: string | number;
  notes?: ReadonlyMap<string, string>;
  outsideKeys?: ReadonlySet<string>;
};

export type TimeAllocationInterval = "day" | "week" | "month";
const DAY_MS = 86_400_000;
const TIME_CHART_ELEMENT = "adminbot-effort-stack-chart";
// Keep the standalone EffortStackChart palette and its stable first-seen color assignment.
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
const AWAY_BACKGROUND_KEY = "__away_background__";
// Recharts omits a Bar's background when that series is exactly zero. A tiny transparent value,
// held to one rendered pixel, gives the whole-day background an anchor without changing any
// allocation total or tooltip value.
const AWAY_BACKGROUND_CARRIER_VALUE = 0.000_001;

// recharts 3.x types declare `children` as a required prop. Passing children as createElement's
// rest arguments -- which is how this chart is written, and how React itself reads them -- does
// not satisfy that, so the container is re-typed with children optional rather than every nested
// call being restructured into a children-in-props object.
const ChartContainer = ResponsiveContainer as unknown as FunctionComponent<
  Omit<ComponentProps<typeof ResponsiveContainer>, "children"> & { children?: ReactNode }
>;

function normalizeTaskColor(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return /^#[\dA-F]{3}(?:[\dA-F]{3})?$/iu.test(withHash) ? withHash.toUpperCase() : null;
}

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

function monthDate(iso: string): string {
  return new Intl.DateTimeFormat(i18n.getLocale(), {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(dateMs(iso)));
}

function startOfWeek(iso: string): string {
  const date = new Date(dateMs(iso));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return isoDate(dateMs(iso) - daysSinceMonday * DAY_MS);
}

function startOfMonth(iso: string): string {
  const date = new Date(dateMs(iso));
  return isoDate(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(iso: string, months: number): string {
  const date = new Date(dateMs(iso));
  return isoDate(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function alignIntervalStart(iso: string, interval: TimeAllocationInterval): string {
  if (interval === "week") {
    return startOfWeek(iso);
  }
  if (interval === "month") {
    return startOfMonth(iso);
  }
  return iso;
}

function addIntervals(iso: string, interval: TimeAllocationInterval, count: number): string {
  if (interval === "month") {
    return addMonths(iso, count);
  }
  return isoDate(dateMs(iso) + count * (interval === "week" ? 7 : 1) * DAY_MS);
}

function intervalPlural(interval: TimeAllocationInterval): string {
  return interval === "day" ? "days" : interval === "week" ? "weeks" : "months";
}

function intervalLabel(start: string, end: string, interval: TimeAllocationInterval): string {
  if (interval === "month") {
    return monthDate(start);
  }
  if (interval === "week") {
    return `${shortDate(start)}–${shortDate(isoDate(dateMs(end) - DAY_MS))}`;
  }
  return shortDate(start);
}

function tableDate(iso: string): string {
  return new Intl.DateTimeFormat(i18n.getLocale(), {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(dateMs(iso)));
}


function formatPercentage(value: number): string {
  return new Intl.NumberFormat(i18n.getLocale(), {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value / 100);
}




function taskCategories(tasks: readonly TimeAllocationTask[]): TimeAllocationCategory[] {
  return [
    ...new Map(
      tasks.map((task) => [
        task.key,
        { key: task.key, name: task.name, source: task.source } satisfies TimeAllocationCategory,
      ]),
    ).values(),
  ];
}

function taskColors(tasks: readonly TimeAllocationTask[]): Map<string, string> {
  const categories = taskCategories(tasks);
  return new Map(
    categories.map((category, index) => {
      const customColor = tasks.find(
        (task) => task.key === category.key && normalizeTaskColor(task.color),
      )?.color;
      return [
        category.key,
        normalizeTaskColor(customColor) ??
          CHART_COLORS[index % CHART_COLORS.length] ??
          CHART_NEUTRAL_COLOR,
      ];
    }),
  );
}

function dailyAllocations(
  tasks: readonly TimeAllocationTask[],
  categories: readonly TimeAllocationCategory[],
  awayRanges: readonly TimeAllocationAwayRange[],
  day: string,
): {
  allocations: Array<{ key: string; name: string; effort: number }>;
  total: number;
  awayRanges: readonly TimeAllocationAwayRange[];
} {
  const dayEnd = isoDate(dateMs(day) + DAY_MS);
  const away = awayRanges.filter((range) => range.start < dayEnd && exclusiveEnd(range.end) > day);
  // A whole-day answer is a calendar constraint, not another allocation. Clear the work on that
  // date before larger intervals average their daily values, or a week containing leave would
  // continue to advertise hours the member explicitly said were unavailable.
  if (away.length > 0) {
    return { allocations: [], total: 0, awayRanges: away };
  }
  const byKey = new Map<string, number>();
  for (const task of tasks) {
    if (task.start < dayEnd && exclusiveEnd(task.end) > day) {
      byKey.set(task.key, (byKey.get(task.key) ?? 0) + task.effort);
    }
  }
  const allocations = categories.flatMap((category) => {
    const effort = byKey.get(category.key);
    return effort ? [{ ...category, effort }] : [];
  });
  return {
    allocations,
    total: allocations.reduce((sum, allocation) => sum + allocation.effort, 0),
    awayRanges: [],
  };
}

// Every interval is reduced from daily values. This gives partial weeks and months a
// time-weighted average while retaining daily peak and capacity-risk information.
export function allocationSegments(
  tasks: readonly TimeAllocationTask[],
  awayRanges: readonly TimeAllocationAwayRange[],
  windowStart: string,
  interval: TimeAllocationInterval,
): TimeAllocationSegment[] {
  const categories = taskCategories(tasks);
  const segments: TimeAllocationSegment[] = [];
  for (let bucketOffset = 0; bucketOffset < 7; bucketOffset += 1) {
    const start = addIntervals(windowStart, interval, bucketOffset);
    const end = addIntervals(start, interval, 1);
    const days = Array.from(
      { length: Math.round((dateMs(end) - dateMs(start)) / DAY_MS) },
      (_, dayOffset) => {
        const day = isoDate(dateMs(start) + dayOffset * DAY_MS);
        return dailyAllocations(tasks, categories, awayRanges, day);
      },
    );
    const allocations = categories.flatMap((category) => {
      const effort =
        days.reduce(
          (sum, day) =>
            sum +
            (day.allocations.find((allocation) => allocation.key === category.key)?.effort ?? 0),
          0,
        ) / days.length;
      return effort > 0 ? [{ ...category, effort }] : [];
    });
    const dailyTotals = days.map((day) => day.total);
    const segmentAwayRanges = [
      ...new Map(days.flatMap((day) => day.awayRanges).map((range) => [range.id, range])).values(),
    ];
    segments.push({
      start,
      end,
      label: intervalLabel(start, end, interval),
      allocations,
      total: dailyTotals.reduce((sum, total) => sum + total, 0) / days.length,
      peakTotal: Math.max(0, ...dailyTotals),
      activeDays: dailyTotals.filter((total) => total > 0).length,
      dayCount: days.length,
      overCapacityDays: dailyTotals.filter((total) => total > 100).length,
      nearCapacityDays: dailyTotals.filter((total) => total >= 90 && total <= 100).length,
      awayDays: days.filter((day) => day.awayRanges.length > 0).length,
      awayRanges: segmentAwayRanges,
    });
  }
  return segments;
}

function yAxisMaximum(segments: readonly TimeAllocationSegment[]): number {
  const highestTotal = Math.max(100, ...segments.map((segment) => segment.total));
  return Math.max(100, Math.ceil(highestTotal / 10) * 10);
}

function chartData(
  segments: readonly TimeAllocationSegment[],
  categories: readonly TimeAllocationCategory[],
): TimeAllocationChartDatum[] {
  return segments.map((segment) => {
    const datum: TimeAllocationChartDatum = {
      start: segment.start,
      end: segment.end,
      label: segment.label,
      total: segment.total,
      peakTotal: segment.peakTotal,
      activeDays: segment.activeDays,
      dayCount: segment.dayCount,
      overCapacityDays: segment.overCapacityDays,
      nearCapacityDays: segment.nearCapacityDays,
      awayDays: segment.awayDays,
      awayRanges: segment.awayRanges,
    };
    for (const category of categories) {
      datum[category.key] = 0;
    }
    for (const allocation of segment.allocations) {
      datum[allocation.key] = allocation.effort;
    }
    return datum;
  });
}

function TimeAllocationTooltip({
  active,
  payload,
  label,
  notes,
  outsideKeys,
}: TimeAllocationTooltipProps): ReactNode {
  if (!active || !payload?.length) {
    return null;
  }
  const visibleAllocations = payload.filter(
    (entry) => entry.dataKey !== AWAY_BACKGROUND_KEY && Number(entry.value) > 0,
  );
  const outsideAllocations = visibleAllocations.filter((entry) =>
    outsideKeys?.has(String(entry.dataKey)),
  );
  const jinesisAllocations = visibleAllocations.filter(
    (entry) => !outsideKeys?.has(String(entry.dataKey)),
  );
  const segment = payload[0]?.payload;
  const total = Number(segment?.total ?? 0);
  const awayDays = Number(segment?.awayDays ?? 0);
  const dayCount = Number(segment?.dayCount ?? 0);
  const awayRanges = segment?.awayRanges ?? [];
  return createElement(
    "div",
    { className: "adminbot-time-chart__tooltip" },
    createElement("div", { className: "adminbot-time-chart__tooltip-label" }, label),
    ...jinesisAllocations.map((entry) =>
      createElement(
        "div",
        {
          className: "adminbot-time-chart__tooltip-row",
          key: String(entry.dataKey),
        },
        createElement(
          "span",
          { className: "adminbot-time-chart__tooltip-task" },
          createElement("i", {
            style: { background: entry.fill ?? entry.color ?? CHART_NEUTRAL_COLOR },
          }),
          entry.name,
        ),
        createElement("span", null, formatPercentage(Number(entry.value))),
        notes?.get(String(entry.dataKey))
          ? createElement(
              "span",
              { className: "adminbot-time-chart__tooltip-note" },
              notes.get(String(entry.dataKey)),
            )
          : null,
      ),
    ),
    outsideAllocations.length > 0 || awayDays > 0
      ? createElement(
          "div",
          { className: "adminbot-time-chart__tooltip-away" },
          createElement("i", { className: "adminbot-time-chart__away-swatch" }),
          createElement(
            "div",
            null,
            createElement(
              "strong",
              null,
              t("adminbotTimeAvailability.legendTimeOff"),
            ),
            ...outsideAllocations.map((entry) =>
              createElement(
                "div",
                {
                  className: "adminbot-time-chart__tooltip-away-allocation",
                  key: String(entry.dataKey),
                },
                createElement("span", null, entry.name),
                createElement("span", null, formatPercentage(Number(entry.value))),
                notes?.get(String(entry.dataKey))
                  ? createElement(
                      "small",
                      { className: "adminbot-time-chart__tooltip-note" },
                      notes.get(String(entry.dataKey)),
                    )
                  : null,
              ),
            ),
            awayDays > 0
              ? createElement(
                  "span",
                  { className: "adminbot-time-chart__tooltip-away-period" },
                  dayCount === 1
                    ? t("adminbotTimeAvailability.tables.wholeDay")
                    : `${awayDays} / ${dayCount} days away`,
                )
              : null,
            ...awayRanges.map((range) =>
              createElement(
                "span",
                { key: range.id },
                `${range.name} · ${shortDate(range.start)}–${shortDate(range.end)}`,
                range.note
                  ? createElement(
                      "small",
                      { className: "adminbot-time-chart__tooltip-note" },
                      range.note,
                    )
                  : null,
              ),
            ),
          ),
        )
      : null,
    createElement(
      "div",
      {
        className:
          total > 100
            ? "adminbot-time-chart__tooltip-total adminbot-time-chart__tooltip-total--over"
            : "adminbot-time-chart__tooltip-total",
      },
      `${formatPercentage(total)} average allocation`,
    ),
    createElement(
      "dl",
      { className: "adminbot-time-chart__tooltip-stats" },
      createElement(
        "div",
        null,
        createElement("dt", null, "Peak daily allocation"),
        createElement("dd", null, formatPercentage(Number(segment?.peakTotal ?? 0))),
      ),
      createElement(
        "div",
        null,
        createElement("dt", null, "Active days"),
        createElement("dd", null, `${segment?.activeDays ?? 0} / ${segment?.dayCount ?? 0}`),
      ),
      createElement(
        "div",
        null,
        createElement("dt", null, "Days over 100%"),
        createElement("dd", null, segment?.overCapacityDays ?? 0),
      ),
      createElement(
        "div",
        null,
        createElement("dt", null, "Days near capacity"),
        createElement("dd", null, segment?.nearCapacityDays ?? 0),
      ),
    ),
  );
}

function ChartPageButton({
  direction,
  label,
  onClick,
}: {
  direction: "previous" | "next";
  label: string;
  onClick: () => void;
}): ReactNode {
  const [tooltipPosition, setTooltipPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const showTooltip = (button: HTMLButtonElement) => {
    const bounds = button.getBoundingClientRect();
    setTooltipPosition({
      left: bounds.left + bounds.width / 2,
      top: bounds.bottom + 8,
    });
  };
  const tooltip =
    tooltipPosition && typeof document !== "undefined"
      ? createPortal(
          createElement(
            "div",
            {
              className: "adminbot-time-chart__page-tooltip",
              role: "tooltip",
              style: {
                left: tooltipPosition.left,
                top: tooltipPosition.top,
              },
            },
            label,
          ),
          document.body,
        )
      : null;
  return createElement(
    Fragment,
    null,
    createElement(
      "button",
      {
        type: "button",
        className: "adminbot-time-chart__page-button",
        "aria-label": `Show ${label.toLowerCase()}`,
        onClick,
        onMouseEnter: (event: ReactMouseEvent<HTMLButtonElement>) =>
          showTooltip(event.currentTarget),
        onMouseLeave: () => setTooltipPosition(null),
        onFocus: (event: ReactFocusEvent<HTMLButtonElement>) => showTooltip(event.currentTarget),
        onBlur: () => setTooltipPosition(null),
      },
      createElement(direction === "previous" ? ChevronLeft : ChevronRight, {
        size: 20,
        "aria-hidden": true,
      }),
    ),
    tooltip,
  );
}

type AwayBackgroundProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: TimeAllocationChartDatum;
  patternId: string;
};

function AwayBackground({
  x,
  y,
  width,
  height,
  payload,
  patternId,
}: AwayBackgroundProps): ReactNode {
  const awayDays = Number(payload?.awayDays ?? 0);
  const dayCount = Number(payload?.dayCount ?? 0);
  if (
    awayDays <= 0 ||
    dayCount <= 0 ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  const label =
    dayCount === 1
      ? t("adminbotTimeAvailability.tables.wholeDay")
      : `${awayDays}/${dayCount} days away`;
  return createElement(
    "g",
    { className: "adminbot-time-chart__away-background", "aria-hidden": true },
    createElement("rect", {
      x,
      y,
      width,
      height,
      rx: 2,
      fill: `url(#${patternId})`,
      opacity: awayDays === dayCount ? 0.72 : 0.2 + (awayDays / dayCount) * 0.32,
    }),
    Number(width) >= 54
      ? createElement(
          "text",
          {
            x: Number(x) + Number(width) / 2,
            y: Number(y) + 14,
            textAnchor: "middle",
            className: "adminbot-time-chart__away-label",
          },
          label,
        )
      : null,
  );
}

function TimeAllocationLegend({
  categories,
  colors,
  hasWholeDayAway,
}: {
  categories: readonly TimeAllocationCategory[];
  colors: ReadonlyMap<string, string>;
  hasWholeDayAway: boolean;
}): ReactNode {
  return createElement(
    "div",
    { className: "adminbot-time-chart__legend" },
    ...categories.map((category) =>
      createElement(
        "span",
        { className: "adminbot-time-chart__legend-item", key: category.key },
        createElement("i", {
          className:
            category.source === "outside"
              ? "adminbot-time-chart__legend-swatch adminbot-time-chart__legend-swatch--outside"
              : "adminbot-time-chart__legend-swatch",
          style: { backgroundColor: colors.get(category.key) ?? CHART_NEUTRAL_COLOR },
        }),
        category.source === "outside"
          ? `${category.name} · ${t("adminbotTimeAvailability.legendTimeOff")}`
          : category.name,
      ),
    ),
    hasWholeDayAway
      ? createElement(
          "span",
          { className: "adminbot-time-chart__legend-item" },
          createElement("i", {
            className:
              "adminbot-time-chart__legend-swatch adminbot-time-chart__legend-swatch--away",
          }),
          t("adminbotTimeAvailability.tables.wholeDay"),
        )
      : null,
  );
}

function EffortStackChart({
  tasks,
  awayRanges,
  memberName,
  interval,
}: {
  tasks: readonly TimeAllocationTask[];
  awayRanges: readonly TimeAllocationAwayRange[];
  memberName: string;
  interval: TimeAllocationInterval;
}): ReactNode {
  const patternPrefix = `adminbot-time-chart-${useId().replace(/[^\dA-Z_-]/giu, "")}`;
  const [windowStart, setWindowStart] = useState(() =>
    alignIntervalStart(
      [
        ...tasks.map((task) => task.start),
        ...awayRanges.map((range) => range.start),
      ].toSorted()[0] ?? isoDate(Date.now()),
      interval,
    ),
  );
  const segments = allocationSegments(tasks, awayRanges, windowStart, interval);
  const taskNotes = new Map(
    tasks.flatMap((task) =>
      task.note ? ([[task.key, task.note]] as Array<[string, string]>) : [],
    ),
  );
  const colors = taskColors(tasks);
  const categories = taskCategories(tasks);
  const outsideKeys = new Set(
    categories
      .filter((category) => category.source === "outside")
      .map((category) => category.key),
  );
  // Recharts draws a Bar's background across the complete plot height. Keep that responsibility on
  // an invisible series rather than the first task: a fully-away day has no task bar to attach to.
  const chartCategories: TimeAllocationCategory[] = [
    { key: AWAY_BACKGROUND_KEY, name: "", source: "jinesis" },
    ...categories,
  ];
  const data = chartData(segments, chartCategories).map((datum) => ({
    ...datum,
    [AWAY_BACKGROUND_KEY]: AWAY_BACKGROUND_CARRIER_VALUE,
  }));
  const outsidePatternIds = new Map(
    categories
      .filter((category) => category.source === "outside")
      .map((category, index) => [category.key, `${patternPrefix}-outside-${index}`]),
  );
  const awayPatternId = `${patternPrefix}-away`;
  const segmentSummary = segments
    .filter((segment) => segment.allocations.length > 0 || segment.awayDays > 0)
    .map((segment) => {
      const start = tableDate(segment.start);
      const end = tableDate(isoDate(dateMs(segment.end) - DAY_MS));
      const summaries =
        segment.allocations.length > 0
          ? [
              t("adminbotTimeAvailability.segmentSummary", {
                start,
                end,
                allocations: segment.allocations
                  .map((allocation) => `${allocation.name} ${formatPercentage(allocation.effort)}`)
                  .join(", "),
                total: formatPercentage(segment.total),
              }),
            ]
          : [];
      if (segment.awayDays > 0) {
        summaries.push(t("adminbotTimeAvailability.segmentSummaryOff", { start, end }));
      }
      return `${summaries.join(" ")} Peak daily allocation ${formatPercentage(segment.peakTotal)}. Active days ${segment.activeDays} of ${segment.dayCount}. Days away: ${segment.awayDays}. Days over 100%: ${segment.overCapacityDays}. Days near capacity: ${segment.nearCapacityDays}.`;
    })
    .join(" ");
  const renderTotalLabel = (categoryKey: string, labelProps: unknown) => {
    const {
      x,
      y,
      width,
      index: segmentIndex,
      viewBox,
    } = labelProps as {
      x?: number;
      y?: number;
      width?: number;
      index?: number;
      viewBox?: { x?: number; y?: number; width?: number };
    };
    const labelX = Number(x ?? viewBox?.x);
    const labelY = Number(y ?? viewBox?.y);
    const labelWidth = Number(width ?? viewBox?.width);
    if (
      !Number.isFinite(labelX) ||
      !Number.isFinite(labelY) ||
      !Number.isFinite(labelWidth) ||
      segmentIndex === undefined
    ) {
      return null;
    }
    const segment = segments
      .filter((candidate) =>
        candidate.allocations.some((allocation) => allocation.key === categoryKey),
      )
      .at(segmentIndex);
    if (!segment || segment.allocations.at(-1)?.key !== categoryKey) {
      return null;
    }
    const total = segment.total;
    const totalClass =
      total > 100
        ? "adminbot-time-chart__total adminbot-time-chart__total--over"
        : total >= 90
          ? "adminbot-time-chart__total adminbot-time-chart__total--near"
          : "adminbot-time-chart__total";
    return createElement(
      "text",
      {
        className: totalClass,
        x: labelX + labelWidth / 2,
        y: labelY - 8,
        textAnchor: "middle",
      },
      formatPercentage(total),
    );
  };

  return createElement(
    "div",
    { className: "adminbot-time-chart" },
    createElement("span", { className: "adminbot-time-chart__summary" }, segmentSummary),
    createElement(
      "div",
      { className: "adminbot-time-chart__pager" },
      createElement(ChartPageButton, {
        direction: "previous",
        label: `Previous 7 ${intervalPlural(interval)}`,
        onClick: () => setWindowStart((currentStart) => addIntervals(currentStart, interval, -7)),
      }),
      createElement(
        "div",
        {
          className: "adminbot-time-chart__plot",
          role: "img",
          "aria-label": t("adminbotTimeAvailability.chartAria", { member: memberName }),
        },
        tasks.length === 0 && awayRanges.length === 0
          ? createElement(
              "div",
              { className: "adminbot-time-chart__empty" },
              t("adminbotTimeAvailability.noAllocations"),
            )
          : createElement(
              ChartContainer,
              {
                width: "100%",
                height: "100%",
                minWidth: 640,
                initialDimension: { width: 860, height: 320 },
              },
              createElement(
                BarChart,
                {
                  data,
                  margin: { top: 20, right: 12, left: 0, bottom: 8 },
                  barCategoryGap: 0,
                  barGap: 0,
                  accessibilityLayer: true,
                },
                createElement(
                  "defs",
                  null,
                  createElement(
                    "pattern",
                    {
                      id: awayPatternId,
                      width: 8,
                      height: 8,
                      patternUnits: "userSpaceOnUse",
                    },
                    createElement("rect", {
                      width: 8,
                      height: 8,
                      fill: "#4B5563",
                    }),
                    createElement("path", {
                      d: "M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6",
                      stroke: "#CBD5E1",
                      strokeWidth: 1.5,
                    }),
                  ),
                  ...categories.flatMap((category) => {
                    const id = outsidePatternIds.get(category.key);
                    if (!id) {
                      return [];
                    }
                    const color = colors.get(category.key) ?? CHART_NEUTRAL_COLOR;
                    return [
                      createElement(
                        "pattern",
                        {
                          id,
                          key: id,
                          width: 8,
                          height: 8,
                          patternUnits: "userSpaceOnUse",
                        },
                        createElement("rect", { width: 8, height: 8, fill: color }),
                        createElement("path", {
                          d: "M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6",
                          stroke: "#FFFFFF",
                          strokeOpacity: 0.68,
                          strokeWidth: 1.5,
                        }),
                      ),
                    ];
                  }),
                ),
                createElement(CartesianGrid, {
                  strokeDasharray: "3 3",
                  stroke: "#2A2E35",
                  vertical: false,
                }),
                createElement(XAxis, {
                  dataKey: "label",
                  tick: { fontSize: 11, fill: "#9AA0AA" },
                  interval: 0,
                }),
                createElement(YAxis, {
                  tick: { fontSize: 12, fill: "#9AA0AA" },
                  domain: [0, () => yAxisMaximum(segments)],
                  tickFormatter: (value: number) => formatPercentage(value),
                }),
                createElement(Tooltip, {
                  content: createElement(TimeAllocationTooltip, { notes: taskNotes, outsideKeys }),
                  cursor: { fill: "rgba(255,255,255,0.04)" },
                }),
                createElement(Legend, {
                  wrapperStyle: { fontSize: 12, color: "#9AA0AA" },
                  content: createElement(TimeAllocationLegend, {
                    categories,
                    colors,
                    hasWholeDayAway: awayRanges.length > 0,
                  }),
                }),
                createElement(ReferenceLine, {
                  y: 100,
                  stroke: "#F7615D",
                  strokeDasharray: "4 4",
                  strokeOpacity: 0.6,
                }),
                ...chartCategories.map((category, categoryIndex) =>
                  createElement(
                    Bar,
                    {
                      key: category.key,
                      dataKey: category.key,
                      name: category.name,
                      stackId: "stack",
                      fill:
                        category.key === AWAY_BACKGROUND_KEY
                          ? "transparent"
                          : outsidePatternIds.has(category.key)
                            ? `url(#${outsidePatternIds.get(category.key)})`
                            : (colors.get(category.key) ?? CHART_NEUTRAL_COLOR),
                      className: "adminbot-time-chart__segment",
                      isAnimationActive: false,
                      minPointSize: category.key === AWAY_BACKGROUND_KEY ? 1 : 0,
                      ...(categoryIndex === 0
                        ? {
                            background: (backgroundProps: unknown) =>
                              createElement(AwayBackground, {
                                ...(backgroundProps as Omit<AwayBackgroundProps, "patternId">),
                                patternId: awayPatternId,
                              }),
                          }
                        : {}),
                    },
                    category.key !== AWAY_BACKGROUND_KEY
                      ? createElement(LabelList, {
                          dataKey: "total",
                          position: "top",
                          content: (labelProps: unknown) =>
                            renderTotalLabel(category.key, labelProps),
                        })
                      : null,
                  ),
                ),
              ),
            ),
      ),
      createElement(ChartPageButton, {
        direction: "next",
        label: `Next 7 ${intervalPlural(interval)}`,
        onClick: () => setWindowStart((currentStart) => addIntervals(currentStart, interval, 7)),
      }),
    ),
    createElement(
      "div",
      { className: "adminbot-time-chart__capacity-note" },
      createElement(Info, { size: 13, "aria-hidden": true }),
      t("adminbotTimeAvailability.capacityNote"),
    ),
  );
}

class AdminBotEffortStackChartElement extends HTMLElement {
  private reactRoot: Root | undefined;
  private chartTasks: readonly TimeAllocationTask[] = [];
  private chartAwayRanges: readonly TimeAllocationAwayRange[] = [];
  private chartMemberId = "";
  private chartMemberName = "";
  private chartInterval: TimeAllocationInterval = "day";

  get tasks(): readonly TimeAllocationTask[] {
    return this.chartTasks;
  }

  set tasks(tasks: readonly TimeAllocationTask[]) {
    this.chartTasks = tasks;
    this.renderChart();
  }

  get awayRanges(): readonly TimeAllocationAwayRange[] {
    return this.chartAwayRanges;
  }

  set awayRanges(awayRanges: readonly TimeAllocationAwayRange[]) {
    this.chartAwayRanges = awayRanges;
    this.renderChart();
  }

  get memberName(): string {
    return this.chartMemberName;
  }

  set memberName(memberName: string) {
    this.chartMemberName = memberName;
    this.renderChart();
  }

  set memberId(memberId: string) {
    this.chartMemberId = memberId;
    this.renderChart();
  }

  get interval(): TimeAllocationInterval {
    return this.chartInterval;
  }

  set interval(interval: TimeAllocationInterval) {
    this.chartInterval = interval;
    this.renderChart();
  }

  connectedCallback() {
    this.renderChart();
  }

  disconnectedCallback() {
    this.reactRoot?.unmount();
    this.reactRoot = undefined;
  }

  private renderChart() {
    if (!this.isConnected) {
      return;
    }
    this.reactRoot ??= createRoot(this);
    const firstScheduleStart =
      [
        ...this.chartTasks.map((task) => task.start),
        ...this.chartAwayRanges.map((range) => range.start),
      ].toSorted()[0] ?? "no-schedule";
    flushSync(() => {
      this.reactRoot?.render(
        createElement(EffortStackChart, {
          key: `${this.chartMemberId}:${firstScheduleStart}:${this.chartInterval}`,
          tasks: this.chartTasks,
          awayRanges: this.chartAwayRanges,
          memberName: this.chartMemberName,
          interval: this.chartInterval,
        }),
      );
    });
  }
}

if (!customElements.get(TIME_CHART_ELEMENT)) {
  customElements.define(TIME_CHART_ELEMENT, AdminBotEffortStackChartElement);
}

export function renderTimeAllocationChart(
  tasks: readonly TimeAllocationTask[],
  memberName: string,
  memberId: string,
  interval: TimeAllocationInterval,
  awayRanges: readonly TimeAllocationAwayRange[] = [],
) {
  return html`
    <adminbot-effort-stack-chart
      .memberId=${memberId}
      .interval=${interval}
      .tasks=${tasks}
      .awayRanges=${awayRanges}
      .memberName=${memberName}
    ></adminbot-effort-stack-chart>
  `;
}

