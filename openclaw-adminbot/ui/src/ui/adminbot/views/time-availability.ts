import { html, nothing, svg } from "lit";
import { i18n, t } from "../../../i18n/index.ts";
import type { AdminBotLabMember } from "../controllers/admin.ts";
import { availabilityRows } from "../data/availability.ts";

type TimeAllocationTask = {
  key: string;
  name: string;
  start: string;
  end: string;
  effort: number;
};

type TimeAllocationSegment = {
  start: string;
  end: string;
  label: string;
  allocations: Array<{ key: string; name: string; effort: number }>;
  total: number;
};

export type AdminBotTimeAvailabilityProps = {
  members: AdminBotLabMember[];
  loading: boolean;
  error: string | null;
  selectedMemberId: string;
  onMemberChange: (memberId: string) => void;
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

function formatPercentage(value: number): string {
  return new Intl.NumberFormat(i18n.getLocale(), {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value / 100);
}

function taskName(project: string | undefined): string {
  return project?.trim() || t("adminbotTimeAvailability.termBaseline");
}

function allocationTasksForMember(member: AdminBotLabMember): TimeAllocationTask[] {
  const capacity = Number(member.hours_per_week);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    return [];
  }
  return availabilityRows(member.availability).flatMap((row) => {
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
    return [
      {
        key: row.project ? `project:${row.project}` : "baseline",
        name: taskName(row.project),
        start: row.start,
        end: row.end,
        effort: (weeklyHours / capacity) * 100,
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

// Mirrors EffortStackChart.buildSegments: every start/end date is a breakpoint, and each
// consecutive pair becomes one stacked bar. Within a segment the active task set never changes,
// so it is safe to sum overlapping effort. Stored end dates are inclusive, so the exclusive
// boundary used for breakpoints and overlap tests is the next calendar day.
function allocationSegments(tasks: readonly TimeAllocationTask[]): TimeAllocationSegment[] {
  const categories = taskCategories(tasks);
  const breakpoints = [
    ...new Set(tasks.flatMap((task) => [task.start, exclusiveEnd(task.end)])),
  ].toSorted();

  const segments: TimeAllocationSegment[] = [];
  for (let index = 0; index < breakpoints.length - 1; index += 1) {
    const start = breakpoints[index];
    const end = breakpoints[index + 1];

    const byKey = new Map<string, number>();
    for (const task of tasks) {
      // Active while [task.start, exclusiveEnd(task.end)) overlaps this segment.
      if (task.start < end && exclusiveEnd(task.end) > start) {
        byKey.set(task.key, (byKey.get(task.key) ?? 0) + task.effort);
      }
    }
    const allocations = categories.flatMap((category) => {
      const effort = byKey.get(category.key);
      return effort ? [{ ...category, effort }] : [];
    });
    if (allocations.length === 0) {
      continue;
    }
    segments.push({
      start,
      end,
      label: `${shortDate(start)} → ${shortDate(end)}`,
      allocations,
      total: allocations.reduce((sum, allocation) => sum + allocation.effort, 0),
    });
  }
  return segments;
}

function yAxisMaximum(segments: readonly TimeAllocationSegment[]): number {
  const highestTotal = Math.max(100, ...segments.map((segment) => segment.total));
  return Math.max(100, Math.ceil(highestTotal / 10) * 10);
}

function renderTimeChart(tasks: readonly TimeAllocationTask[], memberName: string) {
  const segments = allocationSegments(tasks);
  const colors = taskColors(tasks);
  const categories = taskCategories(tasks);
  const yMaximum = yAxisMaximum(segments);
  const effortTicks = Array.from({ length: Math.floor(yMaximum / 25) + 1 }, (_, index) =>
    Math.min(yMaximum, index * 25),
  );
  if (effortTicks.at(-1) !== yMaximum) {
    effortTicks.push(yMaximum);
  }

  const chartWidth = Math.max(640, CHART_LEFT + CHART_RIGHT + segments.length * MIN_BAR_SLOT);
  const plotWidth = chartWidth - CHART_LEFT - CHART_RIGHT;
  const plotHeight = CHART_HEIGHT - CHART_TOP - CHART_BOTTOM;
  // Match EffortStackChart's barCategoryGap={0} / barGap={0}: adjacent periods touch.
  const barWidth = plotWidth / Math.max(1, segments.length);
  const y = (effort: number) => CHART_TOP + ((yMaximum - effort) / yMaximum) * plotHeight;
  const segmentSummary = segments
    .map((segment) =>
      t("adminbotTimeAvailability.segmentSummary", {
        start: tableDate(segment.start),
        end: tableDate(isoDate(dateMs(segment.end) - DAY_MS)),
        allocations: segment.allocations
          .map((allocation) => `${allocation.name} ${formatPercentage(allocation.effort)}`)
          .join(", "),
        total: formatPercentage(segment.total),
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
        ${effortTicks.map((effort) => {
          const tickY = y(effort);
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
            >${formatPercentage(effort)}</text>
          `;
        })}
        <line
          class="adminbot-time-chart__capacity-line"
          x1=${CHART_LEFT}
          x2=${chartWidth - CHART_RIGHT}
          y1=${y(100)}
          y2=${y(100)}
        ></line>
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
          let accumulatedEffort = 0;
          const bars = segment.allocations.map((allocation) => {
            const bottom = y(accumulatedEffort);
            accumulatedEffort += allocation.effort;
            const top = y(accumulatedEffort);
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
                  effort: formatPercentage(allocation.effort),
                  start: tableDate(segment.start),
                  end: tableDate(isoDate(dateMs(segment.end) - DAY_MS)),
                  total: formatPercentage(segment.total),
                })}</title>
              </rect>
            `;
          });
          const displayedTotal = Math.round(segment.total * 10) / 10;
          const totalClass =
            displayedTotal > 100
              ? "adminbot-time-chart__total adminbot-time-chart__total--over"
              : displayedTotal >= 90
                ? "adminbot-time-chart__total adminbot-time-chart__total--near"
                : "adminbot-time-chart__total";
          return svg`
            ${bars}
            <text
              class=${totalClass}
              x=${barX + barWidth / 2}
              y=${y(segment.total) - 8}
              text-anchor="middle"
            >${formatPercentage(segment.total)}</text>
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
    <div class="adminbot-time-chart__capacity-note">
      ${t("adminbotTimeAvailability.capacityNote")}
    </div>
  `;
}

function renderTaskTable(tasks: readonly TimeAllocationTask[]) {
  const colors = taskColors(tasks);
  return html`
    <div class="adminbot-time-allocation-table-wrap">
      <table class="adminbot-time-allocation-table">
        <thead>
          <tr>
            <th>${t("adminbotTimeAvailability.taskName")}</th>
            <th>${t("adminbotTimeAvailability.startDate")}</th>
            <th>${t("adminbotTimeAvailability.endDate")}</th>
            <th>${t("adminbotTimeAvailability.effort")}</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map(
            (task) => html`
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
                <td>${formatPercentage(task.effort)}</td>
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
  const tasks = selectedMember ? allocationTasksForMember(selectedMember) : [];
  const weeklyCapacity = Number(selectedMember?.hours_per_week);
  const hasWeeklyCapacity = Number.isFinite(weeklyCapacity) && weeklyCapacity > 0;
  const hasChartableStoredRows = storedAvailability.some(
    (row) => row.project !== "__open__" && Number(row.hours_per_week) > 0,
  );
  const noAllocationMessage =
    !hasWeeklyCapacity && hasChartableStoredRows
      ? t("adminbotTimeAvailability.missingCapacity")
      : t("adminbotTimeAvailability.noAllocations");
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
      </div>
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
      ${selectedMember && tasks.length > 0
        ? html`
            <section class="adminbot-time-availability__report">
              <div class="adminbot-time-availability__report-header">
                <div>
                  <div class="card-title">${selectedMember.name}</div>
                  <div class="card-sub">${t("adminbotTimeAvailability.chartSubtitle")}</div>
                </div>
                <span class="pill">
                  ${t("adminbotTimeAvailability.capacity", {
                    hours: formatNumber(weeklyCapacity),
                  })}
                </span>
              </div>
              <div class="adminbot-time-chart-wrap">
                ${renderTimeChart(tasks, selectedMember.name)}
              </div>
              ${renderTaskTable(tasks)}
            </section>
          `
        : selectedMember
          ? html`<div class="adminbot-time-availability__empty">${noAllocationMessage}</div>`
          : html`
              <div class="adminbot-time-availability__empty">
                ${t("adminbotTimeAvailability.empty")}
              </div>
            `}
    </div>
  `;
}
