// When somebody moved, and whether to ask them about it.
//
// The roster's three location fields each overwrite themselves, so "where is this person" was
// answerable and "when did they move" was not. This module is the second question: observations
// are appended, never overwritten, and the timeline that falls out is what tells a scheduler that
// a member has been signing in from Berlin for three weeks.
//
// Two rules shape everything here, and both exist to keep an inference from impersonating a fact:
//
//   1. An observation is recorded only when it *differs* from the last one from the same source.
//      Otherwise a member who signs in twice a day produces 700 identical rows a year and the
//      timeline stops being a change log.
//   2. A divergence between inference and profile produces a *question*, never a write. The member
//      answers it; their answer is self-reported and goes through the same path as any field they
//      type. Nothing here edits a profile.
import { randomUUID } from "node:crypto";
import type {
  AdminBotLabMember,
  AdminBotLocationDrift,
  AdminBotLocationSource,
  AdminBotMemberLocationEntry,
} from "../../contracts/actions.js";
import { tripOn } from "./availability.js";
import { resolveCountry, resolvePlace } from "./member-map.js";

/**
 * How much agreement it takes before a member is asked whether they moved.
 *
 * Two sign-ins spanning three days, because the alternative is asking everyone who joins a call
 * over hotel wifi. A conference trip is one or two days from one place; a move keeps producing the
 * same country for a week. Three days is the cheapest separator between those that does not also
 * delay a real move past the point of being useful.
 */
export const LOCATION_DRIFT_MIN_OBSERVATIONS = 2;
export const LOCATION_DRIFT_MIN_DAYS = 3;

const DAY_MS = 86_400_000;

/**
 * An observation, resolved against the gazetteer, or undefined when there is nothing to record.
 *
 * A country name goes through `resolveCountry` and free text through `resolvePlace`, because they
 * are different claims: "Germany" from an IP lookup is a country, and "Berlin" from a profile is a
 * city that implies one. Text that resolves to nothing is still recorded — an unplaceable location
 * is exactly the entry an admin needs to see in order to add it to the gazetteer.
 */
export function observationFor(params: {
  memberId: string;
  source: AdminBotLocationSource;
  raw: string;
  observedAt: string;
  timezone?: string;
}): AdminBotMemberLocationEntry | undefined {
  const raw = params.raw.trim();
  if (!raw) {
    return undefined;
  }
  const place = params.source === "login_ip" ? resolveCountry(raw) : resolvePlace(raw);
  return {
    id: `loc_${randomUUID()}`,
    member_id: params.memberId,
    observed_at: params.observedAt,
    source: params.source,
    raw,
    ...(place ? { place_key: place.key, place_label: place.label, country: place.country } : {}),
    // A timezone is only ever a self-report; see the field's note in contracts.
    ...(params.timezone && params.source === "self_reported" ? { timezone: params.timezone } : {}),
  };
}

/**
 * Whether an observation says anything the last one from that source did not.
 *
 * Compared on the resolved place first and the raw text second: "Toronto" and "Toronto, Canada"
 * are the same claim and must not both be recorded, while two unresolvable strings can only be
 * compared as text.
 */
