import { html, nothing } from "lit";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import {
  createElement,
  Fragment,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
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
import { i18n, t } from "../../i18n/index.ts";
import { availabilityRows } from "../adminbot-availability.ts";
import type { AvailabilityRow } from "../adminbot-availability.ts";
import type { AdminBotLabMember } from "../controllers/adminbot.ts";

type TimeAllocationTask = {
  id: string;
  key: string;
  sourceIndex: number;
  name: string;
  start: string;
  end: string;
  effort: number;
  color?: string;
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
  [key: string]: string | number;
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
};

export type TimeAllocationInterval = "day" | "week" | "month";

export type AdminBotTimeAvailabilityProps = {
  members: AdminBotLabMember[];
  loading: boolean;
  error: string | null;
  selectedMemberId: string;
  signedInMemberId: string | null;
  viewInterval: TimeAllocationInterval;
  onMemberChange: (memberId: string) => void;
  onViewIntervalChange: (interval: TimeAllocationInterval) => void;
  onAvailabilityChange: (
    memberId: string,
    availability: AvailabilityRow[],
    hoursPerWeek?: number,
  ) => void;
};

const DAY_MS = 86_400_000;
const DEFAULT_WEEKLY_CAPACITY = 40;
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
const TASK_COLOR_OPTIONS = CHART_COLORS.slice(0, 6);
const CHART_NEUTRAL_COLOR = "#9AA0AA";
const INVALID_COLOR_MESSAGE = "Enter a hex colour such as #3575DA.";

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

function formatNumber(value: number): string {
  return new Intl.NumberFormat(i18n.getLocale(), { maximumFractionDigits: 1 }).format(value);
}

function formatPercentage(value: number): string {
  return new Intl.NumberFormat(i18n.getLocale(), {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value / 100);
}

function taskName(project: string | undefined): string {
  return project?.trim() || t("adminbotTimeAvailability.termBaseline");
}

function legacyTaskId(memberId: string, sourceIndex: number): string {
  return `legacy:${memberId}:${sourceIndex}`;
}

function createTaskId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `task-${Date.now()}-${Math.random()}`;
}

function allocationTasksForMember(member: AdminBotLabMember): TimeAllocationTask[] {
  const capacity = Number(member.hours_per_week);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    return [];
  }
  return availabilityRows(member.availability).flatMap((row, sourceIndex) => {
    if (row.project === "__open__") {
      return [];
    }
    const start = dateMs(row.start);
    const end = dateMs(row.end);
    const weeklyHours = Number(row.hours_per_week);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start ||
      !Number.isFinite(weeklyHours) ||
      weeklyHours <= 0
    ) {
      return [];
    }
    const color = normalizeTaskColor(row.color);
    const id = row.id?.trim() || legacyTaskId(member.id, sourceIndex);
    return [
      {
        id,
        key: `task:${id}`,
        sourceIndex,
        name: taskName(row.project),
        start: row.start,
        end: row.end,
        effort: (weeklyHours / capacity) * 100,
        ...(color ? { color } : {}),
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
  categories: ReadonlyArray<{ key: string; name: string }>,
  day: string,
): { allocations: Array<{ key: string; name: string; effort: number }>; total: number } {
  const byKey = new Map<string, number>();
  const dayEnd = isoDate(dateMs(day) + DAY_MS);
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
  };
}

// Every interval is reduced from daily values. This gives partial weeks and months a
// time-weighted average while retaining daily peak and capacity-risk information.
function allocationSegments(
  tasks: readonly TimeAllocationTask[],
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
        return dailyAllocations(tasks, categories, day);
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
  categories: ReadonlyArray<{ key: string; name: string }>,
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

function TimeAllocationTooltip({ active, payload, label }: TimeAllocationTooltipProps): ReactNode {
  if (!active || !payload?.length) {
    return null;
  }
  const visibleAllocations = payload.filter((entry) => Number(entry.value) > 0);
  const segment = payload[0]?.payload;
  const total = Number(segment?.total ?? 0);
  return createElement(
    "div",
    { className: "adminbot-time-chart__tooltip" },
    createElement("div", { className: "adminbot-time-chart__tooltip-label" }, label),
    ...visibleAllocations.map((entry) =>
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
      ),
    ),
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

function EffortStackChart({
  tasks,
  memberName,
  interval,
}: {
  tasks: readonly TimeAllocationTask[];
  memberName: string;
  interval: TimeAllocationInterval;
}): ReactNode {
  const [windowStart, setWindowStart] = useState(() =>
    alignIntervalStart(
      tasks.map((task) => task.start).toSorted()[0] ?? isoDate(Date.now()),
      interval,
    ),
  );
  const segments = allocationSegments(tasks, windowStart, interval);
  const colors = taskColors(tasks);
  const categories = taskCategories(tasks);
  const data = chartData(segments, categories);
  const segmentSummary = segments
    .filter((segment) => segment.allocations.length > 0)
    .map((segment) => {
      const allocationSummary = t("adminbotTimeAvailability.segmentSummary", {
        start: tableDate(segment.start),
        end: tableDate(isoDate(dateMs(segment.end) - DAY_MS)),
        allocations: segment.allocations
          .map((allocation) => `${allocation.name} ${formatPercentage(allocation.effort)}`)
          .join(", "),
        total: formatPercentage(segment.total),
      });
      return `${allocationSummary} Peak daily allocation ${formatPercentage(segment.peakTotal)}. Active days ${segment.activeDays} of ${segment.dayCount}. Days over 100%: ${segment.overCapacityDays}. Days near capacity: ${segment.nearCapacityDays}.`;
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
        tasks.length === 0
          ? createElement(
              "div",
              { className: "adminbot-time-chart__empty" },
              t("adminbotTimeAvailability.noAllocations"),
            )
          : createElement(
              ResponsiveContainer,
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
                  content: createElement(TimeAllocationTooltip),
                  cursor: { fill: "rgba(255,255,255,0.04)" },
                }),
                createElement(Legend, {
                  wrapperStyle: { fontSize: 12, color: "#9AA0AA" },
                }),
                createElement(ReferenceLine, {
                  y: 100,
                  stroke: "#F7615D",
                  strokeDasharray: "4 4",
                  strokeOpacity: 0.6,
                }),
                ...categories.map((category) =>
                  createElement(
                    Bar,
                    {
                      key: category.key,
                      dataKey: category.key,
                      name: category.name,
                      stackId: "stack",
                      fill: colors.get(category.key) ?? CHART_NEUTRAL_COLOR,
                      className: "adminbot-time-chart__segment",
                      isAnimationActive: false,
                    },
                    createElement(LabelList, {
                      dataKey: "total",
                      position: "top",
                      content: (labelProps: unknown) => renderTotalLabel(category.key, labelProps),
                    }),
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
  private chartMemberId = "";
  private chartMemberName = "";
  private chartInterval: TimeAllocationInterval = "day";

  set tasks(tasks: readonly TimeAllocationTask[]) {
    this.chartTasks = tasks;
    this.renderChart();
  }

  set memberName(memberName: string) {
    this.chartMemberName = memberName;
    this.renderChart();
  }

  set memberId(memberId: string) {
    this.chartMemberId = memberId;
    this.renderChart();
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
    const firstTaskStart = this.chartTasks.map((task) => task.start).toSorted()[0] ?? "no-tasks";
    flushSync(() => {
      this.reactRoot?.render(
        createElement(EffortStackChart, {
          key: `${this.chartMemberId}:${firstTaskStart}:${this.chartInterval}`,
          tasks: this.chartTasks,
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

function renderTimeChart(
  tasks: readonly TimeAllocationTask[],
  memberName: string,
  memberId: string,
  interval: TimeAllocationInterval,
) {
  return html`
    <adminbot-effort-stack-chart
      .memberId=${memberId}
      .interval=${interval}
      .tasks=${tasks}
      .memberName=${memberName}
    ></adminbot-effort-stack-chart>
  `;
}

function changeAvailabilityRow(
  member: AdminBotLabMember,
  sourceIndex: number,
  update: (row: AvailabilityRow) => AvailabilityRow,
): AvailabilityRow[] {
  const rows = availabilityRows(member.availability);
  const row = rows[sourceIndex];
  if (!row) {
    return rows;
  }
  rows[sourceIndex] = update(row);
  return rows;
}

function defaultTaskRow(
  member: AdminBotLabMember,
  tasks: readonly TimeAllocationTask[],
): AvailabilityRow {
  const storedCapacity = Number(member.hours_per_week);
  const capacity =
    Number.isFinite(storedCapacity) && storedCapacity > 0
      ? storedCapacity
      : DEFAULT_WEEKLY_CAPACITY;
  const templateTask = tasks[0];
  const start = templateTask?.start ?? isoDate(Date.now());
  const end = templateTask?.end ?? isoDate(Date.now() + 6 * DAY_MS);
  return {
    id: createTaskId(),
    project: "New task",
    start,
    end,
    hours_per_week: capacity * 0.1,
  };
}

const INVALID_DATE_MESSAGE = "Start date must be on or before end date.";

function taskDatesFromEvent(event: Event): { start: string; end: string } | null {
  const target = event.currentTarget;
  const row = target instanceof HTMLElement ? target.closest("tr") : null;
  const startInput = row?.querySelector<HTMLInputElement>('[data-task-date="start"]');
  const endInput = row?.querySelector<HTMLInputElement>('[data-task-date="end"]');
  if (!row || !startInput || !endInput) {
    return null;
  }

  const start = startInput.value;
  const end = endInput.value;
  const valid = Boolean(start && end && start <= end);
  row.classList.toggle("adminbot-time-allocation-table__row--invalid", !valid);
  startInput.setAttribute("aria-invalid", String(!valid));
  endInput.setAttribute("aria-invalid", String(!valid));
  startInput.setCustomValidity(valid ? "" : INVALID_DATE_MESSAGE);
  endInput.setCustomValidity(valid ? "" : INVALID_DATE_MESSAGE);
  startInput.max = end;
  endInput.min = start;
  return valid ? { start, end } : null;
}

function closeTaskColorPicker(picker: HTMLElement | null) {
  const panel = picker?.querySelector<HTMLElement>(".adminbot-time-allocation-table__color-panel");
  const trigger = picker?.querySelector<HTMLButtonElement>(
    ".adminbot-time-allocation-table__color-trigger",
  );
  if (panel) {
    panel.hidden = true;
  }
  trigger?.setAttribute("aria-expanded", "false");
}

function toggleTaskColorPicker(event: Event) {
  const trigger = event.currentTarget as HTMLButtonElement;
  const picker = trigger.closest(
    ".adminbot-time-allocation-table__color-picker",
  ) as HTMLElement | null;
  const panel = picker?.querySelector<HTMLElement>(".adminbot-time-allocation-table__color-panel");
  if (!picker || !panel) {
    return;
  }
  const willOpen = panel.hidden;
  trigger
    .closest("table")
    ?.querySelectorAll<HTMLElement>(".adminbot-time-allocation-table__color-picker")
    .forEach((otherPicker) => closeTaskColorPicker(otherPicker));
  if (!willOpen) {
    return;
  }
  const triggerBounds = trigger.getBoundingClientRect();
  panel.style.top = `${triggerBounds.bottom + 6}px`;
  panel.style.left = `${Math.max(8, Math.min(triggerBounds.left, window.innerWidth - 224))}px`;
  panel.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  panel.querySelector<HTMLInputElement>('input[name="custom-color"]')?.focus();
}

function renderTaskTable(
  tasks: readonly TimeAllocationTask[],
  member: AdminBotLabMember,
  editable: boolean,
  onAvailabilityChange: (
    memberId: string,
    availability: AvailabilityRow[],
    hoursPerWeek?: number,
  ) => void,
) {
  const colors = taskColors(tasks);
  const capacity = Number(member.hours_per_week);
  const saveRow = (task: TimeAllocationTask, update: (row: AvailabilityRow) => AvailabilityRow) => {
    onAvailabilityChange(
      member.id,
      changeAvailabilityRow(member, task.sourceIndex, (row) => ({
        ...update(row),
        id: row.id?.trim() || task.id,
      })),
    );
  };
  return html`
    <div class="adminbot-time-allocation-table-wrap">
      <table class="adminbot-time-allocation-table">
        <thead>
          <tr>
            <th>${t("adminbotTimeAvailability.taskName")}</th>
            <th>${t("adminbotTimeAvailability.startDate")}</th>
            <th>${t("adminbotTimeAvailability.endDate")}</th>
            <th>${t("adminbotTimeAvailability.effort")}</th>
            ${editable ? html`<th aria-label="Task actions"></th>` : nothing}
          </tr>
        </thead>
        <tbody>
          ${tasks.map((task) => {
            const taskColor = colors.get(task.key) ?? CHART_NEUTRAL_COLOR;
            return html`
              <tr class="adminbot-time-allocation-table__row">
                <td>
                  ${editable
                    ? html`
                        <span class="adminbot-time-allocation-table__color-picker">
                          <button
                            type="button"
                            class="adminbot-time-allocation-table__color-trigger"
                            aria-label=${`Change colour for ${task.name}`}
                            aria-expanded="false"
                            @click=${toggleTaskColorPicker}
                          >
                            <i
                              class="adminbot-time-allocation-table__task"
                              style=${`background:${taskColor}`}
                            ></i>
                          </button>
                          <form
                            class="adminbot-time-allocation-table__color-panel"
                            aria-label=${`Colour options for ${task.name}`}
                            hidden
                            @keydown=${(event: KeyboardEvent) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                closeTaskColorPicker(
                                  (event.currentTarget as HTMLElement).closest(
                                    ".adminbot-time-allocation-table__color-picker",
                                  ) as HTMLElement | null,
                                );
                              }
                            }}
                            @submit=${(event: SubmitEvent) => {
                              event.preventDefault();
                              const form = event.currentTarget as HTMLFormElement;
                              const input = form.elements.namedItem(
                                "custom-color",
                              ) as HTMLInputElement | null;
                              const color = normalizeTaskColor(input?.value);
                              if (!input || !color) {
                                input?.setCustomValidity(INVALID_COLOR_MESSAGE);
                                input?.reportValidity();
                                return;
                              }
                              input.setCustomValidity("");
                              input.value = color;
                              saveRow(task, (row) => ({ ...row, color }));
                              closeTaskColorPicker(
                                form.closest(
                                  ".adminbot-time-allocation-table__color-picker",
                                ) as HTMLElement | null,
                              );
                            }}
                          >
                            <div class="adminbot-time-allocation-table__color-options">
                              ${TASK_COLOR_OPTIONS.map(
                                (color) => html`
                                  <button
                                    type="button"
                                    class="adminbot-time-allocation-table__color-option"
                                    data-color=${color}
                                    aria-label=${`Use ${color} for ${task.name}`}
                                    aria-pressed=${String(taskColor === color)}
                                    style=${`background:${color}`}
                                    @click=${(event: Event) => {
                                      const option = event.currentTarget as HTMLButtonElement;
                                      const selectedColor = normalizeTaskColor(
                                        option.dataset.color,
                                      );
                                      if (!selectedColor) {
                                        return;
                                      }
                                      saveRow(task, (row) => ({ ...row, color: selectedColor }));
                                      closeTaskColorPicker(
                                        option.closest(
                                          ".adminbot-time-allocation-table__color-picker",
                                        ) as HTMLElement | null,
                                      );
                                    }}
                                  ></button>
                                `,
                              )}
                            </div>
                            <label class="adminbot-time-allocation-table__custom-color">
                              <span>Custom hex</span>
                              <span>
                                <input
                                  name="custom-color"
                                  type="text"
                                  inputmode="text"
                                  autocomplete="off"
                                  spellcheck="false"
                                  aria-label=${`Custom colour for ${task.name}`}
                                  placeholder="#3575DA"
                                  .value=${taskColor}
                                  @input=${(event: Event) => {
                                    (event.currentTarget as HTMLInputElement).setCustomValidity("");
                                  }}
                                />
                                <button type="submit">Apply</button>
                              </span>
                            </label>
                          </form>
                        </span>
                      `
                    : html`
                        <i
                          class="adminbot-time-allocation-table__task"
                          style=${`background:${taskColor}`}
                        ></i>
                      `}
                  ${editable
                    ? html`
                        <input
                          class="adminbot-time-allocation-table__input adminbot-time-allocation-table__input--name"
                          aria-label=${`Task name for ${task.name}`}
                          .value=${task.name}
                          @change=${(event: Event) => {
                            if (!taskDatesFromEvent(event)) {
                              return;
                            }
                            const project = (event.currentTarget as HTMLInputElement).value.trim();
                            saveRow(task, (row) => ({
                              ...row,
                              project: project || undefined,
                            }));
                          }}
                        />
                      `
                    : task.name}
                </td>
                <td>
                  ${editable
                    ? html`
                        <input
                          class="adminbot-time-allocation-table__input"
                          aria-label=${`Start date for ${task.name}`}
                          type="date"
                          data-task-date="start"
                          max=${task.end}
                          .value=${task.start}
                          @input=${(event: Event) => {
                            taskDatesFromEvent(event);
                          }}
                          @change=${(event: Event) => {
                            const dates = taskDatesFromEvent(event);
                            if (dates) {
                              saveRow(task, (row) => ({ ...row, ...dates }));
                            }
                          }}
                        />
                      `
                    : tableDate(task.start)}
                </td>
                <td>
                  ${editable
                    ? html`
                        <input
                          class="adminbot-time-allocation-table__input"
                          aria-label=${`End date for ${task.name}`}
                          type="date"
                          data-task-date="end"
                          min=${task.start}
                          .value=${task.end}
                          @input=${(event: Event) => {
                            taskDatesFromEvent(event);
                          }}
                          @change=${(event: Event) => {
                            const dates = taskDatesFromEvent(event);
                            if (dates) {
                              saveRow(task, (row) => ({ ...row, ...dates }));
                            }
                          }}
                        />
                      `
                    : tableDate(task.end)}
                </td>
                <td>
                  ${editable
                    ? html`
                        <span class="adminbot-time-allocation-table__effort">
                          <input
                            class="adminbot-time-allocation-table__input adminbot-time-allocation-table__input--effort"
                            aria-label=${`Effort percentage for ${task.name}`}
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            .value=${String(Math.round(task.effort * 10) / 10)}
                            @change=${(event: Event) => {
                              if (!taskDatesFromEvent(event)) {
                                return;
                              }
                              const effort = Number(
                                (event.currentTarget as HTMLInputElement).value,
                              );
                              if (Number.isFinite(effort) && effort >= 0 && effort <= 100) {
                                saveRow(task, (row) => ({
                                  ...row,
                                  hours_per_week: (effort / 100) * capacity,
                                }));
                              }
                            }}
                          />
                          <span>%</span>
                        </span>
                      `
                    : formatPercentage(task.effort)}
                </td>
                ${editable
                  ? html`
                      <td class="adminbot-time-allocation-table__actions">
                        <button
                          type="button"
                          class="adminbot-time-allocation-table__remove"
                          aria-label=${`Remove ${task.name}`}
                          @click=${() => {
                            const rows = availabilityRows(member.availability);
                            rows.splice(task.sourceIndex, 1);
                            onAvailabilityChange(member.id, rows);
                          }}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 10v6m4-6v6"></path>
                          </svg>
                        </button>
                      </td>
                    `
                  : nothing}
              </tr>
            `;
          })}
        </tbody>
      </table>
      ${editable
        ? html`
            <button
              type="button"
              class="adminbot-time-allocation-table__add"
              @click=${() => {
                const newTask = defaultTaskRow(member, tasks);
                const storedCapacity = Number(member.hours_per_week);
                const availability = [...availabilityRows(member.availability), newTask];
                if (Number.isFinite(storedCapacity) && storedCapacity > 0) {
                  onAvailabilityChange(member.id, availability);
                } else {
                  onAvailabilityChange(member.id, availability, DEFAULT_WEEKLY_CAPACITY);
                }
              }}
            >
              <span aria-hidden="true">＋</span>
              Add task
            </button>
          `
        : nothing}
    </div>
  `;
}

export function renderAdminBotTimeAvailability(props: AdminBotTimeAvailabilityProps) {
  const emptyOptionLabel = props.loading
    ? t("adminbotTimeAvailability.loadingUsers")
    : t("adminbotTimeAvailability.selectUser");
  const selectedMember = props.members.find((member) => member.id === props.selectedMemberId);
  const storedAvailability = selectedMember ? availabilityRows(selectedMember.availability) : [];
  const tasks = selectedMember ? allocationTasksForMember(selectedMember) : [];
  const weeklyCapacity = Number(selectedMember?.hours_per_week);
  const hasWeeklyCapacity = Number.isFinite(weeklyCapacity) && weeklyCapacity > 0;
  const canEditSelectedMember =
    selectedMember !== undefined && selectedMember.id === props.signedInMemberId;
  const showReport = selectedMember !== undefined;
  const hasChartableStoredRows = storedAvailability.some(
    (row) => row.project !== "__open__" && Number(row.hours_per_week) > 0,
  );
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
        <label class="adminbot-form__field">
          <span class="card-title">${t("adminbotTimeAvailability.interval")}</span>
          <select
            aria-label=${t("adminbotTimeAvailability.interval")}
            .value=${props.viewInterval}
            @change=${(event: Event) =>
              props.onViewIntervalChange(
                (event.currentTarget as HTMLSelectElement).value as TimeAllocationInterval,
              )}
          >
            <option value="day">${t("adminbotTimeAvailability.day")}</option>
            <option value="week">${t("adminbotTimeAvailability.week")}</option>
            <option value="month">${t("adminbotTimeAvailability.month")}</option>
          </select>
        </label>
      </div>
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
      ${showReport && selectedMember
        ? html`
            <section class="adminbot-time-availability__report">
              <div class="adminbot-time-availability__report-header">
                <div>
                  <div class="card-title">${selectedMember.name}</div>
                  <div class="card-sub">${t("adminbotTimeAvailability.chartSubtitle")}</div>
                </div>
                ${hasWeeklyCapacity
                  ? html`
                      <span class="pill">
                        ${t("adminbotTimeAvailability.capacity", {
                          hours: formatNumber(weeklyCapacity),
                        })}
                      </span>
                    `
                  : nothing}
              </div>
              ${!hasWeeklyCapacity && hasChartableStoredRows
                ? html`
                    <div class="callout warning">
                      ${t("adminbotTimeAvailability.missingCapacity")}
                    </div>
                  `
                : nothing}
              <div class="adminbot-time-chart-wrap">
                ${renderTimeChart(
                  tasks,
                  selectedMember.name,
                  selectedMember.id,
                  props.viewInterval,
                )}
              </div>
              ${renderTaskTable(
                tasks,
                selectedMember,
                canEditSelectedMember,
                props.onAvailabilityChange,
              )}
            </section>
          `
        : html`
            <div class="adminbot-time-availability__empty">
              ${t("adminbotTimeAvailability.empty")}
            </div>
          `}
    </div>
  `;
}
