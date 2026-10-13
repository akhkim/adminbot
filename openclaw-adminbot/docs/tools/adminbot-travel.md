---
summary: "The member Travel tab: conference RSVPs per site, the lab Airbnb, travel plans, and opt-in location sharing"
read_when:
  - Changing conference RSVPs, travel plans or location sharing
  - Answering what a member's location sharing exposes and to whom
title: "Travel"
---

# Travel

**My Info → Travel** (`/lab-travel`) is where a full member says where they are going and finds
other lab members in the same place. It has three cards.

The head professor's sign-in travel history is a different surface, **My Desk → Travel History**
(`/travel`), and is unchanged.

## Who can open it

Full members and admins (`privilege_level` `member` or `admin`). Trial members and external
collaborators do not see the tab, and every `/travel` route refuses them (403). Every route also
requires a member session: the service token — which is what the agent uses — is refused (403), so
nothing on this page is readable by the model.

## Upcoming conferences

Read from the deadline dataset (`conference_location` and the `conference` schedule milestones), so
it updates with the Deadlines board. A conference that meets in several places is listed **once per
site** — NeurIPS 2026 appears as Sydney, Paris and Atlanta, each with its own days, RSVP and Airbnb.
Workshops, ARR cycles and past conferences are left out.

An RSVP is _Going_ or _Maybe_; _I'm not going_ deletes it. Going asks:

- **Stay in the lab Airbnb** — the bed count admins book against. The nights default to the
  conference days at that site.
- What the lab should cover, whether a visa invitation letter is needed, and free-text notes.

Every full member sees **who is going** to each site and whether they are in the Airbnb. Funding,
visa letter and notes are visible only to the member and admins. RSVPs are the existing
`adminbot_conference_trips` rows: a single-site conference uses the same key an accepted paper
uses (`emnlp:2026`), a multi-site one a per-site key (`neuripsparis:2026`). An answer given on a
paper card before a conference was split into sites is shown as "pick a site" and replaced by the
first site RSVP. The admins' conference travel export names site rows by site.

Accepted papers on **My Projects & Papers** no longer carry the trip form; they read back the
member's RSVP and link here.

## Your other travel plans

Trips that are not a listed conference. These are the schedule's `trips` rows — the same field the
Time Availability where-strip and the calendar read — so Time Availability no longer has its own
trip editor. Admins can read them as before.

## Find lab members nearby (opt-in)

Off by default. Turning it on shares, **with other members who have also turned it on**:

- the city the member is in, from this browser's Geolocation API — stored rounded to 0.01°
  (~1 km), shown to others only as the nearest known city and a distance rounded to 5 km, and
  ignored after 72 hours;
- the city they live in (`current_city`, else `location`);
- the city and dates of their travel plans (never the notes or links).

Sharing is reciprocal: a member who has not opted in sees nobody's whereabouts and cannot use the
"Who's in…" lookup. Conference _Going_ answers are matched for everyone, since they are already
visible on the conference list.

While sharing is on, the page keeps the location current on **any** tab: it watches the browser's
position and sends a fix after moving 1 km or every 20 minutes, re-checks every 30 minutes and when
the page becomes visible. It never prompts for permission by itself — a browser that has not granted
it waits for **Use this browser's location**. Browsers only offer location to HTTPS pages (and
localhost); where location is blocked or unavailable, the member can type the city instead (it must
be a city the gazetteer in `workflows/members/member-map.ts` knows).

**Stop sharing** deletes the stored row immediately; a fix that arrives afterwards is refused (409).
The audit log records `location_sharing.enabled` / `location_sharing.disabled` and never a position.
Fixes are not added to the sign-in location history (`adminbot_member_locations`), and responses
from `/travel` are never written to the Control UI's offline cache.

No third party is involved: a fix is named by the nearest entry in the built-in gazetteer, not by a
reverse-geocoding service.

## Routes

| Method and path                        | Does                                                |
| -------------------------------------- | --------------------------------------------------- |
| `GET /travel`                          | Conferences, own plans, sharing state, match groups |
| `GET /travel/sharing`                  | Just the opt-in (read once per page load)           |
| `PUT /travel/sharing`                  | `{ "enabled": true \| false }`                      |
| `POST /travel/location`                | `{ lat, lon, accuracy_m? }` or `{ place }`          |
| `GET /travel/whos-in?place=&from=&to=` | Who will be in a place, sharing members only        |
| `PUT /travel/conferences/:key/rsvp`    | RSVP to a listed site                               |
| `DELETE /travel/conferences/:key/rsvp` | Withdraw                                            |

Plans are saved through the existing self-service schedule write, `PUT /lab/members/:id` with
`{ "trips": [...] }`.
