import type { AdminBotAuditEvent, AdminBotLabMember } from "../contracts/actions.js";
import type { AdminBotConferenceTripRecord } from "../contracts/conference-trips.js";
import {
  ADMINBOT_LOCATION_MAX_ACCURACY_M,
  type AdminBotLocationShareRecord,
  type AdminBotTravelConference,
  type AdminBotTravelMatchGroup,
  type AdminBotTravelOverview,
  type AdminBotTravelSharing,
} from "../contracts/lab-travel.js";
import {
  coarsenCoordinate,
  distanceKm,
  isFreshFix,
  isIsoDay,
  isoDay,
  matchTravellers,
  nearestPlace,
  placeForFix,
  travelConferenceSites,
  travelPlace,
  type TravelConferenceSite,
  type TravelPerson,
  type TravelPlace,
  type TravelTarget,
} from "../workflows/members/lab-travel.js";
import {
  canonicalConferenceTripKey,
  canonicalConferenceTrips,
} from "../workflows/papers/conference-attendance.js";
import type { AdminBotService, AdminBotServiceStore } from "./service.js";

// The Travel tab's server half. Every route lands here with a member id taken from the session,
// never from the body, so each method answers for exactly one viewer.
//
// The privacy rules, in one place:
//   - Only full members (privilege `member` or `admin`) reach any of this. Trial members and
//     external collaborators can be on the roster without being people the lab shares its
//     whereabouts with.
//   - Conference RSVPs: everyone's *going* answer is visible by name, with whether they are in the
//     Airbnb. Funding, visa letters and notes are the viewer's own and nobody else's.
//   - Trips, home and live fixes of other members are read only for a viewer who is sharing
//     theirs, and only from members who are sharing too.
//   - Another member's live fix leaves the service as a city name and a rounded distance, never as
//     coordinates.

const fail = (status: number, message: string) => ({
  ok: false as const,
  status,
  error: { message },
});

const ok = <T>(payload: T) => ({ ok: true as const, status: 200, payload });

/** Statuses whose members have left the lab, and so are nobody's company on a trip. */
const DEPARTED_STATUSES = new Set(["alumni"]);

const MAX_PLACE_LENGTH = 120;
const MAX_NOTES_LENGTH = 1000;
const MAX_LOOKUP_DAYS = 366;
/** A fix this soon after the last one, from about the same spot, is not worth a write. */
const MIN_REPORT_INTERVAL_MS = 15_000;
const MIN_REPORT_MOVE_KM = 0.5;

export function isTravelEntitled(member: Pick<AdminBotLabMember, "privilege_level"> | undefined) {
  return member?.privilege_level === "member" || member?.privilege_level === "admin";
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
}

export class LabTravelService {
  constructor(
    private store: AdminBotServiceStore,
    private dataset: () => readonly unknown[],
    private trips: Pick<AdminBotService, "setConferenceTrip" | "withdrawConferenceTrip">,
    private audit: (event: Omit<AdminBotAuditEvent, "id" | "timestamp">) => void,
    private now: () => Date = () => new Date(),
  ) {}

  private viewer(memberId: string) {
    const member = this.store.getLabMember(memberId);
    if (!member) {
      return fail(403, "A member session is required.");
    }
    if (!isTravelEntitled(member)) {
      return fail(403, "Travel is available to full lab members.");
    }
    return { ok: true as const, member };
  }

  private sites(today: string): TravelConferenceSite[] {
    return travelConferenceSites(this.dataset(), today);
  }

  private sharingFor(row: AdminBotLocationShareRecord | undefined): AdminBotTravelSharing {
    if (!row) {
      return { enabled: false };
    }
    const fresh =
      isFreshFix(row.reported_at, this.now()) && row.place_label !== undefined && row.reported_at;
    return {
      enabled: true,
      enabled_at: row.enabled_at,
      ...(fresh
        ? {
            location: {
              label: row.place_label!,
              ...(row.place_country ? { country: row.place_country } : {}),
              ...(row.place_key ? { key: row.place_key } : {}),
              ...(typeof row.place_distance_km === "number"
                ? { distance_km: Math.round(row.place_distance_km) }
                : {}),
              ...(typeof row.accuracy_m === "number" ? { accuracy_m: row.accuracy_m } : {}),
              reported_at: row.reported_at!,
            },
          }
        : {}),
    };
  }

