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
import { html, nothing } from "lit";
import { i18n, t } from "../../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../external-link.ts";
import { icons } from "../../icons.ts";
import type { AdminBotLabMember } from "../controllers/admin.ts";
import {
  availabilityRows,
  milestoneRows,
  timeOffRows,
  tripRows,
  whereBins,
  type AvailabilityRow,
  type MilestoneRow,
  type TimeOffRow,
  type TripRow,
} from "../data/availability.ts";
import {
  allUpcomingConferences,
  aoeInstantMs,
  MS_DAY,
  upcomingMajorDeadlines,
  urgencyOf,
} from "../data/deadline-time.ts";
import {
  AOE_TIMEZONE,
  localTimezone,
  timezoneOptions,
} from "../data/timezones.ts";
import { renderMemberSelect } from "./member-select.ts";
import {
  renderTrips,
  renderWhereStrip,
  type TripDraft,
} from "./time-availability.trips.ts";
import {
  renderTimeAllocationChart,
  type TimeAllocationInterval,
  type TimeAllocationTask as ChartTask,
} from "./time-allocation-chart.ts";

type TimeAllocationTask = {
  key: string;
  name: string;
  start: string;
  end: string;
  /** Hours per week this commitment asks for. */
  hours: number;
  /** The member's own note on the row, carried so the chart can show it too, not just the table. */
  note?: string;
};

/** One bar: a calendar bin and the hours booked inside it. */
type TimeAllocationSegment = {
  start: string;
  end: string;
  label: string;
  allocations: Array<{
    key: string;
    name: string;
    hours: number;
    /**
     * Notes from the commitments that fed this piece of the stack. A list because one key is one
     * project, and a project can be several rows with different dates and a note on each.
     */
    notes: string[];
  }>;
  total: number;
  /** True when time off covers the whole bin, so nothing is bookable in it. */
  suppressed: boolean;
  /** Calendar days the bin spans, which is what the capacity line is prorated over. */
  days: number;
};

/**
 * The unit the chart and tables quote hours in. Purely a display choice — see the header: it never
 * changes the bars, only the number written on them.
 */
/**
 * How much calendar the chart shows, and therefore how wide one bar is.
 *
 * Fixed bins, not data-derived segments. A schedule is read against the calendar -- "what does my
 * next month look like" -- and a bar per change in commitments cannot answer that: two bars might
 * be a day and a year, side by side and the same width. Each range is a whole number of equal bins
 * so the x axis is a ruler.
 */
export type TimeAvailabilityRange = "week" | "month" | "year";

export const TIME_AVAILABILITY_RANGES: readonly TimeAvailabilityRange[] = ["week", "month", "year"];

type RangeShape = {
  /** How many bars. */
  bins: number;
  /** Days per bar, for week/month. Months vary in length, so "year" is handled by the calendar. */
  days?: number;
  /** Whether bins step by calendar month rather than by a fixed day count. */
  monthly?: boolean;
};

const RANGE_SHAPES: Record<TimeAvailabilityRange, RangeShape> = {
  week: { bins: 7, days: 1 },
  month: { bins: 4, days: 7 },
  year: { bins: 12, monthly: true },
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
  /**
   * The wall-clock cutoff on `date`, "HH:MM", and the zone it is read in.
   *
   * Both optional, and refused unless they arrive together: a bare time is the mistake the pair
   * exists to prevent. A member typing "23:59" for a deadline stated Anywhere-on-Earth means
   * something seventeen hours later than the same digits read in Toronto, and a stored number with
   * no zone cannot be corrected later because nobody knows which one was meant.
   *
   * Left blank the milestone is a whole-day deadline, which is what every row was before this.
   */
  time: string;
  timezone: string;
};

export const EMPTY_MILESTONE_DRAFT: MilestoneDraft = {
  date: "",
  label: "",
  link: "",
  time: "",
  // Prefilled with the browser's own zone rather than blank. Someone who types a time almost
  // always means their own clock, and a zone they have to go and find first is how a field ends up
  // answered wrong or left empty.
  timezone: localTimezone(),
};

/** Everything the editor may rewrite. An omitted list is left as it is. */
export type SchedulePatch = {
  availability?: AvailabilityRow[];
  time_off?: TimeOffRow[];
  milestones?: MilestoneRow[];
  trips?: TripRow[];
  /** Snapshot conferences this member has hidden from their own panel. */
  dismissed_deadlines?: string[];
  /**
   * The overall note, sent alone so saving prose can never rewrite a list.
   *
   * The three lists above are the schedule as data -- dates, hours, categories -- and there are
   * situations no combination of rows can state: a custody week that moves, a visa appointment that
   * may or may not happen, a treatment that makes some weeks unpredictable. Those need a sentence
   * to an admin, and without somewhere to put it people either encode it in a row's own note (where
   * it is attached to a commitment that will later be deleted) or say nothing at all.
   */
  availability_notes?: string;
};

