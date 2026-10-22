---
summary: "Member travel: conference Going answers on Events, trips on Time Availability, and opt-in location sharing behind Events' nearby card"
read_when:
  - Changing conference RSVPs, travel plans or location sharing
  - Answering what a member's location sharing exposes and to whom
title: "Travel"
---

# Travel

There used to be a **My Info → Travel** tab (`/lab-travel`) with three cards. It overlapped with
**Events**, so it was removed and its parts now live here:

| Part                                | Where it is now                                                             |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Upcoming conferences and RSVPs      | **Events**: each event's _Going_ / _Not going_ toggle                       |
| Your other travel plans             | **Time Availability → Add commitment → Trip Away**                          |
| Find lab members nearby (opt-in)    | **Events**, as the "Find lab members nearby" card under the event lists     |

`/lab-travel` still resolves and opens Events, so old links in paper cards and Slack keep working.
The `/travel` service routes below are unchanged; Events and Time Availability call them.

The detailed RSVP form (lab Airbnb nights, funding, visa letter, notes) went with the tab. Answers
already stored keep their fields, and paper cards still read them back ("staying in the lab
Airbnb"), but members can no longer enter them in the UI.

The head professor's sign-in travel history is a different surface, **My Desk → Travel History**
(`/travel` in the Control UI), and is unchanged.

## Who can use it

Full members and admins (`privilege_level` `member` or `admin`). Trial members and external
collaborators do not see Events, and every `/travel` route refuses them (403). Every route also
requires a member session: the service token — which is what the agent uses — is refused (403), so
none of this is readable by the model.

Trips on Time Availability are saved through the member's own schedule, so every member who can
open Time Availability can log them.

## Conference RSVPs

RSVPs are the existing `adminbot_conference_trips` rows: a single-site conference uses the same key
an accepted paper uses (`emnlp:2026`), a multi-site one a per-site key (`neuripsparis:2026`). Events
writes _Going_ through `PUT /travel/conferences/:key/rsvp` and _Not going_ through the matching
`DELETE`. Accepted papers on **My Projects & Papers** read back the member's RSVP and link to
Events.

## Travel plans

Trips that are not a listed conference: the schedule's `trips` rows, which the Time Availability
where-strip, the calendar and the nearby matches all read. Admins can read them as before.

## Find lab members nearby (opt-in)

Off by default. Turning it on shares, **with other members who have also turned it on**:

- the city the member is in, from this browser's Geolocation API — stored rounded to 0.01°
  (~1 km), shown to others only as the nearest known city and a distance rounded to 5 km, and
  ignored after 72 hours;
- the city they live in (`current_city`, else `location`);
- the city and dates of their travel plans (never the notes or links).

Sharing is reciprocal: a member who has not opted in sees nobody's whereabouts and cannot use the
"Who's in…" lookup (the card only shows it while sharing is on). Conference _Going_ answers are
matched for everyone, since they are already visible on Events.

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
`{ "trips": [...] }`. The `conferences` and `plans` fields of `GET /travel` are no longer drawn by
the Control UI; Events reads conferences from `/events`, and Time Availability reads trips from the
member's own record.
