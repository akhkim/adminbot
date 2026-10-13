// The Travel tab's arithmetic: which conferences are coming up and where, where a browser location
// fix is in words, and who else in the lab will be in a place at a time.
//
// Pure functions over plain records. The service (kernel/service.lab-travel.ts) decides who may
// see what and hands this module only the people a viewer is entitled to read about; nothing here
// knows about sessions or the store, which is what keeps the privacy rules in one place.

import {
  ADMINBOT_LIVE_LOCATION_TTL_HOURS,
  ADMINBOT_LOCATION_STORED_PRECISION,
  ADMINBOT_NEARBY_RADIUS_KM,
  type AdminBotTravelMatch,
  type AdminBotTravelMatchBasis,
  type AdminBotTravelPlace,
} from "../../contracts/lab-travel.js";
import { conferenceKey } from "../papers/conference-attendance.js";
import { gazetteerPlaces, resolvePlace, type AdminBotMapPlace } from "./member-map.js";

// --- geography ---------------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance, in kilometres. */
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A coordinate at the precision the ledger is allowed to keep. */
export function coarsenCoordinate(value: number): number {
  const factor = 10 ** ADMINBOT_LOCATION_STORED_PRECISION;
  return Math.round(value * factor) / factor;
}

/** The gazetteer city closest to a coordinate, and how far away it is. */
export function nearestPlace(point: {
  lat: number;
  lon: number;
}): { place: AdminBotMapPlace; distance_km: number } | undefined {
  let best: { place: AdminBotMapPlace; distance_km: number } | undefined;
  for (const place of gazetteerPlaces()) {
    const distance = distanceKm(point, place);
    if (!best || distance < best.distance_km) {
      best = { place, distance_km: distance };
    }
  }
  return best;
}

/**
 * A fix as a place name another member may read.
 *
 * Inside the nearby radius it is simply the city. Further out it says "near" rather than naming a
 * city the person is not in: somebody 120 km from Lyon is not in Lyon, and a dinner invitation
 * built on that would be a long drive.
 */
export function placeForFix(fix: {
  place_key?: string;
  place_label?: string;
  place_country?: string;
  place_distance_km?: number;
}): AdminBotTravelPlace {
  const label = fix.place_label ?? "Unknown place";
  const far = (fix.place_distance_km ?? 0) > ADMINBOT_NEARBY_RADIUS_KM;
  return {
    label: far ? `Near ${label}` : label,
    ...(fix.place_country ? { country: fix.place_country } : {}),
    ...(fix.place_key && !far ? { key: fix.place_key } : {}),
  };
}

/** Distances shown to other people are rounded, so a fix cannot be triangulated back to a block. */
export function roundedDistanceKm(km: number): number {
  return km < 5 ? 0 : Math.round(km / 5) * 5;
}

/** Whether a fix is still recent enough to say where somebody is now. */
export function isFreshFix(reportedAt: string | undefined, now: Date): boolean {
  if (!reportedAt) {
    return false;
  }
  const at = Date.parse(reportedAt);
  return (
    Number.isFinite(at) &&
    now.getTime() - at <= ADMINBOT_LIVE_LOCATION_TTL_HOURS * 3_600_000 &&
    at <= now.getTime() + 5 * 60_000
  );
}

/** A free-text place resolved as far as it will go: coordinates when the gazetteer knows it. */
export type TravelPlace = {
  text: string;
  label: string;
  country?: string;
  key?: string;
  lat?: number;
  lon?: number;
};