export type AdminBotTimeAvailabilityProps = {
  members: AdminBotLabMember[];
  loading: boolean;
  error: string | null;
  selectedMemberId: string;
  onMemberChange: (memberId: string) => void;
  range: TimeAvailabilityRange;
  onRangeChange: (range: TimeAvailabilityRange) => void;
  /** The signed-in member. The editor renders only when this matches the selected member. */
  viewerMemberId: string | null;
  /**
   * Whether the viewer is an admin, which is what decides whose schedule they may read at all.
   *
   * A schedule is holidays, courses, other jobs and -- in the overall note -- whatever the member
   * wrote up about their circumstances. That is planning data for the people who plan, so a plain
   * member sees their own and nothing else: the picker is not offered to them, and the service
   * strips the schedule fields from every other member's record on the way out
   * (adminBotScheduleMemberFields), so this is the affordance for a rule already enforced there.
   */
  viewerIsAdmin: boolean;
  /** The trips log's draft, kept out here so a re-render cannot wipe half-typed input. */
  tripDraft?: TripDraft;
  onTripDraftChange?: (draft: TripDraft) => void;
  /** The Jinesis-commitment form's draft. Its category is always "jinesis". */
  draft: TimeAvailabilityDraft;
  onDraftChange: (draft: TimeAvailabilityDraft) => void;
  /** The time-away form's draft, kept separate so the two forms cannot clear each other. */
  awayDraft: TimeAvailabilityDraft;
  onAwayDraftChange: (draft: TimeAvailabilityDraft) => void;
  milestoneDraft: MilestoneDraft;
  onMilestoneDraftChange: (draft: MilestoneDraft) => void;
  /** The overall note while it is being edited; null means "showing what is stored". */
  notesDraft: string | null;
  onNotesDraftChange: (draft: string | null) => void;
  onSaveSchedule: (memberId: string, patch: SchedulePatch) => void;
  saving: boolean;
};

const DAY_MS = 86_400_000;
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

// How many rows the side table shows before it stops being a summary.
const BIG_DEADLINE_LIMIT = 6;
// Four, and archival only.
//
// Two was "what is next" -- fine on a dashboard card, too short here, where the panel sits beside a
// timeline someone is planning a term against and the question is which submission cycles fall
// inside it. Archival only because that is the split the planning turns on: an archival deadline
// consumes the paper, so it is a commitment to schedule around, while a workshop is an option. The
// full board still lists every venue of both kinds.
const CONFERENCE_DEADLINE_COUNT = 4;

/**
 * How far away a deadline is, counted in calendar days.
 *
 * Deliberately not derived from the AoE instant the urgency band uses: that instant is the end of
 * the deadline day shifted into UTC-12, so subtracting it from "now" and rounding put a date two
 * days out at "In 3 days" and every conference two days further away than a calendar says. The
 * band still reads the true cutoff; the label answers the question a person asks of a calendar.
 */
function daysAwayLabel(dateIso: string, now: number): string {
  const target = Date.parse(`${dateIso}T00:00:00Z`);
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.round((target - today) / MS_DAY);
  if (days <= 0) {
    return t("adminbotTimeAvailability.milestones.dueToday");
  }
  if (days === 1) {
    return t("adminbotTimeAvailability.milestones.dueTomorrow");
  }
  return t("adminbotTimeAvailability.milestones.dueInDays", { days: String(days) });
}

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
/**
 * Hours a weekly rate contributes to a stretch of `days`.
 *
 * Everything is stored as hours per week, so a bin's height is that rate prorated over the days the
 * bin actually covers. This is what makes the three ranges comparable: a bar is always "hours
 * committed inside this bar", whether the bar is a day, a week or a month.
 */
function hoursOver(weeklyHours: number, days: number): number {
  return (weeklyHours * days) / 7;
}


/**
 * A bar's total, plus the share of the member's capacity it uses when they have declared one.
 *
 * Capacity is the headroom reading: without it a chart scaled to its own tallest bar makes every
 * member look equally busy. With it, half a week reads as half a week.
 */

/**
 * A bar piece's hover text, with the member's note on it when there is one.
 *
 * The note is the half of a commitment the numbers cannot carry — "only until the submission",
 * "shared with Mei" — so the chart says it in the same breath as the hours rather than making the
 * reader go find the row in the table underneath. `<title>` is plain text, so several notes are
 * joined rather than laid out.
 */

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
/**
 * Partial time-away rows as chart series.
 *
 * Only the ones that state their hours. A whole-day row is not a series -- it removes days from the
 * bin rather than stacking on it -- and a partial row written before the form asked for a number
 * still has nothing to draw, so it stays where it always was: in the table, not on the chart.
 *
 * They stack alongside the Jinesis work because that is what they are competing with. A member with
 * thirty hours of lab work and twelve hours of coursework is not a member with thirty hours of lab
 * work, and drawing only the first of those was the reason capacity on this chart read as headroom
 * that did not exist.
 */
function awayTasks(rows: readonly TimeOffRow[]): TimeAllocationTask[] {
  return rows.flatMap((row) => {
    const hours = row.hours_per_week;
    if (row.availability !== "partial" || !hours || !Number.isFinite(hours) || hours <= 0) {
      return [];
    }
    const start = dateMs(row.start);
    const end = dateMs(row.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      return [];
    }
    const name = timeOffLabel(row);
    return [
      {
        // Namespaced so a course called "Thesis" can never merge into a Jinesis project of the
        // same name, which would put non-lab hours under a lab project's color and total.
        key: `away:${name}`,
        name,
        start: row.start,
        end: row.end,
        hours,
        ...(row.note?.trim() ? { note: row.note.trim() } : {}),
      },
    ];
  });
}

function suppressedRanges(rows: readonly TimeOffRow[]): Array<{ start: string; end: string }> {
  return rows
    .filter((row) => row.availability !== "partial")
    .map((row) => ({ start: row.start, end: exclusiveEnd(row.end) }));
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
        ...(row.note?.trim() ? { note: row.note.trim() } : {}),
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
 */
/** The bins a range covers, starting from today. */
export function rangeBins(range: TimeAvailabilityRange, now: number): Array<{
  startMs: number;
  endMs: number;
  label: string;
}> {
  const shape = RANGE_SHAPES[range];
  const bins: Array<{ startMs: number; endMs: number; label: string }> = [];
  // Anchored to today rather than to a calendar boundary: the question is "what is coming", so the
  // first bar should be now, not the leftover tail of a week that started on Monday.
  let cursor = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    shape.monthly ? 1 : new Date(now).getUTCDate(),
  );
  for (let index = 0; index < shape.bins; index += 1) {
    const next = shape.monthly
      ? Date.UTC(new Date(cursor).getUTCFullYear(), new Date(cursor).getUTCMonth() + 1, 1)
      : cursor + (shape.days ?? 1) * DAY_MS;
    bins.push({ startMs: cursor, endMs: next, label: binLabel(range, cursor) });
    cursor = next;
  }
  return bins;
}

