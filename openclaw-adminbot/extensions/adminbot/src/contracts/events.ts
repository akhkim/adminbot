// The member Events tab: upcoming lab-relevant events, who is going, and who is nearby.
//
// Everything about another member's whereabouts arrives here already coarsened to a metro label;
// coordinates never leave the service, and the viewer's own sign-in city is the only inferred
// place in the payload (see kernel/service.meetups.ts for who may read what).
import type { AdminBotConferenceTripRecord } from "./conference-trips.js";

export type AdminBotEventPerson = {
  member_id: string;
  name: string;
  avatar_url?: string;
};

export type AdminBotEventCard = {
  /** The RSVP key (a site key for a multi-site event). */
  key: string;
  /** The conference as a whole: what intros and the paper rosters key on. */
  group_key: string;
  label: string;
  starts?: string;
  ends?: string;
  /** "City, Country" as the dataset gives it. */
  location?: string;
  map_url?: string;
  homepage_url?: string;
  status: "upcoming" | "happening" | "past";
  /** Whole days to the first day; present for upcoming events with a date. */
  days_until?: number;
  going: AdminBotEventPerson[];
  /** Somebody on an accepted paper for this event (from the paper rosters). */
  on_paper: boolean;
  my_rsvp?: AdminBotConferenceTripRecord;
  /** The viewer said Going here or on a paper roster. */
  i_am_going: boolean;
  /** Whether the Going toggle can be used: a dataset event that has not ended. */
  can_rsvp: boolean;
  near_you: boolean;
  /** Set during the event when the viewer is in its city and not Going. */
  in_town_prompt?: string;
};

export type AdminBotMeetupPreferences = {
  events: boolean;
  city: boolean;
  snoozed_until?: string;
};

export type AdminBotEventsOverview = {
  today: string;
  /** The viewer's own place, for their eyes only. */
  viewer_location?: {
    label: string;
    source: "sign_in" | "profile" | "slack";
  };
  preferences: AdminBotMeetupPreferences;
  events: AdminBotEventCard[];
  past: AdminBotEventCard[];
  /**
   * Other opted-in members whose recent place is the viewer's metro. Absent unless the viewer has
   * city intros on (`locked` says so, without naming anyone).
   */
  also_nearby?:
    | { locked: true }
    | { locked: false; place_label: string; people: AdminBotEventPerson[] };
};
