# Meetup intros (events and cities)

AdminBot nudges lab members who are in the same place to meet. Matching is by research interest
first. Place only decides that an intro is worth sending this week. Every intro is a Slack group DM
(`slack.conference_intro`) that goes through the normal proposal, policy and execution gate.

There are two kinds:

| Kind        | Default | Who is in the pool                                                                                                                                                        | Limit                                |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Event intro | On      | Members Going to the same event (paper roster or Travel/Events RSVP), plus members whose sign-in puts them in the event city while it runs, if they turned city intros on | One per member per event             |
| City intro  | Off     | Two or more members with city intros on whose last sign-in in the past 7 days was in the same metro                                                                       | One per member per metro per 14 days |

Members change both settings, or pause all intros for two weeks, on the **Events** tab. A member
who opted out or paused is never named in an intro, as the subject or as a partner.

## Who is matched with whom

- Each intro has a subject and up to two partners, ranked by shared research themes. Themes come
  from `research_topics` and `projects`, classified in `workflows/members/research-themes.ts`.
- Ties, and places with no shared theme, are filled from a seeded random order. The seed is the
  event or metro plus the member, so a retry offers the same people. The message says when a pick
  was random.
- **Pair history.** AdminBot never introduces the subject to someone it has already introduced
  them to, in any event or city intro. The two partners may already know each other: at an event,
  a newcomer meets two people from an earlier group.
- An event intro needs at least three people in the pool. A city intro needs two.
- Members who are alumni, have no linked Slack account, or are not full lab members are never
  included.

## When it is sent

- Only between 10:00 and 20:00 in every recipient's local time zone. The zone is taken from a
  sign-in in the last three days, otherwise from the profile. A recipient whose zone is unknown
  does not block the send.
- An intro outside those hours is deferred. An hourly sweep in the service retries deferred event
  and city intros, so most go out around 10:00 local.
- Triggers:
  - an RSVP of Going on the Travel or Events tab;
  - a sign-in whose IP geolocation places the member in a city. This checks events happening there
    and city intros, and runs at most one pass per sign-in;
  - the hourly sweep.

All runs share one serialized queue in the service. The idempotency keys are
`conference-intro:<event>:<member>` and `city-intro:<metro>:<member>:<day>`, and the Slack
`client_msg_id` comes from them. A replay therefore never posts twice.

## What the message says

Plain text (Slack `mrkdwn` off). It contains:

- **Match reason:** the names and the shared themes, or that the pick was random.
- **One concrete suggestion:** coffee between sessions or a poster walk at an event, or lunch or
  a coffee somewhere central in a city.
- **One conversation starter:** taken from a shared theme or from the partner's own project or
  paper titles.
- **Event details (event intros only):** dates, location with a map link, and the event page from
  the deadline dataset. If the dataset has no row, the message says so and does not guess.
- **Opt-out line:** "Not for you? Turn these intros off or snooze them in AdminBot > Events."

## Location and privacy

- Intros use only the coarse city that IPinfo returned for the member's last sign-in. For the
  viewer's own display, the Events tab falls back to the city on their profile, then to their
  Slack location. Coordinates are never stored or shown.
- Places are compared as metros. A small table joins suburbs, for example Palo Alto with San
  Francisco Bay Area, and keeps same-named cities apart, for example Cambridge, MA and Cambridge,
  UK. Outside the table, places within 50 km, or with the same city name, count as near.
- The Events tab shows the viewer their own city, with the note "based on your last sign-in
  location". It never shows another member's inferred city.
- **Also nearby** lists other members in the viewer's metro only when both the viewer and those
  members turned city intros on. Even then it shows only the metro, never a precise city.
- A city or event intro tells the recipients only the metro or event they share.

## Safety

- `autoPolicy("T1")`, the same as the other server-composed group DMs. The service computes the
  recipients and the text; no caller supplies them.
- The Slack executor refuses any `slack.conference_intro` payload that does not have two or three
  distinct Slack user IDs.
- An unexecuted attempt whose recipients or text have changed is removed and proposed again. An
  intro an admin rejected stays rejected.

## Manual run

`POST /papers/conference-rosters/<key>/intros` (admin session only) runs one event pass and
returns `{ introduced, skipped, deferred, failed }`. It does not resend delivered intros.

## Why these rules

The defaults follow tools that already do this for events and teams:

- **Brella** (<https://www.brella.io/>) and **Grip** (<https://grip.events/>) match event
  attendees on their stated interests and goals, not just on being present. Here, interests stay
  the core of the match.
- **Whova** (<https://whova.com/>) attendee networking and meetups are scoped to an event and are
  opt-in. Here, event intros are on by default only for people who said they are Going.
- **SXSW / DoubleDutch**-style event apps tie "who's here" features to the event window. That is
  why location only matters during an event or within a 7-day city window here.
- **Donut for Slack** (<https://www.donut.com/>) pairs teammates on a fixed cadence and avoids
  repeat pairings, and people can skip or leave. That is the source of the pair history, the
  14-day city cooldown, the daytime-only sends and the opt-out line in every message.