function binLabel(range: TimeAvailabilityRange, startMs: number): string {
  const date = new Date(startMs);
  if (range === "year") {
    return new Intl.DateTimeFormat(i18n.getLocale(), { month: "short", timeZone: "UTC" }).format(
      date,
    );
  }
  if (range === "week") {
    return new Intl.DateTimeFormat(i18n.getLocale(), { weekday: "short", timeZone: "UTC" }).format(
      date,
    );
  }
  return shortDate(isoDate(startMs));
}

/** Days of [startMs, endMs) that a task's inclusive date range covers. */
function overlapDays(task: TimeAllocationTask, startMs: number, endMs: number): number {
  const from = Math.max(dateMs(task.start), startMs);
  const to = Math.min(dateMs(exclusiveEnd(task.end)), endMs);
  return Math.max(0, (to - from) / DAY_MS);
}

function suppressedDays(
  ranges: ReadonlyArray<{ start: string; end: string }>,
  startMs: number,
  endMs: number,
): number {
  // Ranges can overlap, so union them by day rather than summing, or two holidays on the same week
  // would cancel more work than the member is actually away for.
  const days = new Set<number>();
  for (const range of ranges) {
    const from = Math.max(dateMs(range.start), startMs);
    const to = Math.min(dateMs(range.end), endMs);
    for (let day = from; day < to; day += DAY_MS) {
      days.add(day);
    }
  }
  return days.size;
}

/**
 * Hours committed inside each bin of the range.
 *
 * A task contributes its weekly rate prorated over the days it actually covers in the bin, so a
 * commitment that starts midweek raises that week by half rather than by all of it. Whole-day time
 * off removes days from the bin before anything is booked against it -- that is the holiday
 * override, and it is why a bin can be `off` (nothing bookable left) rather than merely empty.
 */
export function allocationBins(
  tasks: readonly TimeAllocationTask[],
  timeOff: readonly TimeOffRow[],
  range: TimeAvailabilityRange,
  now: number,
): TimeAllocationSegment[] {
  const categories = taskCategories(tasks);
  const suppressed = suppressedRanges(timeOff);
  return rangeBins(range, now).map((bin) => {
    const binDays = (bin.endMs - bin.startMs) / DAY_MS;
    const away = suppressedDays(suppressed, bin.startMs, bin.endMs);
    const workable = Math.max(0, binDays - away);
    const byKey = new Map<string, number>();
    // Only from the rows that actually contribute here, so a bar's note is the note on the work in
    // front of you rather than everything ever written against that project.
    const notesByKey = new Map<string, Set<string>>();
    if (workable > 0) {
      for (const task of tasks) {
        const covered = overlapDays(task, bin.startMs, bin.endMs);
        if (covered <= 0) {
          continue;
        }
        // Scale the covered days down by whatever fraction of the bin is time off, so a week with
        // two days of holiday books five-sevenths of its commitments.
        const effective = covered * (workable / binDays);
        byKey.set(task.key, (byKey.get(task.key) ?? 0) + hoursOver(task.hours, effective));
        if (task.note) {
          const notes = notesByKey.get(task.key) ?? new Set<string>();
          notes.add(task.note);
          notesByKey.set(task.key, notes);
        }
      }
    }
    const allocations = categories.flatMap((category) => {
      const hours = byKey.get(category.key);
      return hours
        ? [{ ...category, hours, notes: [...(notesByKey.get(category.key) ?? [])] }]
        : [];
    });
    return {
      start: isoDate(bin.startMs),
      end: isoDate(bin.endMs),
      label: bin.label,
      allocations,
      total: allocations.reduce((sum, allocation) => sum + allocation.hours, 0),
      suppressed: away >= binDays && binDays > 0,
      days: binDays,
    };
  });
}



/**
 * The chart.
 *
 * Read left to right as a calendar: equal bins, one bar each, the soonest first. Everything on it
 * answers one of two questions -- how much is booked, and how that compares to what the member said
 * they have. So capacity is a line across the whole plot rather than a number in a caption, the
 * portion of a bar above that line is the only place the danger color appears, and a bin the member
 * is entirely away for is drawn as absence rather than as a zero.
 */
// The hand-rolled SVG chart that stood here was replaced by the recharts one the time-allocation
// MVP shipped (see time-allocation-chart.ts). allocationBins and the segment types stay: the
// tables and the tests read them, and they are what the chart's task list is derived from.

