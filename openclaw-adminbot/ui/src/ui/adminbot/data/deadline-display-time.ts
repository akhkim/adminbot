import { aoeInstantMs, deadlineDateTimeLabel } from "./deadline-time.ts";
import type { DeadlineVenue } from "./deadlines.ts";
import { AOE_TIMEZONE, localTimezone } from "./timezones.ts";

export const DEADLINE_TIMEZONE_KEY = "adminbot.deadlines.display-timezone";
export type DeadlineTiming = Pick<
  DeadlineVenue,
  "deadline_aoe" | "deadline_at" | "deadline_date" | "deadline_timezone" | "deadline_time_precision"
>;

export function validDisplayTimezone(value: string): boolean {
  if (value === "local" || value === "original") {
    return true;
  }
  try {
    return Boolean(
      value && new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone,
    );
  } catch {
    return false;
  }
}

export function loadDeadlineTimezone(): string {
  try {
    const saved = window.localStorage.getItem(DEADLINE_TIMEZONE_KEY) || "local";
    return validDisplayTimezone(saved) ? saved : "local";
  } catch {
    return "local";
  }
}

export function saveDeadlineTimezone(value: string): void {
  try {
    window.localStorage.setItem(DEADLINE_TIMEZONE_KEY, value);
  } catch {
    // Display controls still work when browser storage is disabled.
  }
}

export function displayTimezone(selection: string, source?: string): string {
  const zone =
    selection === "local"
      ? localTimezone()
      : selection === "original"
        ? source || "UTC"
        : selection;
  if (zone === "AoE") {
    return AOE_TIMEZONE;
  }
  return validDisplayTimezone(zone) && zone !== "original" && zone !== "local" ? zone : "UTC";
}

export function timezoneName(zone: string): string {
  if (zone === AOE_TIMEZONE || zone === "AoE") {
    return "AoE";
  }
  if (zone.includes("/") && !zone.startsWith("Etc/")) {
    return zone;
  }
  return new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "shortOffset" })
    .formatToParts(0)
    .find((part) => part.type === "timeZoneName")!
    .value.replace("GMT", "UTC")
    .replace(/^UTC[+-]0$/u, "UTC");
}

export function zonedDeadlineLabel(instant: number, zone: string, includeOffset = false): string {
  if (!Number.isFinite(instant)) {
    return "Date unknown";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value || "";
  const offset = part("timeZoneName")
    .replace("GMT", "UTC")
    .replace(/^UTC[+-]0$/u, "UTC");
  const name = timezoneName(zone);
  const label = name === "AoE" ? (includeOffset ? `AoE (${offset})` : "AoE") : offset;
  return `${part("month")} ${part("day")}, ${part("year")} · ${part("hour")}:${part("minute")} ${label}`;
}

export function deadlineDisplayLabel(
  venue: DeadlineTiming,
  selection: string,
  includeOffset = false,
): string {
  if (!venue.deadline_aoe && !venue.deadline_at && !venue.deadline_date) {
    return "Deadline unknown";
  }
  // A calendar date is not an instant: converting it would invent an official closing time.
  if (venue.deadline_time_precision === "date_only") {
    return deadlineDateTimeLabel(venue);
  }
  const instant = venue.deadline_at
    ? Date.parse(venue.deadline_at)
    : aoeInstantMs(venue.deadline_aoe);
  const label = zonedDeadlineLabel(
    instant,
    displayTimezone(selection, venue.deadline_timezone),
    includeOffset,
  );
  // Legacy normalized AoE strings do not establish the original source's timezone.
  return selection === "original" && !venue.deadline_timezone
    ? `${label} · source timezone unknown`
    : label;
}
