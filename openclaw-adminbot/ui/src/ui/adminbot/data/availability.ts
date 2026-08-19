// Rendering a member's recorded schedule in the Control UI.
//
// The AdminBot service owns the schedule: members edit commitment rows and time off in the
// AdminBot console (or have them imported from their planning doc in Drive), the service
// validates and stores them, and this module only ever consumes that stored structure. It
// deliberately has no editor and no parser — the console is the one place a schedule is
// written, so there is one validator (see extensions/adminbot/src/kernel/service.ts).

import { html, type TemplateResult } from "lit-html";

export type AvailabilityRow = {
  start: string;
  end: string;
  project?: string;
  hours_per_week: number;
  note?: string;
  // Optional supporting page — a syllabus, a project board. https only; the service enforces that
  // (validateExternalLink in extensions/adminbot/src/kernel/service.ts).
  link?: string;
};

export type TimeOffRow = {
  start: string;
  end: string;
  kind?: string;
  availability: "none" | "partial";
  // Hours a week a "partial" row takes. Absent on whole-day rows, which zero the week outright,
  // and absent on partial rows recorded before the form asked for a number.
  hours_per_week?: number;
  note?: string;
  // The member's own name for this, used when `kind` is "other" so the closed enum stays closed.
  label?: string;
  link?: string;
};

// A dated milestone on the member's horizon — thesis, defence, graduation. A date, not a range.
export type MilestoneRow = {
  date: string;
  label: string;
  link?: string;
  // The wall-clock cutoff on `date` ("HH:MM") and the IANA zone it is read in. Both or neither;
  // see AdminBotMemberMilestone in extensions/adminbot/src/contracts/actions.ts.
  time?: string;
  timezone?: string;
};

// Mirrors ADMINBOT_OPEN_PROJECT in extensions/adminbot/src/contracts/actions.ts: a sentinel project
// name meaning declared spare capacity. It is not a real project, so it never takes a
// categorical colour slot.
const OPEN_PROJECT = "__open__";

// The colour-vision-validated categorical slots, in fixed order and never cycled; projects past
// the last slot fold into one neutral colour rather than minting a hue. Four is what clears the
// all-pairs gate on this surface, matching the AdminBot console's own timeline.
const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#4a3aa7"] as const;
const NEUTRAL_COLOR = "#c3c2b7";
// Time off is deliberately not a categorical hue: it is the absence of lab work, not another
// project competing for the same time.
const AWAY_COLOR = "#9aa8b2";

const MS_PER_DAY = 86_400_000;

export function availabilityRows(value: unknown): AvailabilityRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const row = entry as Partial<AvailabilityRow> | null;
    return row && typeof row.start === "string" && typeof row.end === "string"
      ? [
          {
            start: row.start,
            end: row.end,
            hours_per_week: Number(row.hours_per_week) || 0,
            ...(typeof row.project === "string" ? { project: row.project } : {}),
            ...(typeof row.note === "string" ? { note: row.note } : {}),
            ...(typeof row.link === "string" ? { link: row.link } : {}),
          },
        ]
      : [];
  });
}

export function milestoneRows(value: unknown): MilestoneRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const row = entry as Partial<MilestoneRow> | null;
    return row && typeof row.date === "string" && typeof row.label === "string" && row.label.trim()
      ? [
          {
            date: row.date,
            label: row.label,
            ...(typeof row.link === "string" ? { link: row.link } : {}),
            // Dropped unless both halves are there: a time with no zone is the ambiguity the
            // pair exists to remove, so half a pair is treated as no answer rather than as a
            // number a reader would have to guess the zone for.
            ...(typeof row.time === "string" && typeof row.timezone === "string" && row.timezone
              ? { time: row.time, timezone: row.timezone }
              : {}),
          },
        ]
      : [];
  });
}

export function timeOffRows(value: unknown): TimeOffRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const row = entry as Partial<TimeOffRow> | null;
    return row && typeof row.start === "string" && typeof row.end === "string"
      ? [
          {
            start: row.start,
            end: row.end,
            availability: row.availability === "partial" ? ("partial" as const) : ("none" as const),
            // Only kept when it is a usable figure: a stored 0 or a NaN says the same thing as no
            // answer at all, and letting either through would draw a zero-height bar.
            ...(Number.isFinite(Number(row.hours_per_week)) && Number(row.hours_per_week) > 0
              ? { hours_per_week: Number(row.hours_per_week) }
              : {}),
            ...(typeof row.kind === "string" ? { kind: row.kind } : {}),
            ...(typeof row.note === "string" ? { note: row.note } : {}),
            ...(typeof row.label === "string" ? { label: row.label } : {}),
            ...(typeof row.link === "string" ? { link: row.link } : {}),
          },
        ]
      : [];
  });
}