function renderRangeSwitch(props: AdminBotTimeAvailabilityProps) {
  return html`
    <div
      class="time-chart__range"
      role="group"
      aria-label=${t("adminbotTimeAvailability.rangeLabel")}
    >
      ${TIME_AVAILABILITY_RANGES.map(
        (range) => html`
          <button
            type="button"
            class="time-chart__range-option"
            data-testid=${`time-availability-range-${range}`}
            aria-pressed=${props.range === range}
            @click=${() => props.onRangeChange(range)}
          >
            ${t(`adminbotTimeAvailability.range.${range}`)}
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

/**
 * A commitment's note, as a disclosure row under the commitment it belongs to.
 *
 * A note is free text and often a sentence or two, so a column of its own would have to choose
 * between wrapping the table into prose and truncating away the thing the note was written to say.
 * `<details>` rather than a toggle button on purpose: it keeps "which notes are open" in the DOM,
 * so opening one survives a re-render without threading another field through the app state, and
 * the row is keyboard-reachable and announced as a disclosure without any ARIA of ours.
 */
function renderNoteRow(note: string | undefined, columns: number) {
  const text = note?.trim();
  if (!text) {
    return nothing;
  }
  return html`
    <tr class="adminbot-time-allocation-table__note-row">
      <td colspan=${columns}>
        <details class="adminbot-time-allocation-table__note">
          <summary>${t("adminbotTimeAvailability.tables.note")}</summary>
          <p>${text}</p>
        </details>
      </td>
    </tr>
  `;
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
  // A partial row has to say by how much. Without a figure it is the claim "around, but less",
  // which no chart can draw and no admin can plan against -- a twelve-hour course and a standing
  // Tuesday call used to record the identical row.
  if (draft.category !== "jinesis" && !draft.wholeDay) {
    const away = Number(draft.hoursPerWeek);
    if (!draft.hoursPerWeek.trim() || !Number.isFinite(away) || away <= 0 || away > 168) {
      return t("adminbotTimeAvailability.form.errorAwayHours");
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
  // A time with no zone is refused rather than stored and guessed at later; see MilestoneDraft.
  // The other way round is allowed to pass here because the zone is prefilled and a member who
  // never touches the time field would otherwise meet an error about a control they did not use --
  // milestoneToRow drops a zone with no time.
  if (draft.time && !draft.timezone.trim()) {
    return t("adminbotTimeAvailability.milestones.errorTimezone");
  }
  return linkError(draft.link);
}

/** The stored row a milestone draft becomes. The clock is stored only when it is a complete pair. */
export function milestoneToRow(draft: MilestoneDraft): MilestoneRow {
  const link = draft.link.trim();
  const time = draft.time.trim();
  const timezone = draft.timezone.trim();
  return {
    date: draft.date,
    label: draft.label.trim(),
    ...(link ? { link } : {}),
    ...(time && timezone ? { time, timezone } : {}),
  };
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
        // Only on a partial row: a whole-day row zeroes the week by definition, so hours on it
        // would be a second answer to a question already settled.
        ...(draft.wholeDay ? {} : { hours_per_week: Number(draft.hoursPerWeek) }),
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
  // Rendered inside the actions row, before the submit button. The away form uses it to put its
  // hint on the same line as the action it explains, left of the button.
  footer?: unknown;
};

function renderCommitmentForm(form: CommitmentFormProps) {
  const { props, existing, draft, onDraftChange, testId, titleKey, head, footer } = form;
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
          ${footer ?? nothing}
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
      ${draft.wholeDay
        ? nothing
        : html`<label class="adminbot-form__field">
            <span>${t("adminbotTimeAvailability.form.awayHours")}</span>
            <input
              type="number"
              min="0.5"
              max="168"
              step="0.5"
              required
              data-testid="time-away-hours"
              .value=${draft.hoursPerWeek}
              @input=${field("hoursPerWeek")}
            />
          </label>`}
    `,
    footer: html`<p class="adminbot-time-availability__form-hint">
      ${props.awayDraft.wholeDay
        ? t("adminbotTimeAvailability.form.wholeDayHint")
        : t("adminbotTimeAvailability.form.partialHint")}
    </p>`,
  });
}

// The service's own ceiling (MAX_AVAILABILITY_NOTES_LENGTH in kernel/service.ts). Enforced on the
// control so a long note is stopped while it is being typed rather than rejected after a save.
const MAX_NOTES_LENGTH = 2000;

/**
 * The overall note: one free-text field about the whole schedule, addressed to the admins.
 *
 * Not a fourth kind of row. Rows answer "when and how much"; this answers "what should someone
 * reading my rows know that they cannot see in them". It is deliberately outside the three add
 * forms and above the tables, because it is context for everything below it rather than an entry in
 * any one list -- and it saves on its own button rather than autosaving, since a half-written
 * sentence about someone's circumstances should not reach an admin's screen.
 *
 * Read access is the same rule as the rest of the schedule: the member, and admins. A non-admin
 * looking at someone else's page never gets here, and never receives the field either.
 */
function renderOverallNotes(
  props: AdminBotTimeAvailabilityProps,
  stored: string,
  editable: boolean,
) {
  const draft = props.notesDraft;
  const value = draft ?? stored;
  if (!editable) {
    // Read-only for an admin looking at someone else's schedule. Absent rather than an empty box:
    // "nothing written" is a fact about the member, not a control to offer someone who cannot type
    // in it.
    if (!stored.trim()) {
      return nothing;
    }
    return html`
      <section class="adminbot-time-availability__notes" data-testid="time-availability-notes">
        <div class="card-sub">${t("adminbotTimeAvailability.notes.title")}</div>
        <p
          class="adminbot-time-availability__notes-text"
          data-testid="time-availability-notes-text"
        >
          ${stored}
        </p>
      </section>
    `;
  }
  const dirty = draft !== null && draft !== stored;
  return html`
    <section class="adminbot-time-availability__notes" data-testid="time-availability-notes">
      <div class="card-sub">${t("adminbotTimeAvailability.notes.title")}</div>
      <p class="adminbot-time-availability__form-hint">
        ${t("adminbotTimeAvailability.notes.hint")}
      </p>
      <form
        class="adminbot-form adminbot-time-availability__notes-form"
        @submit=${(event: Event) => {
          event.preventDefault();
          props.onSaveSchedule(props.selectedMemberId, { availability_notes: value.trim() });
        }}
      >
        <label class="adminbot-form__field">
          <span class="sr-only">${t("adminbotTimeAvailability.notes.title")}</span>
          <textarea
            rows="4"
            maxlength=${MAX_NOTES_LENGTH}
            data-testid="time-availability-notes-input"
            placeholder=${t("adminbotTimeAvailability.notes.placeholder")}
            .value=${value}
            @input=${(event: Event) =>
              props.onNotesDraftChange((event.currentTarget as HTMLTextAreaElement).value)}
          ></textarea>
        </label>
        <div class="adminbot-time-availability__form-actions">
          <button
            type="submit"
            class="btn primary"
            data-testid="time-availability-notes-save"
            ?disabled=${props.saving || !dirty}
          >
            ${props.saving
              ? t("adminbotTimeAvailability.form.saving")
              : t("adminbotTimeAvailability.notes.submit")}
          </button>
        </div>
      </form>
    </section>
  `;
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
    <section class="adminbot-time-availability__editor" data-testid="time-availability-milestone-editor">
      <div class="card-title">${t("adminbotTimeAvailability.form.milestoneTitle")}</div>
      <p class="adminbot-time-availability__form-hint">
        ${t("adminbotTimeAvailability.milestones.formHint")}
      </p>
      <form
        class="adminbot-form adminbot-time-availability__form adminbot-time-availability__milestone-form"
        data-testid="time-availability-milestone-form"
        @submit=${(event: Event) => {
          event.preventDefault();
          if (milestoneDraftError(draft)) {
            return;
          }
          props.onSaveSchedule(props.selectedMemberId, {
            milestones: [...existing, milestoneToRow(draft)],
          });
        }}
      >
        <label class="adminbot-form__field">
          <span>${t("adminbotTimeAvailability.milestones.date")}</span>
          <input type="date" .value=${draft.date} @input=${field("date")} />
        </label>
        <!-- Time and zone sit together and immediately after the date, because they are one answer
           split across three controls. Both are optional: a thesis deadline is usually a day, and
           forcing a minute onto it would make people invent one. -->
        <label class="adminbot-form__field">
          <span>${t("adminbotTimeAvailability.milestones.time")}</span>
          <input
            type="time"
            data-testid="time-availability-milestone-time"
            .value=${draft.time}
            @input=${field("time")}
          />
        </label>
        <label class="adminbot-form__field">
          <span>${t("adminbotTimeAvailability.milestones.timezone")}</span>
          <!-- A select rather than a datalist: one zone per form, and a select gives a dropdown
             whose arrow sits where a dropdown's arrow is supposed to. Only the common zones are
             offered -- six hundred slash-and-underscore names are a wall of text nobody scrolls --
             and the viewer's own zone leads, labelled as theirs. -->
          <select
            data-testid="time-availability-milestone-timezone"
            .value=${draft.timezone}
            @change=${(event: Event) => {
              const zone = (event.currentTarget as HTMLSelectElement).value;
              props.onMilestoneDraftChange({ ...draft, timezone: zone });
            }}
          >
            ${timezoneOptions(draft.timezone).map(
              (group) => html`<optgroup label=${group.label}>
                ${group.options.map(
                  (option) => html`<option value=${option.zone}>${option.label}</option>`,
                )}
              </optgroup>`,
            )}
          </select>
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
        <div class="adminbot-time-availability__form-actions">
          ${error && touched
            ? html`<span class="adminbot-time-availability__form-error" role="alert"
                >${error}</span
              >`
            : nothing}
          <button
            type="submit"
            class="btn primary"
            data-testid="time-availability-milestone-add"
            ?disabled=${props.saving || error !== null}
          >
            ${t("adminbotTimeAvailability.milestones.submit")}
          </button>
        </div>
      </form>
    </section>
  `;
}

/**
 * How a "HH:MM in <zone>" wall clock lands on the real timeline.
 *
 * Not `Date.parse` with an offset appended: the offset for a zone is not a constant, and half the
 * deadlines in a research year fall on the wrong side of a daylight-saving change from the one
 * a fixed offset would have been read at. Asked of Intl at the instant in question instead, then
 * asked again at the corrected instant -- the second pass only matters when the first guess landed
 * on the other side of a transition, which is exactly the case a single pass gets wrong.
 */
function zoneOffsetMs(instant: number, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((candidate) => candidate.type === type)?.value);
    const asUtc = Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      // Intl can render midnight as hour 24 under hour12:false; %24 folds it back onto the day
      // Date.UTC already has from the date parts.
      part("hour") % 24,
      part("minute"),
      part("second"),
    );
    return asUtc - instant;
  } catch {
    return Number.NaN;
  }
}