  /** Every member who might be company, with exactly what the viewer may read about each. */
  private travellers(viewerId: string, sites: readonly TravelConferenceSite[]): TravelPerson[] {
    const now = this.now();
    const shares = new Map(this.store.listLocationShares().map((row) => [row.member_id, row]));
    const viewerShares = shares.has(viewerId);
    const sitesByKey = new Map(sites.map((site) => [site.key, site]));
    const going = new Map<string, AdminBotConferenceTripRecord[]>();
    for (const trip of canonicalConferenceTrips(this.store.listConferenceTrips())) {
      if (trip.intent === "going") {
        going.set(trip.member_id, [...(going.get(trip.member_id) ?? []), trip]);
      }
    }
    const people: TravelPerson[] = [];
    for (const member of this.store.listLabMembers()) {
      if (member.id === viewerId || DEPARTED_STATUSES.has(member.status ?? "")) {
        continue;
      }
      const conferences = (going.get(member.id) ?? []).flatMap((trip) => {
        const site = sitesByKey.get(trip.conference_key);
        return site?.place && site.starts && site.ends
          ? [{ label: site.label, starts: site.starts, ends: site.ends, place: site.place }]
          : [];
      });
      const share = viewerShares && isTravelEntitled(member) ? shares.get(member.id) : undefined;
      if (!share) {
        // Not sharing (or the viewer is not): only the RSVPs everybody can already see.
        if (conferences.length) {
          people.push({
            member_id: member.id,
            name: member.name,
            ...(member.avatar_url ? { avatar_url: member.avatar_url } : {}),
            trips: [],
            conferences,
          });
        }
        continue;
      }
      const homeText = member.current_city?.trim() || member.location?.trim();
      const live =
        isFreshFix(share.reported_at, now) &&
        typeof share.lat === "number" &&
        typeof share.lon === "number"
          ? {
              lat: share.lat,
              lon: share.lon,
              place: placeForFix(share),
              reported_at: share.reported_at!,
            }
          : undefined;
      people.push({
        member_id: member.id,
        name: member.name,
        ...(member.avatar_url ? { avatar_url: member.avatar_url } : {}),
        ...(homeText ? { home: travelPlace(homeText) } : {}),
        ...(live ? { live } : {}),
        trips: (member.trips ?? [])
          .filter((trip) => isIsoDay(trip.start) && isIsoDay(trip.end) && trip.city?.trim())
          .map((trip) => ({ start: trip.start, end: trip.end, place: travelPlace(trip.city) })),
        conferences,
      });
    }
    return people;
  }

  private conferencesFor(
    viewerId: string,
    sites: readonly TravelConferenceSite[],
  ): AdminBotTravelConference[] {
    const trips = canonicalConferenceTrips(this.store.listConferenceTrips());
    const members = new Map(this.store.listLabMembers().map((member) => [member.id, member]));
    const sitedGroups = new Set(
      trips
        .filter((trip) => trip.member_id === viewerId)
        .flatMap((trip) => sites.filter((site) => site.key === trip.conference_key))
        .map((site) => site.group_key),
    );
    return sites.map((site) => {
      const rows = trips.filter((trip) => trip.conference_key === site.key);
      const going = rows
        .filter((trip) => trip.intent === "going")
        .flatMap((trip) => {
          const member = members.get(trip.member_id);
          return member && !DEPARTED_STATUSES.has(member.status ?? "")
            ? [
                {
                  member_id: member.id,
                  name: member.name,
                  ...(member.avatar_url ? { avatar_url: member.avatar_url } : {}),
                  airbnb: trip.needs_lodging,
                },
              ]
            : [];
        })
        .toSorted((left, right) => left.name.localeCompare(right.name));
      const mine = rows.find((trip) => trip.member_id === viewerId);
      const unsited =
        site.multi_site && !sitedGroups.has(site.group_key)
          ? trips.find(
              (trip) => trip.member_id === viewerId && trip.conference_key === site.group_key,
            )
          : undefined;
      const { place: _place, ...facts } = site;
      return {
        ...facts,
        going,
        undecided_count: rows.filter((trip) => trip.intent === "undecided").length,
        airbnb_count: going.filter((person) => person.airbnb).length,
        ...(mine ? { my_rsvp: mine } : {}),
        ...(unsited ? { unsited_rsvp: unsited } : {}),
      };
    });
  }

