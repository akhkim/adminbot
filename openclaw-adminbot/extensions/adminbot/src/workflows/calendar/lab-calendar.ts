// The one calendar the Calendar tab works on.
//
// The lab reads this calendar as an embed at
// https://calendar.google.com/calendar/embed?src=jinesis.lab%40gmail.com&ctz=America%2FToronto,
// so the tab shows that same embed and every read and write it performs names the same id. Keeping
// the three in one place is the point: a tab that lists events from one calendar, embeds a second
// and writes to a third is worse than no tab at all.
//
// Overridable by environment because the id and the zone are deployment facts, not code — but with
// working defaults, so a box that sets neither still operates on the calendar the lab actually
// uses rather than on the bot's own `primary`.

import { normalizeCalendarTimezone } from "./time.js";

export const ADMINBOT_LAB_CALENDAR_ID_ENV = "ADMINBOT_LAB_CALENDAR_ID";
export const ADMINBOT_LAB_CALENDAR_TZ_ENV = "ADMINBOT_LAB_CALENDAR_TIMEZONE";

const DEFAULT_LAB_CALENDAR_ID = "jinesis.lab@gmail.com";
const DEFAULT_LAB_CALENDAR_TIMEZONE = "America/Toronto";

export type AdminBotLabCalendar = {
  id: string;
  timezone: string;
  /** The read-only embed the tab renders, so the operator sees what they are editing. */
  embed_url: string;
};

export function labCalendarEmbedUrl(id: string, timezone: string): string {
  const params = new URLSearchParams({ src: id, ctz: timezone });
  return `https://calendar.google.com/calendar/embed?${params.toString()}`;
}

export function resolveLabCalendar(env: NodeJS.ProcessEnv = process.env): AdminBotLabCalendar {
  const id = env[ADMINBOT_LAB_CALENDAR_ID_ENV]?.trim() || DEFAULT_LAB_CALENDAR_ID;
  const configuredTimezone =
    env[ADMINBOT_LAB_CALENDAR_TZ_ENV]?.trim() || DEFAULT_LAB_CALENDAR_TIMEZONE;
  // Canonicalise the human-readable AoE labels used in conference material. Preserve any other
  // invalid value so the write route can identify the deployment error instead of silently moving
  // an event to the default zone.
  const timezone = normalizeCalendarTimezone(configuredTimezone) ?? configuredTimezone;
  return { id, timezone, embed_url: labCalendarEmbedUrl(id, timezone) };
}