function zonedInstantMs(date: string, time: string, timezone: string): number {
  const naive = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(naive)) {
    return Number.NaN;
  }
  let instant = naive;
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = zoneOffsetMs(instant, timezone);
    if (!Number.isFinite(offset)) {
      return Number.NaN;
    }
    instant = naive - offset;
  }
  return instant;
}

/** The instant a milestone actually falls at: its stated clock, or the end of its day. */
function milestoneInstant(row: MilestoneRow): number {
  if (row.time && row.timezone) {
    const exact = zonedInstantMs(row.date, row.time, row.timezone);
    if (Number.isFinite(exact)) {
      return exact;
    }
  }
  // A date with no time is read as the end of that day, so "today" stays today rather than
  // turning critical at midnight.
  return aoeInstantMs(`${row.date} 23:59:59`);
}

/** "23:59 AoE" / "17:00 America/Toronto", or nothing for a whole-day deadline. */
function clockLabel(time: string | undefined, timezone: string | undefined) {
  if (!time || !timezone) {
    return nothing;
  }
  const zone =
    timezone === AOE_TIMEZONE ? t("adminbotTimeAvailability.milestones.aoeZone") : timezone;
  return html`<span class="adminbot-time-availability__deadline-clock">${time} ${zone}</span>`;
}

