// The member-facing Travel tab: upcoming conferences to RSVP for, the member's own trips, and the
// opt-in that lets lab members find each other when they are in the same city.
//
// Three different disclosures live here, and each has its own audience on purpose:
//
//   - A conference RSVP is a statement to the lab. "I am going to NeurIPS in Paris and staying in
//     the lab Airbnb" is the thing other members need to read to plan around it, so the names of
//     the people going are shown to every full member. What they need paid for, the visa letter and
//     their notes are not: those stay between the member and the admins, exactly as on the old
//     paper-card form (see contracts/conference-trips.ts).
//   - A declared trip (`AdminBotMemberTrip` on the schedule) is planning data, self-and-admin only
//     by default. It is shown to another member only when *both* of them have opted in to sharing
//     their whereabouts, and then only as a city and a date range -- never the note or the link.
//   - A live location fix from the browser is the most sensitive of the three. It is never stored
//     more precisely than ~1 km, never returned to anybody else as coordinates (only as the nearest
//     known city and a rounded distance), expires after `ADMINBOT_LIVE_LOCATION_TTL_HOURS`, and is
//     deleted outright the moment the member opts out.
//
// Sharing is reciprocal: a member who has not opted in sees nobody else's whereabouts. Reading other
// people's locations while hiding your own is the asymmetry that makes an opt-in feel like
// surveillance, and refusing it costs the feature nothing -- the people you want to find are the
// people who chose to be found.

import type { AdminBotConferenceTripRecord } from "./conference-trips.js";

/**
 * How long a browser location fix stands for "where this person is now".
 *
 * Three days because the use case is a trip: somebody opens AdminBot once on arrival in Paris and
 * then not again until they are home. A day would drop them off the map halfway through a
 * conference; a week would keep announcing them in Paris after they flew back.
 */
export const ADMINBOT_LIVE_LOCATION_TTL_HOURS = 72;

/**
 * How far apart two people can be and still count as "in the same place".
 *
 * A metro area, not a neighbourhood: the question is "who can I get dinner with", and Paris to
 * Saclay is the same evening while Paris to Lyon is not.
 */
export const ADMINBOT_NEARBY_RADIUS_KM = 50;

/**
 * Coordinates are rounded to this many decimal places before they are stored: 0.01° is ~1.1 km.
 *
 * Fine enough to name the city and measure the distance to a colleague, coarse enough that the
 * ledger never holds a street address -- which is all a raw GPS fix from a phone in a hotel is.
 */
export const ADMINBOT_LOCATION_STORED_PRECISION = 2;

/** A fix this vague cannot say which city somebody is in, so it is refused rather than stored. */
export const ADMINBOT_LOCATION_MAX_ACCURACY_M = 100_000;

/**
 * One member's opt-in, and their last browser location fix while it is on.
 *
 * No row means not sharing, and opting out deletes the row: there is no "disabled" state that
 * keeps the last position around.
 */
export type AdminBotLocationShareRecord = {
  member_id: string;
  enabled_at: string;
  /** Rounded to ADMINBOT_LOCATION_STORED_PRECISION. Absent until the first fix arrives. */
  lat?: number;
  lon?: number;
  /** What the browser reported, in metres, so a coarse fix can say so on screen. */
  accuracy_m?: number;
  /** The nearest gazetteer city to the fix, and how far it is from it. */
  place_key?: string;
  place_label?: string;
  place_country?: string;
  place_distance_km?: number;
  reported_at?: string;
};

/** Where somebody is, as another member is allowed to read it: a city, never coordinates. */
export type AdminBotTravelPlace = {
  label: string;
  country?: string;
  /** Gazetteer key when the place resolved, so the UI can group by city. */
  key?: string;
};

/** The viewer's own sharing state, as the opt-in card draws it. */
export type AdminBotTravelSharing = {
  enabled: boolean;
  enabled_at?: string;
  /** Present only while a fix is fresh. The member's own, so the exact distance is fine to show. */
  location?: AdminBotTravelPlace & {
    distance_km?: number;
    accuracy_m?: number;
    reported_at: string;
  };
};

