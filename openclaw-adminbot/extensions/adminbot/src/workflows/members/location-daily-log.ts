// One row per day for a single member, from an observation history that only records changes.
//
// `location-history.ts` deliberately appends an observation only when it *differs* from the last
// one from the same source, so a member who has not moved produces no rows at all. That is the
// right shape for a change log and the wrong shape for a calendar: "which country was she in on
// 12 August" has an answer even on days nothing was recorded, and this module is that projection.
//
// Turning a sparse change log into a dense daily one means carrying the last observation forward
// across the gaps. That step invents days. It is the only thing here that could mislead, so the
// carried days are labelled rather than blended in:
//
//   - `basis=observed` — an observation exists with this day's stamp. Evidence.
//   - `basis=carried`  — no observation that day; this is the last known value, still assumed to
//                        hold. An inference, and `days_since_observation` says how stale.
//   - `basis=unknown`  — before the first observation, or after a gap too long to carry (see
//                        CARRY_LIMIT_DAYS). Deliberately blank rather than guessed.
//
// The rule this preserves is the one the location contract states: an inference must never be
// presented as a fact. A daily file that silently backfilled 60 days from one sign-in would break
// it more thoroughly than any profile write, because the output *looks* like 60 observations.
//
// A note on counting days from this file: don't, without reading `basis`. `countryDayTotals`
// returns observed and carried totals separately for exactly that reason, and no caller should be
// adding the two together to answer a question that matters.
import type {
  AdminBotLocationSource,
  AdminBotMemberLocationEntry,
} from "../../contracts/actions.js";

const DAY_MS = 86_400_000;

/**
 * How long a single observation is allowed to speak for.
 *
 * Past this many days with no new observation the row goes to `unknown` instead of carrying.
 * Fourteen days because the carry is an assumption of continuity, and continuity is a reasonable
 * assumption over a fortnight and an unreasonable one over a quarter -- somebody with one sign-in
 * in March is not thereby in that country in June. The limit is what stops one stale row from
 * filling a year.
 */
export const CARRY_LIMIT_DAYS = 14;

export type LocationDayBasis = "observed" | "carried" | "unknown";

export type LocationDayRow = {
  /** Calendar day in UTC, YYYY-MM-DD. */
  day: string;
  country?: string;
  place_label?: string;
  /** Which source the standing observation came from; absent when the day is `unknown`. */
  source?: AdminBotLocationSource;
  basis: LocationDayBasis;
  /** The stamp of the observation this row rests on, so a carried row is traceable to its source. */
  observed_at?: string;
  /** 0 on an observed day, and the age of the carry otherwise. Absent when `unknown`. */
  days_since_observation?: number;
  /**
   * The member's Slack timezone as most recently observed on or before this day.
   *
   * Carried under the same rules and reported under `timezone_basis`, but kept in its own column
   * because it is a *different claim* from the location: a Slack timezone is a profile setting a
   * person may never have changed, so it is evidence about their account, not their body.
   */
  slack_timezone?: string;
  timezone_basis: LocationDayBasis;
};

/**
 * The inclusive day range [from, to], as one row per day.
 *
 * `history` may hold any sources and arrive in any order; only entries at or before a given day
 * can inform it, which is what makes the output stable when the file is regenerated later.
 */
export function dailyLocationRows(params: {
  history: readonly AdminBotMemberLocationEntry[];
  from: string;
  to: string;
  carryLimitDays?: number;
}): LocationDayRow[] {
  const carryLimit = params.carryLimitDays ?? CARRY_LIMIT_DAYS;
  // Location and timezone are carried independently: a sign-in updates where she is without
  // saying anything about her Slack profile, and vice versa. Blending them would let one source's
  // freshness vouch for the other's staleness.
  const placed = params.history
    .filter((entry) => entry.country || entry.place_label)
    .toSorted((left, right) => left.observed_at.localeCompare(right.observed_at));
  const zoned = params.history
    .filter((entry) => entry.timezone)
    .toSorted((left, right) => left.observed_at.localeCompare(right.observed_at));

  const rows: LocationDayRow[] = [];
  for (const day of eachDay(params.from, params.to)) {
    const location = standingAt(placed, day, carryLimit);
    const timezone = standingAt(zoned, day, carryLimit);
    // An `unknown` day states nothing -- not the country, not the label, not the source. The
    // entry behind it is still returned by `standingAt` so a caller can explain the gap, but
    // nothing from a too-stale observation is allowed onto the row itself.
    const placeKnown = location.basis !== "unknown" ? location.entry : undefined;
    rows.push({
      day,
      ...(placeKnown?.country ? { country: placeKnown.country } : {}),
      ...(placeKnown?.place_label ? { place_label: placeKnown.place_label } : {}),
      ...(placeKnown ? { source: placeKnown.source } : {}),
      basis: location.basis,
      ...(location.entry && location.basis !== "unknown"
        ? { observed_at: location.entry.observed_at, days_since_observation: location.ageDays }
        : {}),
      ...(timezone.basis !== "unknown" && timezone.entry?.timezone
        ? { slack_timezone: timezone.entry.timezone }
        : {}),
      timezone_basis: timezone.basis,
    });
  }
  return rows;
}