export function isNewObservation(
  latest: AdminBotMemberLocationEntry | undefined,
  candidate: AdminBotMemberLocationEntry,
): boolean {
  if (!latest) {
    return true;
  }
  if (latest.place_key || candidate.place_key) {
    return latest.place_key !== candidate.place_key;
  }
  return normalize(latest.raw) !== normalize(candidate.raw);
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

/** The most recent entry per source, which is what "where do we think they are" reads from. */
export function latestBySource(
  history: readonly AdminBotMemberLocationEntry[],
): Map<AdminBotLocationSource, AdminBotMemberLocationEntry> {
  const latest = new Map<AdminBotLocationSource, AdminBotMemberLocationEntry>();
  for (const entry of history) {
    const held = latest.get(entry.source);
    if (!held || held.observed_at < entry.observed_at) {
      latest.set(entry.source, entry);
    }
  }
  return latest;
}

/**
 * The country the member's own record claims for a given day.
 *
 * A logged trip wins, and that is the whole reason this takes a date. A member who wrote down
 * "Berlin, 1-30 September" has already answered the question the drift prompt would ask, and
 * asking it anyway is how a system teaches people that filling things in changes nothing.
 * Otherwise it falls back to where they say they are now, then to where they live.
 */
export function profileCountry(member: AdminBotLabMember, dayIso?: string): string | undefined {
  const trip = dayIso ? tripOn(member, dayIso) : undefined;
  const stated = trip?.city.trim() || member.current_city?.trim() || member.location?.trim();
  return stated ? resolvePlace(stated)?.country : undefined;
}

/**
 * The question to put to a member, or undefined when there is nothing to ask.
 *
 * Silent in every case where asking would be noise: no sign-in evidence, a profile that already
 * agrees, a country the gazetteer cannot place, a trip too short to be a move, or a question this
 * member has already answered about this country. That last one is why a dismissal is stored with
 * the country attached — "no, still Toronto" settles Germany, and says nothing about Japan.
 */
export function detectLocationDrift(
  member: AdminBotLabMember,
  history: readonly AdminBotMemberLocationEntry[],
  now: Date,
  options?: { minObservations?: number; minDays?: number },
): AdminBotLocationDrift | undefined {
  const minObservations = options?.minObservations ?? LOCATION_DRIFT_MIN_OBSERVATIONS;
  const minDays = options?.minDays ?? LOCATION_DRIFT_MIN_DAYS;
  const logins = history
    .filter((entry) => entry.source === "login_ip" && entry.country)
    .toSorted((left, right) => left.observed_at.localeCompare(right.observed_at));
  const newest = logins.at(-1);
  if (!newest?.country) {
    return undefined;
  }
  // Judged against the day the newest sign-in was seen, so a trip that covers it counts.
  const claimed = profileCountry(member, newest.observed_at.slice(0, 10));
  if (!claimed || claimed === newest.country) {
    return undefined;
  }
  // Only the unbroken run of the current country counts. A member who went Canada -> Germany ->
  // Canada -> Germany has not been in Germany for a month, and counting every German row would say
  // they had.
  const run: AdminBotMemberLocationEntry[] = [];
  for (const entry of logins.toReversed()) {
    if (entry.country !== newest.country) {
      break;
    }
    run.unshift(entry);
  }
  const first = run[0];
  if (!first || run.length < minObservations) {
    return undefined;
  }
  if (Date.parse(newest.observed_at) - Date.parse(first.observed_at) < minDays * DAY_MS) {
    return undefined;
  }
  // Already answered, for this country, after the divergence began. A different country later is a
  // different question and asks again.
  if (
    member.location_prompt_answered_country === newest.country &&
    member.location_prompt_answered_at &&
    member.location_prompt_answered_at >= first.observed_at
  ) {
    return undefined;
  }
  void now;
  return {
    member_id: member.id,
    observed_country: newest.country,
    ...(newest.place_label ? { observed_label: newest.place_label } : {}),
    ...(claimedLocation(member, newest.observed_at.slice(0, 10))
      ? { profile_location: claimedLocation(member, newest.observed_at.slice(0, 10)) }
      : {}),
    ...(claimed ? { profile_country: claimed } : {}),
    since: first.observed_at,
    observation_count: run.length,
  };
}

/**
 * The location fields a profile edit should be recorded under, when it changed one.
 *
 * Called on every member write, so it has to be cheap and it has to be silent when nothing about
 * where the person is has changed — most member edits are about a paper or a phone number.
 */
export function selfReportedChange(
  previous: AdminBotLabMember | undefined,
  next: AdminBotLabMember,
): { raw: string; timezone?: string } | undefined {
  const stated = next.current_city?.trim() || next.location?.trim();
  if (!stated) {
    return undefined;
  }
  const before = previous?.current_city?.trim() || previous?.location?.trim();
  if (before && normalize(before) === normalize(stated)) {
    return undefined;
  }
  return { raw: stated, ...(next.timezone?.trim() ? { timezone: next.timezone.trim() } : {}) };
}

/** What the record says the member's location is on a day, as text, for quoting back to them. */
function claimedLocation(member: AdminBotLabMember, dayIso: string): string | undefined {
  return tripOn(member, dayIso)?.city.trim() || member.current_city?.trim() || member.location?.trim();
}