/** How we know somebody will be in a place, in the order a reader trusts them. */
export type AdminBotTravelMatchBasis = "live" | "trip" | "conference" | "home";

/** One lab member who is, or will be, in the place being asked about. */
export type AdminBotTravelMatch = {
  member_id: string;
  name: string;
  avatar_url?: string;
  basis: AdminBotTravelMatchBasis;
  place: AdminBotTravelPlace;
  /** The overlapping span for trip and conference matches, YYYY-MM-DD. */
  from?: string;
  to?: string;
  /** Rounded to the nearest 5 km, live matches only, and only when both sides have a live fix. */
  distance_km?: number;
  /** When a live fix was taken, so "in Paris" can say "as of yesterday". */
  as_of?: string;
  /** A conference match: which one, e.g. "NeurIPS 2026 — Paris". */
  conference_label?: string;
};

/** One place-and-time the viewer is, or will be, somewhere: and who else will be there. */
export type AdminBotTravelMatchGroup = {
  /** "now", a trip index ("trip:2") or a conference key ("conference:neuripsparis:2026"). */
  id: string;
  kind: "now" | "trip" | "conference";
  /** "You are in Paris", "Your trip to Berlin", "NeurIPS 2026 — Paris". */
  title: string;
  place: AdminBotTravelPlace;
  from?: string;
  to?: string;
  people: AdminBotTravelMatch[];
};

/** One member going to a conference site, as every full member may read it. */
export type AdminBotTravelAttendee = {
  member_id: string;
  name: string;
  avatar_url?: string;
  /** Staying in the lab Airbnb. */
  airbnb: boolean;
};

/**
 * One conference at one location.
 *
 * NeurIPS 2026 meets in Sydney, Atlanta and Paris at once, and those are three different trips --
 * different flights, different nights, a different house to rent -- so each site is its own entry
 * with its own RSVP and its own Airbnb. A single-site conference is one entry keyed exactly the way
 * an accepted paper keys its conference (`emnlp:2026`), so an answer given before this tab existed
 * is the answer this tab shows.
 */
export type AdminBotTravelConference = {
  key: string;
  /** The conference as a whole, e.g. `neurips:2026`. Equal to `key` for a single-site event. */
  group_key: string;
  /** "NeurIPS 2026 — Paris", or "EMNLP 2026" when there is only one site. */
  label: string;
  /** "NeurIPS 2026". */
  conference_label: string;
  family: string;
  year: number;
  /** "Paris, France". Absent when the venue has not published one. */
  location?: string;
  city?: string;
  country?: string;
  multi_site: boolean;
  /** The main conference days at this site, YYYY-MM-DD. */
  starts?: string;
  ends?: string;
  homepage_url?: string;
  going: AdminBotTravelAttendee[];
  undecided_count: number;
  airbnb_count: number;
  /** The viewer's own answer for this site, in full. */
  my_rsvp?: AdminBotConferenceTripRecord;
  /**
   * The viewer said they were going to this conference before it was split into sites (from an
   * accepted paper's card), and has not picked a site yet. Shown so the answer is not silently
   * lost; the next RSVP to a site replaces it.
   */
  unsited_rsvp?: AdminBotConferenceTripRecord;
};

/** A trip as another member may read it: the place and the dates, nothing else. */
export type AdminBotTravelPlan = {
  start: string;
  end: string;
  city: string;
  timezone?: string;
  note?: string;
  link?: string;
};

/** Everything the Travel tab draws, for one viewer. */
export type AdminBotTravelOverview = {
  today: string;
  conferences: AdminBotTravelConference[];
  sharing: AdminBotTravelSharing;
  /** The viewer's own declared trips, in full -- they are the viewer's to edit. */
  plans: AdminBotTravelPlan[];
  /** The viewer's home, for "away from" copy and for matching people who live where they go. */
  home?: string;
  /** Empty unless sharing is on: matching reads other people's whereabouts. */
  matches: AdminBotTravelMatchGroup[];
  /**
   * How many other members share their location, so an empty match can say how few were checked.
   * Everyone else is matched only by conference RSVPs. 0 unless the viewer shares.
   */
  sharing_members: number;
};
