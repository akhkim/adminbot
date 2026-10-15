# Meetup intros (events and cities)

AdminBot nudges lab members who are in the same place to meet. Matching is by research interest
first. Place only decides that an intro is worth sending this week. Every intro is a Slack group DM
(`slack.conference_intro`) that goes through the normal proposal, policy and execution gate.

It is zero setup. Both kinds are on for every active lab member with a linked Slack account. There
is no admin switch, environment variable or new Slack scope. A member's only controls are the
footer link in every intro, the **Meet lab-mates nearby** switch on My Profile, and the finer
settings on the **Events** tab.

There are two kinds of automatic intro:

| Kind        | Default | Who is in the pool                                                                                                                                                        | Limit                                |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Event intro | On      | Members Going to the same event (paper roster or Travel/Events RSVP), plus members whose sign-in puts them in the event city while it runs, if they turned city intros on | One per member per event             |
| City intro  | On      | Two or more members with city intros on whose last sign-in in the past 7 days was in the same metro, at least one of them visiting                                        | One per member per metro per 14 days |

Members change both settings, or pause all intros for two weeks, on the **Events** tab. A member
who opted out or paused is never named in an intro, as the subject or as a partner.

**Home rule.** Two people who both live in the metro are never given a city intro there: that would
be a daily nudge to meet your office-mates. A member is at home when their profile's current city,
otherwise their location, otherwise their Slack location, is in the metro. At least one person in a
city intro is visiting.

**Do not contact.** Admins can set `do_not_contact` on a member (members cannot set it on
themselves). That member is never introduced, never offered as a Say hi target, and never listed as
nearby. Their own Going answer still shows on event cards.

## Say hi

Every event card and every nearby face has a **Say hi** button. One tap creates the Slack group DM
at once, with a short "Ada says hi" message. It counts as an introduction, so the automatic intro
never pairs the same people again. Say hi is idempotent (`say-hi:event:<event>:<member>` and
`say-hi:city:<pair>`): a second tap, from either side of a pair, reports "already said hi" and sends
nothing. It is not held for quiet hours, because the member chose to send it now.

The **Nearby now** strip on the Collaborate tab shows lab-mates around the viewer's metro this week,
each with Say hi. It is drawn only when the viewer has city intros on and someone is there.

## Who is matched with whom

- Each intro has a subject and up to two partners: the closest research match, then one
  **wildcard**. The match is ranked by shared research themes, which come from `research_topics`
  and `projects` and are classified in `workflows/members/research-themes.ts`. The wildcard is
  drawn from everyone else, because the people you already share a theme with are the ones you
  would have found anyway. The message labels it "this round's wildcard".
- Ties and the wildcard use a seeded hash, never `Math.random`. The seed is the event or metro plus
  the member, so a retry offers the same people.
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

Slack Block Kit: a header ("☕ You're all going to EMNLP 2026", "☕ You're both around Boston this
week", "👋 Ada says hi"), then who and why, one idea, one opener, and a small context footer. A
plain-text copy goes in `text` for notifications and older clients. Names are escaped, so a
profile name cannot ping a channel. It contains:

- **Match reason:** the names and the shared themes, or the wildcard label.
- **One concrete suggestion:** coffee between sessions or a poster walk at an event, or lunch or
  a coffee somewhere central in a city.
- **One conversation starter:** taken from a shared theme or from the partner's own project or
  paper titles, otherwise one of a small set of light openers rotated by the seeded hash.
- **Event details (event intros only):** dates, location with a map link, and the event page from
  the deadline dataset. If the dataset has no row, the message says so and does not guess.
- **Footer:** why you got it, and a plain link "Pause or turn off in AdminBot › Events". There are
  no Slack buttons, so no interactivity endpoint or new scope is needed.

Replies such as "stop" in the group DM are not parsed. AdminBot does not subscribe to DM message
events (`message.im`, `message.mpim`, `im:history`), and adding them would be new setup. The footer
link and the profile switch are the off controls.

## Location and privacy

- Intros use only the coarse city that IPinfo returned for the member's last sign-in. For the
  viewer's own display, the Events tab falls back to the city on their profile, then to their
  Slack location. Coordinates are never stored or shown.
- Places are compared as metros. A small table joins suburbs, for example Palo Alto with San
  Francisco Bay Area, and keeps same-named cities apart, for example Cambridge, MA and Cambridge,
  UK. Outside the table, places within 50 km, or with the same city name, count as near.
- The Events tab shows the viewer their own city, with the note "based on your last sign-in
  location". It never shows another member's inferred city.
- **Also nearby** and **Nearby now** list other members in the viewer's metro only when both the
  viewer and those members have city intros on, and never two locals at home. They show only the
  metro, never a precise city.
- A city or event intro tells the recipients only the metro or event they share.

## Safety

- `autoPolicy("T1")`, the same as the other server-composed group DMs. The service computes the
  recipients and the text; no caller supplies them. `POST /events/say-hi` takes only an
  `event_key` or a `member_id` from a member session.
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
  14-day city cooldown, the daytime-only sends, the default-on setting and the opt-out line in
  every message.