function normalizedPlaceText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .split(/[,;/(]/u)[0]!
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function travelPlace(text: string): TravelPlace {
  const trimmed = text.trim();
  const resolved = resolvePlace(trimmed);
  return resolved
    ? {
        text: trimmed,
        label: resolved.label,
        country: resolved.country,
        key: resolved.key,
        lat: resolved.lat,
        lon: resolved.lon,
      }
    : { text: trimmed, label: trimmed.split(/[,;(]/u)[0]?.trim() || trimmed };
}

/**
 * Whether two places are the same place for the purpose of meeting up.
 *
 * Distance when both have coordinates, so Cambridge, MA and Boston count as one evening out.
 * Otherwise the first fragment of what people typed, compared loosely: two members who both wrote
 * "Hengqin" find each other even though neither spelling is in the gazetteer.
 */
export function samePlace(
  left: { text?: string; lat?: number; lon?: number },
  right: { text?: string; lat?: number; lon?: number },
): boolean {
  if (
    typeof left.lat === "number" &&
    typeof left.lon === "number" &&
    typeof right.lat === "number" &&
    typeof right.lon === "number"
  ) {
    return (
      distanceKm(left as { lat: number; lon: number }, right as { lat: number; lon: number }) <=
      ADMINBOT_NEARBY_RADIUS_KM
    );
  }
  const a = left.text ? normalizedPlaceText(left.text) : "";
  const b = right.text ? normalizedPlaceText(right.text) : "";
  return Boolean(a) && a === b;
}

/** Inclusive YYYY-MM-DD ranges overlap. */
export function rangesOverlap(
  a: { from: string; to: string },
  b: { from: string; to: string },
): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/** The overlap of two ranges, which is what "you will both be there" actually covers. */
function overlap(a: { from: string; to: string }, b: { from: string; to: string }) {
  return { from: a.from > b.from ? a.from : b.from, to: a.to < b.to ? a.to : b.to };
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// --- conferences -------------------------------------------------------------------------------

/** One upcoming conference at one site, before anybody's RSVP is attached. */
export type TravelConferenceSite = {
  key: string;
  group_key: string;
  label: string;
  conference_label: string;
  family: string;
  year: number;
  location?: string;
  city?: string;
  country?: string;
  multi_site: boolean;
  starts?: string;
  ends?: string;
  homepage_url?: string;
  place?: TravelPlace;
};

type DatasetRecord = {
  venue_type?: unknown;
  entry_type?: unknown;
  venue_group?: unknown;
  venue_family?: unknown;
  conference_location?: unknown;
  homepage_url?: unknown;
  link?: unknown;
  schedule?: unknown;
};

type ConferencePeriod = { label: string; starts: string; ends: string };

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function conferencePeriods(schedule: unknown): ConferencePeriod[] {
  if (!Array.isArray(schedule)) {
    return [];
  }
  return schedule.flatMap((entry) => {
    const row = entry as Record<string, unknown> | null;
    if (!row || row.milestone !== "conference") {
      return [];
    }
    const starts = textOf(row.starts) || textOf(row.date).slice(0, 10);
    const ends = textOf(row.ends) || starts;
    return isIsoDay(starts) && isIsoDay(ends) ? [{ label: textOf(row.label), starts, ends }] : [];
  });
}

/**
 * The site a milestone label names, when it names one.
 *
 * The dataset spells sites two ways: "Main conference (Hengqin, China)" and "Main conference —
 * Sydney". Both are read; a label with neither is the conference as a whole.
 */
function siteFromLabel(label: string): string | undefined {
  const parenthetical = /\(([^)]+)\)\s*$/u.exec(label)?.[1]?.trim();
  if (parenthetical) {
    return parenthetical;
  }
  const dashed = /\s[—–-]\s(.+)$/u.exec(label)?.[1]?.trim();
  return dashed || undefined;
}

function sameCity(site: string, mention: string): boolean {
  return normalizedPlaceText(site) === normalizedPlaceText(mention);
}

/**
 * Every upcoming conference, one entry per site.
 *
 * Read from the deadline dataset because that is where the lab already keeps each venue's
 * location and calendar; a second list of conferences would be a second thing to keep current.
 * Workshops are left out -- they meet at their parent conference, which is already the trip -- and
 * so is anything with neither a location nor conference dates, such as an ARR cycle, because there
 * is nowhere to travel to.
 */
export function travelConferenceSites(
  records: readonly unknown[],
  today: string,
): TravelConferenceSite[] {
  type Group = {
    name: string;
    family: string;
    year: number;
    location: string;
    homepage: string;
    periods: ConferencePeriod[];
  };
  const groups = new Map<string, Group>();
  for (const raw of records) {
    const record = (raw ?? {}) as DatasetRecord;
    if (record.venue_type === "workshop" || record.entry_type === "workshop") {
      continue;
    }
    const name = textOf(record.venue_group).replace(/\s+workshops?$/iu, "");
    const year = Number(/\b(20\d{2})\b/u.exec(name)?.[1]);
    if (!name || !Number.isInteger(year)) {
      continue;
    }
    const family = textOf(record.venue_family) || name.replace(String(year), "").trim();
    if (!family) {
      continue;
    }
    const key = conferenceKey(family, year);
    const group = groups.get(key) ?? {
      name,
      family,
      year,
      location: "",
      homepage: "",
      periods: [],
    };
    group.location ||= textOf(record.conference_location);
    group.homepage ||= textOf(record.homepage_url) || textOf(record.link);
    for (const period of conferencePeriods(record.schedule)) {
      if (
        !group.periods.some(
          (known) =>
            known.label === period.label &&
            known.starts === period.starts &&
            known.ends === period.ends,
        )
      ) {
        group.periods.push(period);
      }
    }
    groups.set(key, group);
  }

  const sites: TravelConferenceSite[] = [];
  const thisYear = Number(today.slice(0, 4));
  for (const [groupKey, group] of groups) {
    if (!group.location && !group.periods.length) {
      continue;
    }
    const named = group.location
      ? group.location
          .split(";")
          .map((site) => site.trim())
          .filter(Boolean)
      : [...new Set(group.periods.map((period) => siteFromLabel(period.label)).filter(Boolean))];
    const siteNames: Array<string | undefined> = named.length ? (named as string[]) : [undefined];
    const multi = siteNames.length > 1;
    for (const site of siteNames) {
      const city = site?.split(",")[0]?.trim();
      const country = site?.split(",").slice(1).join(",").trim() || undefined;
      const specific = city
        ? group.periods.find((period) => {
            const mention = siteFromLabel(period.label);
            return mention ? sameCity(mention, city) : false;
          })
        : undefined;
      const general = group.periods.find((period) => !siteFromLabel(period.label));
      const period =
        specific ?? general ?? (group.periods.length === 1 ? group.periods[0] : undefined);
      const lastDay = period?.ends ?? period?.starts;
      // Past conferences are not upcoming. An undated one stays until its year is out, which is
      // the honest reading of "NAACL 2027, dates to be announced".
      if (lastDay ? lastDay < today : group.year < thisYear) {
        continue;
      }
      const key = multi && city ? conferenceKey(`${group.family} ${city}`, group.year) : groupKey;
      sites.push({
        key,
        group_key: groupKey,
        label: multi && city ? `${group.name} — ${city}` : group.name,
        conference_label: group.name,
        family: group.family,
        year: group.year,
        multi_site: multi,
        ...(site ? { location: site } : {}),
        ...(city ? { city, place: travelPlace(site ?? city) } : {}),
        ...(country ? { country } : {}),
        ...(period ? { starts: period.starts, ends: period.ends } : {}),
        ...(group.homepage ? { homepage_url: group.homepage } : {}),
      });
    }
  }
  return sites.toSorted(
    (left, right) =>
      (left.starts ?? "9999").localeCompare(right.starts ?? "9999") ||
      left.label.localeCompare(right.label),
  );
}

// --- matching ----------------------------------------------------------------------------------

/**
 * One member as the matcher sees them: only what the viewer is entitled to read.
 *
 * `sharing` false means the service has already withheld their trips, home and live fix, so only
 * their conference RSVPs -- which every member can see on the conference card anyway -- remain.
 */
export type TravelPerson = {
  member_id: string;
  name: string;
  avatar_url?: string;
  home?: TravelPlace;
  live?: {
    lat: number;
    lon: number;
    place: AdminBotTravelPlace;
    reported_at: string;
  };
  trips: Array<{ start: string; end: string; place: TravelPlace }>;
  conferences: Array<{
    label: string;
    starts: string;
    ends: string;
    place: TravelPlace;
  }>;
};

/** A place and a span to ask "who else will be there" about. */
export type TravelTarget = {
  place: TravelPlace;
  from: string;
  to: string;
  /** The viewer's own live fix, when they have one, so a live match can say how far. */
  origin?: { lat: number; lon: number };
};

const BASIS_RANK: Record<AdminBotTravelMatchBasis, number> = {
  live: 0,
  trip: 1,
  conference: 2,
  home: 3,
};

function asTravelPlace(place: TravelPlace): AdminBotTravelPlace {
  return {
    label: place.label,
    ...(place.country ? { country: place.country } : {}),
    ...(place.key ? { key: place.key } : {}),
  };
}

/**
 * Who else will be at `target`, best evidence first.
 *
 * One line per person, carrying the strongest reason: a live fix beats a declared trip beats a
 * conference RSVP beats where they live. Somebody whose home is the target city but who is
 * demonstrably somewhere else -- a fresh fix elsewhere, or a trip away covering the whole span --
 * is left out; "lives in Paris" is a poor guess about somebody standing in Sydney.
 */
export function matchTravellers(
  target: TravelTarget,
  people: readonly TravelPerson[],
  today: string,
): AdminBotTravelMatch[] {
  const span = { from: target.from, to: target.to };
  const coversToday = target.from <= today && today <= target.to;
  const here = { text: target.place.text, lat: target.place.lat, lon: target.place.lon };
  const matches: AdminBotTravelMatch[] = [];
  for (const person of people) {
    const candidates: AdminBotTravelMatch[] = [];
    const base = {
      member_id: person.member_id,
      name: person.name,
      ...(person.avatar_url ? { avatar_url: person.avatar_url } : {}),
    };
    const liveElsewhere = Boolean(coversToday && person.live && !samePlace(here, person.live));
    if (coversToday && person.live && samePlace(here, person.live)) {
      const distance =
        target.origin && distanceKm(target.origin, person.live) <= ADMINBOT_NEARBY_RADIUS_KM
          ? roundedDistanceKm(distanceKm(target.origin, person.live))
          : undefined;
      candidates.push({
        ...base,
        basis: "live",
        place: person.live.place,
        as_of: person.live.reported_at,
        ...(distance !== undefined ? { distance_km: distance } : {}),
      });
    }
    for (const trip of person.trips) {
      const tripSpan = { from: trip.start, to: trip.end };
      if (rangesOverlap(span, tripSpan) && samePlace(here, trip.place)) {
        candidates.push({
          ...base,
          basis: "trip",
          place: asTravelPlace(trip.place),
          ...overlap(span, tripSpan),
        });
      }
    }
    for (const conference of person.conferences) {
      const conferenceSpan = { from: conference.starts, to: conference.ends };
      if (rangesOverlap(span, conferenceSpan) && samePlace(here, conference.place)) {
        candidates.push({
          ...base,
          basis: "conference",
          place: asTravelPlace(conference.place),
          conference_label: conference.label,
          ...overlap(span, conferenceSpan),
        });
      }
    }
    const awayForAll = person.trips.some(
      (trip) => trip.start <= span.from && span.to <= trip.end && !samePlace(here, trip.place),
    );
    if (person.home && samePlace(here, person.home) && !liveElsewhere && !awayForAll) {
      candidates.push({ ...base, basis: "home", place: asTravelPlace(person.home) });
    }
    const best = candidates.toSorted((a, b) => BASIS_RANK[a.basis] - BASIS_RANK[b.basis])[0];
    if (best) {
      matches.push(best);
    }
  }
  return matches.toSorted(
    (a, b) => BASIS_RANK[a.basis] - BASIS_RANK[b.basis] || a.name.localeCompare(b.name),
  );
}