  private viewerNow(
    member: AdminBotLabMember,
    share: AdminBotLocationShareRecord | undefined,
    today: string,
  ): { target: TravelTarget; title: string } | undefined {
    if (
      share &&
      isFreshFix(share.reported_at, this.now()) &&
      typeof share.lat === "number" &&
      typeof share.lon === "number"
    ) {
      const place = placeForFix(share);
      return {
        target: {
          place: {
            text: share.place_label ?? place.label,
            label: place.label,
            ...(place.country ? { country: place.country } : {}),
            ...(place.key ? { key: place.key } : {}),
            lat: share.lat,
            lon: share.lon,
          },
          from: today,
          to: today,
          origin: { lat: share.lat, lon: share.lon },
        },
        title: `Near you now — ${place.label}`,
      };
    }
    const trip = (member.trips ?? []).find(
      (row) => row.start <= today && today <= row.end && row.city?.trim(),
    );
    const text = trip?.city ?? (member.current_city?.trim() || member.location?.trim());
    if (!text) {
      return undefined;
    }
    const place = travelPlace(text);
    return {
      target: { place, from: today, to: today },
      title: trip ? `Where you are now — ${place.label}` : `At home — ${place.label}`,
    };
  }

  private matchGroups(
    member: AdminBotLabMember,
    share: AdminBotLocationShareRecord,
    sites: readonly TravelConferenceSite[],
    today: string,
  ): AdminBotTravelMatchGroup[] {
    const people = this.travellers(member.id, sites);
    const groups: AdminBotTravelMatchGroup[] = [];
    const group = (
      id: string,
      kind: AdminBotTravelMatchGroup["kind"],
      title: string,
      target: TravelTarget,
    ) => {
      groups.push({
        id,
        kind,
        title,
        place: {
          label: target.place.label,
          ...(target.place.country ? { country: target.place.country } : {}),
          ...(target.place.key ? { key: target.place.key } : {}),
        },
        ...(target.from !== target.to || kind !== "now"
          ? { from: target.from, to: target.to }
          : {}),
        people: matchTravellers(target, people, today),
      });
    };
    const current = this.viewerNow(member, share, today);
    if (current) {
      group("now", "now", current.title, current.target);
    }
    const horizon = addDays(today, MAX_LOOKUP_DAYS);
    (member.trips ?? [])
      .map((trip, index) => ({ trip, index }))
      .filter(
        ({ trip }) =>
          isIsoDay(trip.start) &&
          isIsoDay(trip.end) &&
          trip.city?.trim() &&
          trip.end >= today &&
          trip.start <= horizon,
      )
      .toSorted((left, right) => left.trip.start.localeCompare(right.trip.start))
      .slice(0, 12)
      .forEach(({ trip, index }) => {
        const place = travelPlace(trip.city);
        group(`trip:${index}`, "trip", `Your trip to ${place.label}`, {
          place,
          from: trip.start < today ? today : trip.start,
          to: trip.end,
        });
      });
    const mine = canonicalConferenceTrips(this.store.listConferenceTrips()).filter(
      (trip) => trip.member_id === member.id && trip.intent === "going",
    );
    for (const site of sites) {
      if (!site.place || !site.starts || !site.ends || site.ends < today) {
        continue;
      }
      if (mine.some((trip) => trip.conference_key === site.key)) {
        group(`conference:${site.key}`, "conference", site.label, {
          place: site.place,
          from: site.starts < today ? today : site.starts,
          to: site.ends,
        });
      }
    }
    return groups;
  }

  overview(memberId: string) {
    const viewer = this.viewer(memberId);
    if (!viewer.ok) {
      return viewer;
    }
    const today = isoDay(this.now());
    const sites = this.sites(today);
    const share = this.store.getLocationShare(memberId);
    const home = viewer.member.location?.trim();
    const overview: AdminBotTravelOverview = {
      today,
      conferences: this.conferencesFor(memberId, sites),
      sharing: this.sharingFor(share),
      plans: structuredClone(viewer.member.trips ?? []),
      ...(home ? { home } : {}),
      matches: share ? this.matchGroups(viewer.member, share, sites, today) : [],
    };
    return ok(overview);
  }

  setSharing(memberId: string, input: unknown) {
    const viewer = this.viewer(memberId);
    if (!viewer.ok) {
      return viewer;
    }
    const enabled = (input as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") {
      return fail(400, "Say whether to share your location: enabled must be true or false.");
    }
    const existing = this.store.getLocationShare(memberId);
    if (enabled && !existing) {
      this.store.saveLocationShare({ member_id: memberId, enabled_at: this.now().toISOString() });
      this.audit({ type: "location_sharing.enabled", actor: memberId, details: {} });
    }
    if (!enabled && this.store.deleteLocationShare(memberId)) {
      // The audit line says that sharing changed, never where anybody was.
      this.audit({ type: "location_sharing.disabled", actor: memberId, details: {} });
    }
    return ok({ sharing: this.sharingFor(this.store.getLocationShare(memberId)) });
  }