/**
 * A venue the member could add to their own panel.
 *
 * Everything upcoming in the snapshot except what the panel already shows: the four automatic rows
 * are excluded because an "add" list whose first four entries are the four rows above it answers
 * the wrong question, and so is anything already on the member's own list.
 *
 * Deliberately wider than the four. Those are archival conferences, which is the right default and
 * a bad restriction -- the venue somebody actually needs on their timeline is as often a workshop
 * with its own date, or the fifth conference down. Narrowing the picker to the same rule that fills
 * the panel would leave it offering nothing exactly when the panel was already enough.
 */
function addableVenues(
  now: number,
  milestones: readonly MilestoneRow[],
  dismissed: readonly string[],
) {
  const hidden = new Set(dismissed.map((name) => name.trim()));
  const shown = new Set(
    upcomingMajorDeadlines(now, CONFERENCE_DEADLINE_COUNT, { archivalOnly: true })
      .filter((entry) => !hidden.has(entry.venue.name.trim()))
      .map((entry) => entry.venue.id),
  );
  // Matched on the label because that is what an added venue is stored as -- the milestone list
  // holds no venue id, and inventing one would mean a second identity for the same row.
  const added = new Set(milestones.map((row) => row.label.trim()));
  // Conferences only. The snapshot is 107 entries and 101 of them are workshops sharing a handful
  // of instants, so an all-venues picker was a hundred NeurIPS workshops with the conference
  // somebody actually wanted buried among them.
  return allUpcomingConferences(now).filter(
    (entry) => !shown.has(entry.venue.id) && !added.has(entry.venue.name.trim()),
  );
}

/**
 * The "add another conference" control.
 *
 * The four nearest archival deadlines arrive on their own, which covers the common case and none of
 * the others: a member submitting to a venue in the sixth slot, or to one the lab does not treat as
 * major, had no way to put it on their own timeline short of retyping the date as a personal
 * milestone and getting the AoE cutoff wrong. Picking it here copies the snapshot's own date, time
 * and zone onto their milestone list, so the row is exact and it is theirs -- removable, unlike the
 * four the panel shows on everyone's page.
 *
 * The selection lives in the DOM rather than in app state on purpose: it is discarded the moment it
 * is used, and a draft that survives a re-render would outlive the reason anyone chose it.
 */
function renderAddConference(
  props: AdminBotTimeAvailabilityProps,
  milestones: readonly MilestoneRow[],
  now: number,
  dismissed: readonly string[],
) {
  const options = addableVenues(now, milestones, dismissed);
  if (!options.length) {
    return nothing;
  }
  return html`
    <!-- Styled as one of the tab's editors and deliberately not classed as one: it lives in the
         deadlines panel, above them, and .adminbot-time-availability__form is how the commitment
         form is found. Sharing that class would have made "the form" ambiguous. -->
    <section
      class="adminbot-time-availability__deadline-add"
      data-testid="time-availability-add-conference-section"
    >
      <div class="card-title">${t("adminbotTimeAvailability.milestones.addConference")}</div>
      <p class="adminbot-time-availability__form-hint">
        ${t("adminbotTimeAvailability.milestones.addConferenceHint")}
      </p>
    <form
      class="adminbot-form adminbot-time-availability__deadline-form"
      data-testid="time-availability-add-conference"
      @submit=${(event: Event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const select = form.querySelector("select");
        const picked = options.find((entry) => entry.venue.id === select?.value);
        if (!picked) {
          return;
        }
        const { venue } = picked;
        props.onSaveSchedule(props.selectedMemberId, {
          milestones: [
            ...milestones,
            {
              date: venue.deadline_aoe.slice(0, 10),
              label: venue.name,
              // The snapshot states every deadline in AoE, so the clock is copied across with the
              // zone that makes it mean what the conference said.
              time: venue.deadline_aoe.slice(11, 16),
              timezone: AOE_TIMEZONE,
              ...(venue.link ? { link: venue.link } : {}),
            },
          ],
        });
      }}
    >
      <label class="adminbot-form__field" for="time-availability-conference-pick">
        <span>${t("adminbotTimeAvailability.milestones.conference")}</span>
        <select
          id="time-availability-conference-pick"
          data-testid="time-availability-conference-pick"
        >
          ${options.map(
            (entry) => html`
              <option value=${entry.venue.id}>
                ${entry.venue.name} · ${tableDate(entry.venue.deadline_aoe.slice(0, 10))}
              </option>
            `,
          )}
        </select>
      </label>
      <div class="adminbot-time-availability__form-actions">
        <button
          type="submit"
          class="btn primary"
          data-testid="time-availability-conference-add"
          ?disabled=${props.saving}
        >
          <span aria-hidden="true">${icons.plus}</span>
          ${t("adminbotTimeAvailability.milestones.submitConference")}
        </button>
      </div>
    </form>
    </section>
  `;
}

/**
 * The side panel: the four nearest archival conference deadlines, plus this member's own dates.
 *
 * It briefly listed only the member's own rows. That went too far in the other direction: the
 * conference dates are what a term is planned around, and a timeline with no marker for the next
 * submission cycle makes a member work out for themselves whether the block they are looking at
 * lands before or after it. What made the earlier version unreadable was volume and sameness --
 * every workshop under every conference, identical on all 159 schedules. Four archival conferences
 * is the part that is actually shared, and everything else is one click away on the Deadlines tab
 * or added deliberately through the picker below.
 */