/** The newest entry at or before `day`, and whether it lands on the day or is being carried. */
function standingAt(
  sorted: readonly AdminBotMemberLocationEntry[],
  day: string,
  carryLimitDays: number,
): { entry?: AdminBotMemberLocationEntry; basis: LocationDayBasis; ageDays: number } {
  let held: AdminBotMemberLocationEntry | undefined;
  for (const entry of sorted) {
    if (entry.observed_at.slice(0, 10) > day) {
      break;
    }
    held = entry;
  }
  if (!held) {
    return { basis: "unknown", ageDays: 0 };
  }
  const ageDays = Math.round((Date.parse(`${day}T00:00:00.000Z`) - dayStart(held)) / DAY_MS);
  if (ageDays === 0) {
    return { entry: held, basis: "observed", ageDays };
  }
  if (ageDays > carryLimitDays) {
    // Deliberately returns the entry so a caller can explain *why* the day is unknown, while the
    // basis keeps it out of any count.
    return { entry: held, basis: "unknown", ageDays };
  }
  return { entry: held, basis: "carried", ageDays };
}

function dayStart(entry: AdminBotMemberLocationEntry): number {
  return Date.parse(`${entry.observed_at.slice(0, 10)}T00:00:00.000Z`);
}

function* eachDay(from: string, to: string): Generator<string> {
  for (
    let at = Date.parse(`${from}T00:00:00.000Z`);
    at <= Date.parse(`${to}T00:00:00.000Z`);
    at += DAY_MS
  ) {
    yield new Date(at).toISOString().slice(0, 10);
  }
}

/**
 * Days per country, with observed and carried kept apart.
 *
 * The split is the point. Any question worth asking of this data -- residency, tax days, whether
 * somebody was actually at the retreat -- is a question where a carried day is not admissible, and
 * a single `days` number would invite exactly that mistake.
 */
export function countryDayTotals(
  rows: readonly LocationDayRow[],
): Array<{ country: string; observed_days: number; carried_days: number }> {
  const totals = new Map<string, { observed_days: number; carried_days: number }>();
  for (const row of rows) {
    if (!row.country || row.basis === "unknown") {
      continue;
    }
    const held = totals.get(row.country) ?? { observed_days: 0, carried_days: 0 };
    if (row.basis === "observed") {
      held.observed_days += 1;
    } else {
      held.carried_days += 1;
    }
    totals.set(row.country, held);
  }
  return [...totals]
    .map(([country, counts]) => ({
      country,
      observed_days: counts.observed_days,
      carried_days: counts.carried_days,
    }))
    .toSorted((left, right) => right.observed_days - left.observed_days);
}

const HEADERS = [
  "day",
  "country",
  "place_label",
  "source",
  "basis",
  "observed_at",
  "days_since_observation",
  "slack_timezone",
  "timezone_basis",
] as const;

/** The rows as CSV, headers included, for the daily export. */
export function formatLocationDayCsv(rows: readonly LocationDayRow[]): string {
  const lines = [HEADERS.join(",")];
  for (const row of rows) {
    lines.push(
      HEADERS.map((header) => {
        const value = row[header as keyof LocationDayRow];
        return value === undefined ? "" : escapeCsv(String(value));
      }).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function escapeCsv(value: string): string {
  return /[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