/**
 * A stretch away from home, with a place on it.
 *
 * Distinct from a TimeOffRow, which says a member is unavailable and nothing about where they are.
 * Somebody working normal hours from Berlin is fully available and six hours off the lab's clock.
 */
export type TripRow = {
  start: string;
  end: string;
  city: string;
  timezone?: string;
  note?: string;
  link?: string;
};

export function tripRows(value: unknown): TripRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const row = entry as Partial<TripRow> | null;
    // A row with no city is not a trip -- it is time off, and the service refuses it on write. One
    // that reached the record before this field existed is dropped rather than drawn as a blank
    // chip on somebody's calendar.
    return row &&
      typeof row.start === "string" &&
      typeof row.end === "string" &&
      typeof row.city === "string" &&
      row.city.trim()
      ? [
          {
            start: row.start,
            end: row.end,
            city: row.city,
            ...(typeof row.timezone === "string" && row.timezone ? { timezone: row.timezone } : {}),
            ...(typeof row.note === "string" ? { note: row.note } : {}),
            ...(typeof row.link === "string" ? { link: row.link } : {}),
          },
        ]
      : [];
  });
}

/** One period of the chart's x axis, and where the member is for it. */
export type WhereBin = {
  label: string;
  /** The place, which is a trip's city when one covers the period and home otherwise. */
  city: string;
  /** False means "home", which the strip draws quietly so trips are what stands out. */
  away: boolean;
  /** True when the trip covers only part of the period — a week away inside a monthly bar. */
  partial: boolean;
};

/**
 * Where a member is over each period of the chart, at whatever granularity the range switch chose.
 *
 * Takes the bins rather than computing them so this stays a pure function of the same division of
 * time the bars already use: the strip has to say "where you are" for exactly the periods the chart
 * says "what you are committed to" for, and two independent binnings would eventually disagree.
 *
 * A period is attributed to the trip covering the most of it, and flagged `partial` when that trip
 * does not cover the whole period. Attributing a month to a three-day conference would be a lie of
 * the kind that is hard to notice; saying "mostly Berlin" and marking it partial is not.
 */
export function whereBins(
  bins: readonly { startMs: number; endMs: number; label: string }[],
  trips: readonly TripRow[],
  home: string | null,
): WhereBin[] {
  const dayMs = 86_400_000;
  return bins.map((bin) => {
    let best: { trip: TripRow; days: number } | undefined;
    for (const trip of trips) {
      const start = Date.parse(`${trip.start}T00:00:00Z`);
      // Inclusive of the end date: a trip ending on the 30th includes the 30th.
      const end = Date.parse(`${trip.end}T00:00:00Z`) + dayMs;
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        continue;
      }
      const overlap = Math.min(end, bin.endMs) - Math.max(start, bin.startMs);
      if (overlap > 0 && (!best || overlap > best.days)) {
        best = { trip, days: overlap };
      }
    }
    if (!best) {
      return { label: bin.label, city: home ?? "", away: false, partial: false };
    }
    return {
      label: bin.label,
      city: best.trip.city,
      away: true,
      partial: best.days < bin.endMs - bin.startMs,
    };
  });
}

/** The trip covering a day, if any. Last match wins, matching the service's own rule. */
export function tripOnDay(trips: readonly TripRow[], dayIso: string): TripRow | undefined {
  return trips.findLast((row) => row.start <= dayIso && row.end >= dayIso);
}

export function todayIso(now = new Date()): string {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
    .toISOString()
    .slice(0, 10);
}

// Weeks start Monday, matching the console's capacity view, so "this week" means the same
// window on both surfaces.
function weekOf(dayIso: string): { start: string; end: string } {
  const ms = Date.parse(`${dayIso}T00:00:00Z`);
  const start = ms - ((new Date(ms).getUTCDay() + 6) % 7) * MS_PER_DAY;
  return {
    start: new Date(start).toISOString().slice(0, 10),
    end: new Date(start + 6 * MS_PER_DAY).toISOString().slice(0, 10),
  };
}

// A row counts for a week if it overlaps the Monday–Sunday window at all.
function activeInWeek(row: { start: string; end: string }, week: { start: string; end: string }) {
  return row.start <= week.end && row.end >= week.start;
}

function commitmentLabel(row: AvailabilityRow): string {
  if (!row.project) {
    return "Term baseline";
  }
  return row.project === OPEN_PROJECT ? "Open capacity" : row.project;
}