function renderBigDeadlines(
  milestones: readonly MilestoneRow[],
  props: AdminBotTimeAvailabilityProps,
  editable: boolean,
  dismissed: readonly string[],
) {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  // upcomingMajorDeadlines is the same helper the Deadlines board and the dashboard summary use,
  // so the three surfaces can never disagree about which conference is next.
  const hidden = new Set(dismissed.map((name) => name.trim()));
  const conferences = upcomingMajorDeadlines(now, CONFERENCE_DEADLINE_COUNT, {
    archivalOnly: true,
  })
    .filter((entry) => !hidden.has(entry.venue.name.trim()))
    .map((entry) => ({
    date: entry.venue.deadline_aoe.slice(0, 10),
    instant: entry.instant,
    label: entry.venue.name,
    link: entry.venue.link,
    time: entry.venue.deadline_aoe.slice(11, 16),
      timezone: AOE_TIMEZONE,
      own: false,
    }));
  const mine = milestones
    .filter((row) => row.date >= today)
    .map((row) => ({
      date: row.date,
      instant: milestoneInstant(row),
      label: row.label,
      link: row.link,
      time: row.time,
      timezone: row.timezone,
      own: true,
    }))
    .slice(0, BIG_DEADLINE_LIMIT);
  // Conferences are added after the member's own rows are capped, so a full personal list can
  // never push them off the banner. Sorted by instant rather than by date so two things on the
  // same day fall in the order they actually happen.
  const rows = [...mine, ...conferences].toSorted((left, right) => left.instant - right.instant);

  return html`
    <aside class="adminbot-time-availability__deadlines" data-testid="time-availability-deadlines">
      <div class="card-title">${t("adminbotTimeAvailability.milestones.title")}</div>
      <p class="adminbot-time-availability__deadline-hint">
        ${t("adminbotTimeAvailability.milestones.hint")}
      </p>
      <ul class="adminbot-time-availability__deadline-list">
        ${rows.map(
          (row) => html`
            <li data-own=${String(row.own)} data-urgency=${urgencyOf(row.instant, now)}>
              <!-- Three explicit rows rather than grid placement per span. The link and the remove
                   button were both pinned to the same cell, so they drew on top of each other, and
                   the AoE clock was held on one line inside a 15rem tile, so it was cut off at the
                   border. Countdown and actions share the top row; the name and the date each get
                   their own and may wrap. -->
              <div class="adminbot-time-availability__deadline-top">
                <span class="adminbot-time-availability__deadline-away">
                  ${daysAwayLabel(row.date, now)}
                </span>
                <span class="adminbot-time-availability__deadline-actions">
                  ${renderLink(row.link)}
                  <!-- Both kinds of row can go. A member's own row is deleted; one of the lab's
                       four is hidden for this member only, since the snapshot is shared and
                       nobody's panel should edit everyone else's. Re-adding it from the picker
                       below brings it back as their own row. -->
                  ${editable
                ? html`<button
                    type="button"
                    class="btn btn--sm"
                    data-testid=${`time-availability-deadline-remove-${row.own ? "own" : "preset"}`}
                    ?disabled=${props.saving}
                    title=${row.own ? "" : t("adminbotTimeAvailability.milestones.removePresetHint")}
                    @click=${() =>
                      props.onSaveSchedule(
                        props.selectedMemberId,
                        row.own
                          ? {
                              milestones: milestones.filter(
                                (candidate) =>
                                  !(candidate.date === row.date && candidate.label === row.label),
                              ),
                            }
                          : { dismissed_deadlines: [...dismissed, row.label] },
                      )}
                  >
                    ${row.own
                      ? t("adminbotTimeAvailability.form.remove")
                      : t("adminbotTimeAvailability.milestones.removePreset")}
                  </button>`
                : nothing}
                </span>
              </div>
              <span class="adminbot-time-availability__deadline-label">${row.label}</span>
              <div class="adminbot-time-availability__deadline-when">
                <span class="adminbot-time-availability__deadline-date">
                  ${tableDate(row.date)}
                </span>
                ${clockLabel(row.time, row.timezone)}
              </div>
            </li>
          `,
        )}
      </ul>
      ${mine.length
        ? nothing
        : html`<p class="adminbot-time-availability__empty-note">
            ${t("adminbotTimeAvailability.milestones.empty")}
          </p>`}
      ${editable ? renderAddConference(props, milestones, now, dismissed) : nothing}
    </aside>
  `;
}

