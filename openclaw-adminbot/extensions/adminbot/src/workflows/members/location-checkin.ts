// "Where are you based right now?" -- the explicit location check-in.
//
// Every other location signal is inferred (a sign-in IP, a Slack zone) or undated (a profile field
// typed at some point). The check-in is the member saying it, with a date, and every response is
// logged to the location history: an answer as an ordinary `self_reported` observation, and a
// snooze or a decline as a row that places nothing but records that they were asked.
//
// It is meant to cost a member nothing, so it asks rarely and asks small:
//
//   - Never when the member already settled it: answered within ADMINBOT_LOCATION_CHECKIN_DAYS
//     (60), snoozed ("Ask me later", or dismissing the banner: 7 days), or declined ("Prefer not to
//     say", which also hides them from the map).
//   - Never when the signals agree: a fresh sign-in city that the member's Slack zone does not
//     contradict already says where they are. Both are logged where they arrive (the sign-in and
//     the Slack sync), so skipping the question loses nothing.
//   - Otherwise it asks -- because nothing places the member (`no_guess`), because their fresh IP
//     reading was set aside as a likely VPN (`ip_suspected_vpn`: its city keeps a clock more than
//     two hours from their browser's zone, else their Slack zone), or because the city that places
//     them conflicts with that zone in the same way (`timezone_mismatch`, which carries a note).
//
// When it asks, it offers its best guess for a one-tap "Yes" (a trusted IP city, then the city the
// browser's zone is named for, then the Slack zone's, then the stored city), and only "No, change"
// opens the picker. For a VPN user that is "Are you in Zürich?" from the zone their laptop keeps.

import { randomUUID } from "node:crypto";
import type {
  AdminBotLabMember,
  AdminBotLocationCheckin,
  AdminBotLocationCheckinVia,
  AdminBotMemberLocationEntry,
} from "../../contracts/actions.js";
import { renderInZone } from "./location-history.js";
import {
  ADMINBOT_LOCATION_CHECKIN_DAYS,
  freshDeviceTz,
  freshLoginPlace,
  freshSlackTz,
  ipCityState,
  isWithinDays,
  memberMapVisibility,
  resolvePlace,
  type AdminBotMapPlace,
} from "./member-map.js";
import { placeTimezone, timezoneMismatch } from "./place-timezone.js";

export { ADMINBOT_LOCATION_CHECKIN_DAYS };

/** How long "Ask me later" (or dismissing the banner) keeps the question away. */
export const ADMINBOT_LOCATION_CHECKIN_SNOOZE_DAYS = 7;

const DAY_MS = 86_400_000;

/** Members who are not asked: alumni have left, and someone on leave is not "based" anywhere for us. */
const NOT_ASKED_STATUSES = new Set<string>(["alumni", "on_leave"]);

function isActive(member: AdminBotLabMember): boolean {
  return !NOT_ASKED_STATUSES.has(member.status ?? "");
}

/** The place a stored location field names, if the gazetteer knows it at city level. */
function storedPlace(
  member: AdminBotLabMember,
): { text: string; place: AdminBotMapPlace } | undefined {
  for (const text of [member.current_city, member.location]) {
    const trimmed = text?.trim();
    const place = trimmed ? resolvePlace(trimmed) : undefined;
    if (trimmed && place) {
      return { text: place.label, place };
    }
  }
  return undefined;
}

/**
 * Whether to ask, and what to offer for one tap. Pure: `now` is passed in, and nothing is read
 * beyond the member record.
 */