  reportLocation(memberId: string, input: unknown) {
    const viewer = this.viewer(memberId);
    if (!viewer.ok) {
      return viewer;
    }
    const existing = this.store.getLocationShare(memberId);
    if (!existing) {
      // Fail closed: a fix that arrives after opting out -- a slow request, a second tab that did
      // not hear about it -- is dropped, never stored.
      return fail(409, "Location sharing is off. Turn it on before sending your location.");
    }
    const body = (input ?? {}) as Record<string, unknown>;
    if (typeof body.place === "string") {
      return this.reportPlace(memberId, existing, body.place);
    }
    const lat = body.lat;
    const lon = body.lon;
    if (
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      return fail(400, "Send a latitude between -90 and 90 and a longitude between -180 and 180.");
    }
    const accuracy = body.accuracy_m;
    if (
      accuracy !== undefined &&
      (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0)
    ) {
      return fail(400, "accuracy_m must be a non-negative number of metres.");
    }
    if (typeof accuracy === "number" && accuracy > ADMINBOT_LOCATION_MAX_ACCURACY_M) {
      return fail(422, "That location is too imprecise to say which city you are in.");
    }
    const point = { lat: coarsenCoordinate(lat), lon: coarsenCoordinate(lon) };
    const now = this.now();
    if (
      existing.reported_at &&
      typeof existing.lat === "number" &&
      typeof existing.lon === "number" &&
      now.getTime() - Date.parse(existing.reported_at) < MIN_REPORT_INTERVAL_MS &&
      distanceKm(point, { lat: existing.lat, lon: existing.lon }) < MIN_REPORT_MOVE_KM
    ) {
      return ok({ sharing: this.sharingFor(existing) });
    }
    const nearest = nearestPlace(point);
    const record: AdminBotLocationShareRecord = {
      member_id: memberId,
      enabled_at: existing.enabled_at,
      lat: point.lat,
      lon: point.lon,
      ...(typeof accuracy === "number" ? { accuracy_m: Math.round(accuracy) } : {}),
      ...(nearest
        ? {
            place_key: nearest.place.key,
            place_label: nearest.place.label,
            place_country: nearest.place.country,
            place_distance_km: Math.round(nearest.distance_km * 10) / 10,
          }
        : {}),
      reported_at: now.toISOString(),
    };
    this.store.saveLocationShare(record);
    return ok({ sharing: this.sharingFor(record) });
  }