function renderJinesisTable(
  tasks: readonly TimeAllocationTask[],
  rows: AvailabilityRow[],
  props: AdminBotTimeAvailabilityProps,
  editable: boolean,
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
            <th>${t("adminbotTimeAvailability.hours")}</th>
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
                <td>${t("adminbotTimeAvailability.hoursValue", { hours: formatNumber(task.hours) })}</td>
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
              ${renderNoteRow(task.note ?? row?.note, 5)}
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
                    ? row.hours_per_week
                      ? t("adminbotTimeAvailability.tables.partialHours", {
                          hours: formatNumber(row.hours_per_week),
                        })
                      : t("adminbotTimeAvailability.tables.partial")
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
              ${renderNoteRow(row.note, 5)}
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

// The chart bins by day, week or month; the tab's range control names the window a member is
// looking at. Wider window, wider bin -- otherwise a year renders as 365 bars.
function chartInterval(range: TimeAvailabilityRange): TimeAllocationInterval {
  return range === "week" ? "day" : range === "month" ? "week" : "month";
}

// The chart works in effort as a percentage of weekly capacity -- the scale its 100% reference
// line is drawn against -- which is what makes a stack of
// allocations comparable and what puts the 100% reference line somewhere meaningful. Schedules are
// stored in hours, so the conversion happens here. A member with no capacity on file is measured
// against a nominal full week rather than dropped from the chart -- see the callout the view
// renders in that case, which asks them to fill it in.
const NOMINAL_WEEKLY_CAPACITY = 40;

function chartTasks(tasks: readonly TimeAllocationTask[], weeklyCapacity: number): ChartTask[] {
  const capacity = weeklyCapacity > 0 ? weeklyCapacity : NOMINAL_WEEKLY_CAPACITY;
  return tasks.map((task, index) => ({
    id: `${task.key}:${index}`,
    key: task.key,
    sourceIndex: index,
    name: task.name,
    start: task.start,
    end: task.end,
    effort: (task.hours / capacity) * 100,
    ...(task.note ? { note: task.note } : {}),
  }));
}

export function renderAdminBotTimeAvailability(props: AdminBotTimeAvailabilityProps) {
  const emptyOptionLabel = props.loading
    ? t("adminbotTimeAvailability.loadingUsers")
    : t("adminbotTimeAvailability.selectUser");
  // Whose schedules this viewer may read. An admin plans for the lab, so they get everyone; anyone
  // else gets exactly their own record, which is also all the service will send them.
  const readableMembers = props.viewerIsAdmin
    ? props.members
    : props.members.filter((member) => member.id === props.viewerMemberId);
  const selectedMember = readableMembers.find((member) => member.id === props.selectedMemberId);
  const storedAvailability = selectedMember ? availabilityRows(selectedMember.availability) : [];
  const storedTimeOff = selectedMember ? timeOffRows(selectedMember.time_off) : [];
  const storedMilestones = selectedMember ? milestoneRows(selectedMember.milestones) : [];
  const storedTrips = tripRows(selectedMember?.trips);
  const dismissedDeadlines = (selectedMember?.dismissed_deadlines ?? []).filter(
    (name): name is string => typeof name === "string",
  );
  // Built from the same bins the bars use, so "where you are" and "what you are committed to" are
  // divided into the same periods and cannot drift apart when the range switch changes.
  const whereStrip = whereBins(
    rangeBins(props.range, Date.now()),
    storedTrips,
    selectedMember?.current_city?.trim() || selectedMember?.location?.trim() || null,
  );
  const storedNotes = String(selectedMember?.availability_notes ?? "");
  const tasks = selectedMember ? jinesisTasks(selectedMember) : [];
  // The chart shows both; the Jinesis table below it shows only `tasks`, because the two lists are
  // stored separately and the table's remove button writes back to one of them.
  const chartSeries = [...tasks, ...awayTasks(storedTimeOff)];
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
        ${props.viewerIsAdmin
          ? html`<label class="adminbot-form__field">
              <span class="card-title">${t("adminbotTimeAvailability.label")}</span>
              ${renderMemberSelect({
                options: readableMembers.map((member) => ({
                  id: member.id,
                  name: member.name ?? member.id,
                  ...(member.email ? { hint: String(member.email) } : {}),
                })),
                value: selectedMember?.id ?? "",
                placeholder: emptyOptionLabel,
                label: t("adminbotTimeAvailability.selectUser"),
                disabled: props.loading || readableMembers.length === 0,
                onPick: (memberId: string) => props.onMemberChange(memberId),
              })}
            </label>`
          : html`<p
              class="adminbot-time-availability__own-only"
              data-testid="time-availability-own-only"
            >
              ${t("adminbotTimeAvailability.ownScheduleOnly")}
            </p>`}
        ${renderRangeSwitch(props)}
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
                ${!capacity && chartSeries.length
                  ? html`<div class="callout warning" data-testid="time-availability-no-capacity">
                      ${t("adminbotTimeAvailability.capacityNoteUnset")}
                    </div>`
                  : nothing}
                ${chartSeries.length
                  ? html`<div class="adminbot-time-chart-wrap">
                      ${renderTimeAllocationChart(
                        chartTasks(chartSeries, capacity),
                        selectedMember.name,
                        selectedMember.id,
                        chartInterval(props.range),
                      )}
                      ${renderWhereStrip(whereStrip)}
                    </div>`
                  : html`<div class="adminbot-time-availability__empty">
                      ${t("adminbotTimeAvailability.noAllocations")}
                    </div>`}
                ${tasks.length
                  ? renderJinesisTable(tasks, storedAvailability, props, editable)
                  : nothing}
                ${storedTimeOff.length ? renderOtherTable(storedTimeOff, props, editable) : nothing}
                ${renderOverallNotes(props, storedNotes, editable)}
                ${!hasAnything && !editable
                  ? html`<div class="adminbot-time-availability__empty">
                      ${t("adminbotTimeAvailability.noAllocations")}
                    </div>`
                  : nothing}
              </section>
              ${renderBigDeadlines(storedMilestones, props, editable, dismissedDeadlines)}
            </div>
          `
        : html`
            <div class="adminbot-time-availability__empty">
              ${t("adminbotTimeAvailability.empty")}
            </div>
          `}
      <!-- The editor stack. Trips render for a reader who cannot edit too, because where somebody
           will be is the part of their schedule an admin is looking this page up for; the section
           itself drops its form in that case. The other three are writes and nothing else, so
           they stay behind the editable check. -->
      ${editable || storedTrips.length
        ? html`<div class="adminbot-time-availability__editors">
            ${editable
              ? html`${renderJinesisEditor(props, {
                  availability: storedAvailability,
                  timeOff: storedTimeOff,
                })}
                ${renderTimeAwayEditor(props, {
                  availability: storedAvailability,
                  timeOff: storedTimeOff,
                })}
                ${renderMilestoneEditor(props, [...storedMilestones])}`
              : nothing}
            ${props.tripDraft
              ? renderTrips({
                  trips: storedTrips,
                  homeLocation: selectedMember?.location ?? null,
                  draft: props.tripDraft,
                  onDraftChange: (draft) => props.onTripDraftChange?.(draft),
                  editable,
                  saving: props.saving,
                  // Straight through the schedule write the other lists use, so a trip is stored
                  // beside the commitments it sits next to rather than in a channel of its own.
                  onSave: (trips) =>
                    selectedMember && props.onSaveSchedule(selectedMember.id, { trips }),
                })
              : nothing}
          </div>`
        : nothing}
    </div>
  `;
}
