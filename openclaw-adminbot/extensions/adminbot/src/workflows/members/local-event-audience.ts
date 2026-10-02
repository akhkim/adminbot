// Who should be on a standing local event, worked out from where people actually are.
//
// The Zurich lunch is the case this exists for: a weekly event whose guest list is "whoever is in
// Zurich", which nobody maintains by hand for long. The roster already knows where people are --
// `location-history.ts` records a login IP and a Slack timezone as separate observations, and
// `location-daily-log.ts` turns those into a standing answer per day with an honest `basis`. This
// module is the step after: standing answer plus current guest list in, a diff out.
//
// Three rules, and each one is a decision that could sensibly have gone the other way:
//
//   1. **Either signal puts somebody on the list.** A login IP placing them in the city, or a Slack
//      timezone of the city's zone. They answer different failure modes -- somebody who works from
//      the desktop app barely produces sign-ins, and somebody who never touched their Slack profile
//      has a zone from wherever they installed it -- so requiring both would drop real locals.
//
//   2. **Silence never uninvites anybody.** A removal needs a *fresh* observation actively placing
//      them somewhere else. A `carried` or `unknown` day means the lab has not heard from them, and
//      "we have no evidence" is not "they left". This is the rule that keeps a quiet fortnight from
//      reading as a departure.
//
//   3. **An address the roster cannot name is never touched.** `calendar.remove_attendees` replaces
//      the guest list wholesale (see buildCalendarRemoveAttendeesArgs), so anyone absent from
//      `remaining` is uninvited. External guests, the room resource and the organiser are not lab
//      members and must survive every sweep -- they are carried through untouched rather than
//      being dropped for failing a test that was never about them.
import type { AdminBotLabMember, AdminBotMemberLocationEntry } from "../../contracts/actions.js";
import { dailyLocationRows, type LocationDayRow } from "./location-daily-log.js";

/** One person's place in the diff, with the sentence that put them there. */
export type LocalEventAudienceRow = {
  member_id: string;
  name: string;
  /** The address on the invite: `calendar_email` when set, since that is the one Google knows. */
  email: string;
  reason: string;
};

export type LocalEventAudience = {
  /** In the city, not yet invited. */
  add: LocalEventAudienceRow[];
  /** Invited, and freshly observed somewhere else. */
  remove: LocalEventAudienceRow[];
  /** Invited and still local. */
  keep: LocalEventAudienceRow[];
  /**
   * Invited, not currently placed in the city, and left alone because the evidence is stale.
   *
   * Reported rather than silently kept: "nobody was removed this week" and "four people have not
   * been heard from since August" are different states, and only one of them wants a human.
   */
  held: LocalEventAudienceRow[];
  /** Guest-list addresses the roster cannot name. Never added, never removed; reported so the
   *  count on the event reconciles with the count in this diff. */
  unknown_attendees: string[];
};

/** The address the invite uses for a member: the calendar one when they have set it. */
export function inviteAddressFor(member: AdminBotLabMember): string {
  return (member.calendar_email?.trim() || member.email?.trim() || "").toLowerCase();
}

/**
 * Compare two place names the way the gazetteer writes them.
 *
 * Accents stripped, because the gazetteer's label for the city is "Zürich" and every caller,
 * settings row and cron env spells it "Zurich". Comparing raw would make the whole sweep silently
 * match nobody -- and match nobody is exactly what an empty diff looks like, so it would read as
 * "nothing to change" rather than as a fault.
 */
function samePlace(left: string | undefined, right: string): boolean {
  const fold = (value: string) =>
    value
      .normalize("NFD")
      .replaceAll(/\p{Diacritic}/gu, "")
      .trim()
      .toLowerCase();
  return Boolean(left) && fold(left as string) === fold(right);
}

function placedInCity(row: LocationDayRow | undefined, city: string): boolean {
  if (!row || row.basis === "unknown") {
    return false;
  }
  return samePlace(row.place_label, city);
}