  /**
   * "I am in Lisbon", typed rather than measured.
   *
   * For a browser that cannot or will not give a position -- a desktop with no location services,
   * a page served without HTTPS, a member who would rather name the city than grant the
   * permission. Stored as the city's own centre, so it matches exactly like a measured fix and
   * reveals nothing finer than the name the member typed. Only cities the gazetteer knows: an
   * unknown name has no coordinates to measure anybody's distance from.
   */
  private reportPlace(memberId: string, existing: AdminBotLocationShareRecord, text: string) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_PLACE_LENGTH) {
      return fail(400, `Name a city of 1 to ${MAX_PLACE_LENGTH} characters.`);
    }
    const place = travelPlace(trimmed);
    if (!place.key || typeof place.lat !== "number" || typeof place.lon !== "number") {
      return fail(422, `AdminBot does not know where "${trimmed}" is. Try the nearest large city.`);
    }
    const record: AdminBotLocationShareRecord = {
      member_id: memberId,
      enabled_at: existing.enabled_at,
      lat: coarsenCoordinate(place.lat),
      lon: coarsenCoordinate(place.lon),
      place_key: place.key,
      place_label: place.label,
      ...(place.country ? { place_country: place.country } : {}),
      place_distance_km: 0,
      reported_at: this.now().toISOString(),
    };
    this.store.saveLocationShare(record);
    return ok({ sharing: this.sharingFor(record) });
  }

  /** Just the opt-in, for the page to decide on load whether to keep the location current. */
  sharing(memberId: string) {
    const viewer = this.viewer(memberId);
    if (!viewer.ok) {
      return viewer;
    }
    return ok({ sharing: this.sharingFor(this.store.getLocationShare(memberId)) });
  }

  whosIn(memberId: string, query: URLSearchParams) {
    const viewer = this.viewer(memberId);
    if (!viewer.ok) {
      return viewer;
    }
    const share = this.store.getLocationShare(memberId);
    if (!share) {
      return fail(403, "Share your own location to see where other members are.");
    }
    const placeText = (query.get("place") ?? "").trim();
    if (!placeText || placeText.length > MAX_PLACE_LENGTH) {
      return fail(400, `Name a place of 1 to ${MAX_PLACE_LENGTH} characters.`);
    }
    const today = isoDay(this.now());
    const from = query.get("from")?.trim() || today;
    const to = query.get("to")?.trim() || from;
    if (!isIsoDay(from) || !isIsoDay(to) || to < from) {
      return fail(400, "Use dates as YYYY-MM-DD, with the end on or after the start.");
    }
    if (to > addDays(from, MAX_LOOKUP_DAYS)) {
      return fail(400, "Look up at most a year at a time.");
    }
    const place: TravelPlace = travelPlace(placeText);
    const origin =
      isFreshFix(share.reported_at, this.now()) &&
      typeof share.lat === "number" &&
      typeof share.lon === "number"
        ? { lat: share.lat, lon: share.lon }
        : undefined;
    const people = matchTravellers(
      { place, from, to, ...(origin ? { origin } : {}) },
      this.travellers(memberId, this.sites(today)),
      today,
    );
    return ok({
      place: {
        label: place.label,
        ...(place.country ? { country: place.country } : {}),
        ...(place.key ? { key: place.key } : {}),
      },
      resolved: place.key !== undefined,
      from,
      to,
      people,
    });
  }

  rsvp(memberId: string, conferenceKey: string, input: unknown) {
    const viewer = this.viewer(memberId);
    if (!viewer.ok) {
      return viewer;
    }
    const key = canonicalConferenceTripKey(conferenceKey);
    const site = this.sites(isoDay(this.now())).find((entry) => entry.key === key);
    if (!site) {
      // Only conferences on the list. A free-form key would put a trip on the admins' booking
      // export for an event nobody can find.
      return fail(404, "That conference is not on the upcoming list.");
    }
    const body = (input ?? {}) as Record<string, unknown>;
    const notes = typeof body.notes === "string" ? body.notes : undefined;
    if (notes && notes.trim().length > MAX_NOTES_LENGTH) {
      return fail(400, `Keep notes under ${MAX_NOTES_LENGTH} characters.`);
    }
    const airbnb = body.needs_lodging === true;
    const arrival = typeof body.arrival_on === "string" ? body.arrival_on.trim() : "";
    const departure = typeof body.departure_on === "string" ? body.departure_on.trim() : "";
    for (const day of [arrival, departure]) {
      if (day && !isIsoDay(day)) {
        return fail(400, "Use dates as YYYY-MM-DD.");
      }
    }
    // An Airbnb place needs nights. When the member gave none, the conference's own days are the
    // honest default -- the admin booking reads these, and an empty span books nothing.
    const arrivalOn = arrival || (airbnb ? site.starts : undefined);
    const departureOn = departure || (airbnb ? site.ends : undefined);
    const saved = this.trips.setConferenceTrip({
      conferenceKey: site.key,
      memberId,
      intent: String(body.intent ?? ""),
      funding: String(body.funding ?? "none"),
      needsLodging: airbnb,
      needsVisaLetter: body.needs_visa_letter === true,
      ...(arrivalOn ? { arrivalOn } : {}),
      ...(departureOn ? { departureOn } : {}),
      ...(notes ? { notes } : {}),
    });
    if (!saved.ok) {
      return saved;
    }
    if (site.multi_site) {
      // A site answer supersedes an answer given to the conference as a whole, which predates the
      // split. Leaving both would count the member twice on the admins' export.
      for (const trip of this.store.listConferenceTrips()) {
        if (
          trip.member_id === memberId &&
          canonicalConferenceTripKey(trip.conference_key) === site.group_key
        ) {
          this.store.deleteConferenceTrip(trip.conference_key, memberId);
        }
      }
    }
    return saved;
  }

  withdraw(memberId: string, conferenceKey: string) {
    const viewer = this.viewer(memberId);
    if (!viewer.ok) {
      return viewer;
    }
    const key = canonicalConferenceTripKey(conferenceKey);
    const known = this.sites(isoDay(this.now())).some(
      (site) => site.key === key || site.group_key === key,
    );
    if (!known) {
      return fail(404, "That conference is not on the upcoming list.");
    }
    return this.trips.withdrawConferenceTrip({ conferenceKey: key, memberId });
  }

  /** Every site's label by key, past ones included, for the admins' booking export. */
  siteLabels(): Map<string, string> {
    return new Map(this.sites("0000-01-01").map((site) => [site.key, site.label]));
  }
}
