import { toAbsoluteRfc3339 } from "../workflows/calendar/time.js";

/** Earliest instant on a published calendar date; it is not an official closing time. */
export function deadlinePlanningInstant(date: string, timezone = ""): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    return Number.NaN;
  }
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) {
    return Number.NaN;
  }
  const fixed = /^(?:UTC|GMT)([+-])(\d{1,2})(?::(\d{2}))?$/u.exec(timezone);
  if (fixed) {
    const hours = Number(fixed[2]);
    const minutes = Number(fixed[3] || "0");
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) {
      return Number.NaN;
    }
    return midnight - (fixed[1] === "+" ? 1 : -1) * (hours * 60 + minutes) * 60_000;
  }
  const value = toAbsoluteRfc3339(`${date}T00:00:00`, timezone || "Pacific/Kiritimati");
  return value ? Date.parse(value) : Number.NaN;
}