function zonedToCity(row: LocationDayRow | undefined, zone: string): boolean {
  if (!row || row.timezone_basis === "unknown" || !row.slack_timezone) {
    return false;
  }
  return row.slack_timezone.trim().toLowerCase() === zone.trim().toLowerCase();
}

/**
 * Freshly observed somewhere that is not the city.
 *
 * `observed` only -- the whole of rule 2. A carried row is the last thing anybody saw, which may be
 * a fortnight old, and acting on it is how a member who stopped signing in over the holidays comes
 * back to find themselves uninvited.
 */
function observedElsewhere(row: LocationDayRow | undefined, city: string): boolean {
  if (!row || row.basis !== "observed") {
    return false;
  }
  // An observed row with no place label states a country at most, which cannot contradict a city.
  return Boolean(row.place_label) && !samePlace(row.place_label, city);
}

export function localEventAudience(params: {
  members: readonly AdminBotLabMember[];
  /** This member's location observations, newest or oldest first -- the log sorts them. */
  historyFor: (memberId: string) => readonly AdminBotMemberLocationEntry[];
  /** Gazetteer label, matched case-insensitively. "Zurich". */
  city: string;
  /** IANA zone the city sits in, matched exactly bar case. "Europe/Zurich". */
  zone: string;
  /** The event's current guest list, as addresses. */
  attendees: readonly string[];
  /** YYYY-MM-DD the sweep is answering for. */
  day: string;
}): LocalEventAudience {
  const invited = new Set(
    params.attendees.map((address) => address.trim().toLowerCase()).filter(Boolean),
  );
  const claimed = new Set<string>();
  const out: LocalEventAudience = {
    add: [],
    remove: [],
    keep: [],
    held: [],
    unknown_attendees: [],
  };

  for (const member of params.members) {
    const email = inviteAddressFor(member);
    if (!email) {
      // No address at all: not invitable, and not something this sweep can fix.
      continue;
    }
    const onInvite = invited.has(email);
    if (onInvite) {
      claimed.add(email);
    }
    const [row] = dailyLocationRows({
      history: params.historyFor(member.id),
      from: params.day,
      to: params.day,
    });
    const byIp = placedInCity(row, params.city);
    const byZone = zonedToCity(row, params.zone);
    const entry = {
      member_id: member.id,
      name: member.name ?? member.id,
      email,
    };

    if (byIp || byZone) {
      const why =
        byIp && byZone
          ? `signed in from ${params.city} and Slack says ${params.zone}`
          : byIp
            ? `signed in from ${params.city} (${row?.basis})`
            : `Slack timezone is ${params.zone}`;
      (onInvite ? out.keep : out.add).push({ ...entry, reason: why });
      continue;
    }
    if (!onInvite) {
      continue;
    }
    if (observedElsewhere(row, params.city)) {
      out.remove.push({
        ...entry,
        reason: `signed in from ${row?.place_label} on ${row?.observed_at?.slice(0, 10)}`,
      });
      continue;
    }
    out.held.push({
      ...entry,
      reason:
        row?.basis === "carried"
          ? `last seen ${row.place_label ?? "elsewhere"}, ${row.days_since_observation} day(s) ago`
          : "no location on file",
    });
  }

  out.unknown_attendees = [...invited].filter((address) => !claimed.has(address)).sort();
  return out;
}

/**
 * The absolute guest list to send with `calendar.remove_attendees`.
 *
 * Built from the event's own list minus the people being dropped, so every address the sweep did
 * not judge -- externals, the room, the organiser -- survives. Never the set of people this module
 * approves of, which is the mistake that would quietly uninvite the caterer.
 */
export function remainingAttendees(
  attendees: readonly string[],
  removing: readonly LocalEventAudienceRow[],
): string[] {
  const dropped = new Set(removing.map((row) => row.email));
  return attendees
    .map((address) => address.trim())
    .filter((address) => address && !dropped.has(address.toLowerCase()));
}