export function locationCheckin(
  member: AdminBotLabMember,
  now: Date,
  options: { checkinDays?: number } = {},
): AdminBotLocationCheckin {
  const checkinDays = options.checkinDays ?? ADMINBOT_LOCATION_CHECKIN_DAYS;
  const settled = {
    ...(member.location_checkin_at ? { last_answered_at: member.location_checkin_at } : {}),
    ...(member.location_checkin_city ? { last_answered_city: member.location_checkin_city } : {}),
  };
  if (member.location_checkin_declined_at) {
    return { due: false, reason: "declined", ...settled };
  }
  if (memberMapVisibility(member) === "hidden" || !isActive(member)) {
    return { due: false, reason: "hidden", ...settled };
  }
  const snoozeEnds = member.location_checkin_snoozed_until;
  if (snoozeEnds && Date.parse(snoozeEnds) > now.getTime()) {
    return { due: false, reason: "snoozed", snoozed_until: snoozeEnds, ...settled };
  }
  if (isWithinDays(member.location_checkin_at, checkinDays, now)) {
    return { due: false, reason: "answered", ...settled };
  }

  // "stated" means the member asked for sign-ins to be left out of where they are; respect it here
  // too, so a sign-in city is neither offered nor used to skip the question.
  const auto = memberMapVisibility(member) === "auto";
  const login = auto ? freshLoginPlace(member, now) : undefined;
  const ipIgnored = auto ? ipCityState(member, now).ignored : undefined;
  const deviceTz = freshDeviceTz(member, now);
  const devicePlace = deviceTz ? resolvePlace(deviceTz) : undefined;
  const slackTz = freshSlackTz(member, now);
  const slackPlace = slackTz ? resolvePlace(slackTz) : undefined;
  const stored = storedPlace(member);
  const suggestion = login
    ? { city: login.label, source: "login" as const }
    : devicePlace
      ? { city: devicePlace.label, source: "device_tz" as const }
      : slackPlace
        ? { city: slackPlace.label, source: "slack_tz" as const }
        : stored
          ? { city: stored.text, source: "stored" as const }
          : undefined;
  const withSuggestion = suggestion ? { suggestion } : {};

  // The IP said somewhere the member's own clock says they are not. No recent answer exists (that
  // returned above), so the map is down to a stated city or a zone: ask, with the zone's city.
  if (ipIgnored) {
    return {
      due: true,
      reason: "ip_suspected_vpn",
      ...withSuggestion,
      ...settled,
      note: "Your network address points somewhere your device's clock disagrees with, which usually means a VPN.",
    };
  }

  // The city the member is placed in for the cross-check: the IP city if fresh and trusted, else
  // what they stated. Checked against the browser's zone, else the Slack zone. A zone's own city
  // is never checked against that zone.
  const placed = login ?? stored?.place;
  const zone = deviceTz ?? slackTz;
  const mismatch = placed ? timezoneMismatch(placed, zone, now) : undefined;
  if (mismatch && placed) {
    return {
      due: true,
      reason: "timezone_mismatch",
      ...withSuggestion,
      ...settled,
      note: `${placed.label} keeps a clock ${formatHours(mismatch.hours)} from your ${deviceTz ? "device" : "Slack"} time zone (${mismatch.slack_tz}).`,
    };
  }
  if (login) {
    return { due: false, reason: "signals_agree", ...withSuggestion, ...settled };
  }
  return { due: true, reason: "no_guess", ...withSuggestion, ...settled };
}

function formatHours(hours: number): string {
  const rounded = Math.round(hours * 2) / 2;
  return `${rounded} hours`;
}

export type LocationCheckinAnswer = {
  /** What the member chose or typed. Required; trimmed. */
  text: string;
  via: AdminBotLocationCheckinVia;
};

/**
 * The history row for an answer. Always a new row, even when it repeats the previous answer: a
 * confirmation is itself the fact being logged ("still Toronto, as of today"), which the usual
 * change-only dedup would drop.
 */
export function checkinAnswerEntry(
  memberId: string,
  answer: LocationCheckinAnswer,
  observedAt: string,
): AdminBotMemberLocationEntry | undefined {
  const raw = answer.text.trim();
  if (!raw) {
    return undefined;
  }
  const place = resolvePlace(raw);
  const zone = place ? placeTimezone(place) : undefined;
  const local = zone ? renderInZone(observedAt, zone) : undefined;
  return {
    id: `loc_${randomUUID()}`,
    member_id: memberId,
    observed_at: observedAt,
    source: "self_reported",
    raw,
    ...(place ? { place_key: place.key, place_label: place.label, country: place.country } : {}),
    ...(local ? { observed_at_local: local } : {}),
    checkin: "answered",
    checkin_via: answer.via,
  };
}

/** The history row for "Ask me later" or "Prefer not to say": no place, only that they were asked. */
export function checkinNonAnswerEntry(
  memberId: string,
  outcome: "snoozed" | "declined",
  observedAt: string,
): AdminBotMemberLocationEntry {
  return {
    id: `loc_${randomUUID()}`,
    member_id: memberId,
    observed_at: observedAt,
    source: "self_reported",
    raw: outcome === "snoozed" ? "Ask me later" : "Prefer not to say",
    checkin: outcome,
  };
}

/** The member fields an answer sets. `current_city` is written by the caller through the profile path. */
export function answeredFields(
  answer: { text: string },
  at: string,
): Pick<
  AdminBotLabMember,
  "location_checkin_at" | "location_checkin_city" | "location_checkin_snoozed_until"
> {
  return {
    location_checkin_at: at,
    location_checkin_city: answer.text.trim(),
    location_checkin_snoozed_until: undefined,
  };
}

/** When a snooze taken at `at` ends. */
export function snoozedUntil(
  at: Date,
  days: number = ADMINBOT_LOCATION_CHECKIN_SNOOZE_DAYS,
): string {
  return new Date(at.getTime() + days * DAY_MS).toISOString();
}