// Colour follows the project, not its row position, so adding or removing a commitment never
// repaints the others. Assigned over the sorted project names for stability.
function projectColors(rows: readonly AvailabilityRow[]): Map<string, string> {
  const projects = [
    ...new Set(
      rows
        .filter((row) => row.project && row.project !== OPEN_PROJECT)
        .map((row) => row.project as string),
    ),
  ].sort();
  return new Map(
    projects.map((project, index) => [project, SERIES_COLORS[index] ?? NEUTRAL_COLOR]),
  );
}

function commitmentFill(row: AvailabilityRow, colors: Map<string, string>): string {
  if (row.project === OPEN_PROJECT) {
    return "var(--accent, #176b87)";
  }
  return colors.get(row.project ?? "") ?? NEUTRAL_COLOR;
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// The compact roster form: this week only, so a long roster stays scannable.
export function renderAvailabilityStrip(
  availability: unknown,
  timeOff: unknown,
  now = new Date(),
): TemplateResult {
  const week = weekOf(todayIso(now));
  const rows = availabilityRows(availability).filter((row) => activeInWeek(row, week));
  const away = timeOffRows(timeOff).filter((row) => activeInWeek(row, week));
  if (rows.length === 0 && away.length === 0) {
    return html`<small class="adminbot-avail-empty">No availability set</small>`;
  }
  const colors = projectColors(rows);
  const hours = rows.reduce((total, row) => total + row.hours_per_week, 0);
  const summary = [
    ...rows.map((row) => `${commitmentLabel(row)} ${row.hours_per_week}h`),
    ...away.map((row) => (row.availability === "partial" ? "partly away" : "away")),
  ].join(", ");
  // Widths are shares of the hours committed this week, so the strip reads as "where the time
  // goes" rather than as a fraction of a full week nobody declared.
  const fullyAway = away.some((row) => row.availability !== "partial");
  return html`
    <div class="adminbot-avail-strip" title=${`Week of ${week.start}: ${summary}`}>
      <div class="adminbot-avail-track">
        ${hours > 0
          ? rows.map(
              (row) =>
                html`<span
                  style=${`width:${(row.hours_per_week / hours) * 100}%;background:${commitmentFill(row, colors)}`}
                ></span>`,
            )
          : html`<span style=${`width:100%;background:${NEUTRAL_COLOR}`}></span>`}
        ${away.length > 0
          ? html`<span style=${`width:${fullyAway ? 100 : 25}%;background:${AWAY_COLOR}`}></span>`
          : null}
      </div>
      <small>${fullyAway ? "away this week" : `${hours}h committed`}</small>
    </div>
  `;
}

// The member's own schedule, read-only: what they are committed to and when they are away.
// Editing lives in the AdminBot console, which owns validation and the Drive import.
export function renderAvailabilitySchedule(
  availability: unknown,
  timeOff: unknown,
  memberName: string,
  now = new Date(),
): TemplateResult {
  const today = todayIso(now);
  // Past rows are dropped: this answers "what does my time look like from here".
  const rows = availabilityRows(availability)
    .filter((row) => row.end >= today)
    .toSorted((left, right) => left.start.localeCompare(right.start));
  const away = timeOffRows(timeOff)
    .filter((row) => row.end >= today)
    .toSorted((left, right) => left.start.localeCompare(right.start));
  if (rows.length === 0 && away.length === 0) {
    return html`
      <div class="adminbot-avail-chart">
        <small class="adminbot-avail-empty">
          No availability recorded from today onward. Add commitments in the AdminBot console, or
          link your planning doc there and have them read for you.
        </small>
      </div>
    `;
  }
  const colors = projectColors(rows);
  return html`
    <div class="adminbot-avail-chart">
      <h4>Time availability: ${memberName}</h4>
      <ul class="adminbot-avail-list">
        ${rows.map(
          (row) => html`
            <li>
              <i style=${`background:${commitmentFill(row, colors)}`}></i>
              <span>${commitmentLabel(row)}</span>
              <b>${row.hours_per_week}h/w</b>
              <small>${shortDate(row.start)} – ${shortDate(row.end)}</small>
              ${row.note ? html`<small>${row.note}</small>` : null}
            </li>
          `,
        )}
        ${away.map(
          (row) => html`
            <li>
              <i style=${`background:${AWAY_COLOR}`}></i>
              <span>${row.availability === "partial" ? "Partly away" : "Away"}</span>
              <b>${row.kind ? row.kind.replace(/_/gu, " ") : "time off"}</b>
              <small>${shortDate(row.start)} – ${shortDate(row.end)}</small>
              ${row.note ? html`<small>${row.note}</small>` : null}
            </li>
          `,
        )}
      </ul>
    </div>
  `;
}
