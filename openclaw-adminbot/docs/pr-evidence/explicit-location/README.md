# Explicit location check-in

These shots render the real components with the production stylesheet (`ui/src/styles.css`),
through the UI's own Vite config:

- `renderLocationCheckin` (the check-in strip)
- `renderMemberMap` (the admin map)
- `renderLocationLogRows` (the admin location log)

The harness page was temporary and is not committed. The row of tab buttons above the strip stands
in for the app's navigation. It shows that the strip sits in the page flow below the navigation,
not over it.

All data is synthetic ("Avery Synth", "Blake Sample", ...) and produced by the service's own
functions, never written by hand:

- `buildMemberMap` and `toPrivilegedMemberMap` produced the admin map from an invented roster of
  15 members.
- `locationCheckin` produced each banner state.
- `checkinAnswerEntry` and `checkinNonAnswerEntry` produced the check-in rows in the log.

Ages are relative to the capture time.

Headless Chromium (Playwright) captured them at deviceScaleFactor 2: desktop at 1280x900, and
mobile at 390x844 with touch.

## Check-in strip

| Shot                                    | State                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `confirm-{desktop,mobile}-{light,dark}` | "Are you in Toronto?" The guess is a sign-in city from an hour ago. It is asked because the member's Slack zone (Europe/Berlin) is 6 h off, which the question's tooltip says. |
| `confirm-slack-guess-desktop-light`     | No sign-in. The guess is Vancouver, the city the Slack zone America/Vancouver is named for.                                                                                    |
| `pick-{desktop,mobile}-light`           | After "No, change": the city field (gazetteer suggestions, free text accepted), Save and "Use this device's location".                                                         |
| `pick-no-guess-mobile-dark`             | Nothing places the member, so the strip opens on the picker.                                                                                                                   |
| `signals-agree-desktop-light`           | A fresh Toronto sign-in and America/Toronto in Slack. The service answers `signals_agree`, and nothing is shown.                                                               |

Measured in the browser, in every strip shot:

- Every control (Yes, No change, Prefer not to say, close, Save, device, the city field) is at least
  40px tall. The close button is 40x40.
- The strip is `position: static` and starts below the navigation.
- At 390px, `scrollWidth` equals the viewport width, so nothing scrolls sideways.

## Admin map

- `admin-map-{desktop,mobile}-light`: Toronto is opened.
  - Avery Synth: "stated 3 days ago".
  - Blake Sample: "stated today".
  - Oakley Test: "stated 41 days ago", a check-in still inside 60 days.
  - Gray Placeholder: "from profile".
  - Finley Test: "from profile · Slack time zone Europe/Berlin is 6 h off".

  The foot reads "Sign-in geolocation is on (mmdb)." Elsewhere on the map:
  - Indy Example chose "My stated city only" and signed in from Seattle an hour ago, so lands in
    Vancouver from the stated city.
  - Morgan Mock declined the check-in and is on neither the map nor the counts.

- `admin-map-geoip-off-desktop-dark`: the same map with the provider off. The status line says so,
  and the DB-IP credit is gone.

## Location log

`location-log-desktop-light` and `location-log-mobile-dark` show the admin view of one member's log,
newest first. It covers:

- a Toronto check-in;
- Slack time-zone changes;
- a sign-in city;
- "Asked; chose ask me later";
- a Berlin check-in "from this device";
- a Slack profile location.
