/** Source-facing labels for messages, independent of the viewer's timezone. */
export function deadlineSourceDateLabel(venue: Record<string, unknown>): string {
  const sourceZone = typeof venue.deadline_timezone === "string" ? venue.deadline_timezone : "";
  if (venue.deadline_time_precision === "date_only") {
    return typeof venue.deadline_date === "string" && venue.deadline_date
      ? `${venue.deadline_date} (time unknown${sourceZone ? `; ${sourceZone}` : ""})`
      : "Date not published";
  }
  const stamp = typeof venue.deadline_at === "string" && venue.deadline_at
    ? venue.deadline_at
    : typeof venue.deadline_aoe === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(venue.deadline_aoe)
      ? `${venue.deadline_aoe.replace(" ", "T")}-12:00`
      : "";
  const instant = Date.parse(stamp);
  if (!Number.isFinite(instant)) {
    return "Date not published";
  }
  let zone = sourceZone === "AoE" ? "Etc/GMT+12" : sourceZone || "UTC";
  let time = instant;
  const fixed = /^(?:UTC|GMT)([+-])(\d{1,2})(?::(\d{2}))?$/u.exec(zone);
  if (fixed) {
    const hours = Number(fixed[2]);
    const minutes = Number(fixed[3] || "0");
    if (hours <= 14 && minutes < 60 && (hours < 14 || minutes === 0)) {
      time += (fixed[1] === "+" ? 1 : -1) * (hours * 60 + minutes) * 60_000;
      zone = "UTC";
    }
  }
  let known = Boolean(sourceZone);
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions();
  } catch {
    zone = "UTC";
    time = instant;
    known = false;
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(time);
  const part = (kind: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === kind)?.value || "";
  const offset = part("timeZoneName").replace("GMT", "UTC");
  const label = !known
    ? "UTC; source timezone unknown"
    : sourceZone === "AoE" || sourceZone === "UTC" || fixed
      ? sourceZone
      : `${sourceZone} (${offset})`;
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${label}`;
}
