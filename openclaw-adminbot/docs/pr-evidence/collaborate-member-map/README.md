# Collaborate member map

These shots show the real `renderLabSharing` view (the Collaborate tab) with the production
stylesheet (`ui/src/styles.css`). The UI's own Vite config rendered it, and the data was
synthetic. The data is not hand-drawn. The service's own `buildMemberMap` produced it from an
invented 224-member roster ("Avery Synth", "Blake Sample", ...). The result then went through
`parseMemberMap`, the parser the live loader uses, in the admin (`full`) shape.

## Synthetic coverage

The roster mirrors production's field coverage:

| Field           | Members |
| --------------- | ------- |
| `location`      | 128     |
| `timezone`      | 73      |
| `current_city`  | 19      |
| `slack_user_id` | 128 (each with a Slack `tz`) |
| any sign-in data | 0      |

| Scenario | Placed | Cities | By precision and source | Not placed |
| -------- | ------ | ------ | ----------------------- | ---------- |
| Today: no sign-in data, no provider (`today-no-ip-desktop-light.png`) | 151 | 11 | 119 city/roster, 30 timezone/Slack, 2 country/roster | 7 unresolved text ("Remote", an unknown town), 66 with no location at all |
| After the local database is configured and 30 of the 66 sign in (every other shot) | 181 | 13 | adds 25 city/login and 5 country/login | 7 unresolved text, 36 with no location at all |

The map works with no IP data at all. Sign-ins only add the members who had no other location.
Two of the 30 sign-ins came from a city the gazetteer does not know (Villeurbanne, France), and
three reported only a country (India). All five are pinned on their country's centroid as hollow
dots. None is guessed into a nearby city.

## Shots

Headless Chromium (Playwright) captured these at deviceScaleFactor 2.

- **Map card:** `desktop-light.png` and `desktop-dark.png` (1280x900 CSS viewport, plot 862px wide); `mobile-light.png` and `mobile-dark.png` (390x844, plot 300px wide). At 390px `scrollWidth` equals the viewport, so nothing scrolls sideways. Each shows the Toronto, San Francisco and London clusters, the hollow country-only dots, and the "IP geolocation by DB-IP" credit linking to https://db-ip.com.
- **No IP:** `today-no-ip-desktop-light.png` is the same roster with no sign-in data. It has no credit because no provider is configured.
- **Labels in Europe:** `labels-europe-card-{light,dark}.png` (card plot) and `labels-europe-dialog-{light,dark}.png` (expanded dialog) show Berlin, London, Zürich and Paris only.
- **Full map in the dialog:** `dialog-desktop-light.png`.
- **Precision labels:** `precision-list-desktop-{light,dark}.png` shows the Toronto row expanded. Each name says how it was placed: "city · from the roster", "city from time zone · from Slack", or "city · from last sign-in (approx.)".

## Label check in the browser

In every shot, the capture script measured each visible city label with the browser's own
`getBBox()`. These are the real rendered boxes, not the layout's estimate. It checked them against
each other and against every dot:

- **Overlaps:** 0 label-to-label and 0 label-to-dot, in all nine plots (four card sizes and themes, four Europe plots, one dialog).
- **Europe:** London, Berlin and Zürich are labelled. Paris has no clear spot, so its label appears when its dot is hovered, and Paris is listed beside the plot.
- **Full map:** the card labels the six busiest places and the dialog labels nine. The rest appear on hover.
- **Width estimate:** for "Toronto" the estimate is 21.7 units and the rendered width is 20.4, so the estimate errs wide.

## Isolation

No stored session existed, so the Collaborate controller made no AdminBot request. No AdminBot
service, Slack, IPinfo, DB-IP or Google API was contacted. The only off-host request was the
Google Fonts stylesheet that `styles.css` imports. The fixture page and its JSON lived outside
version control and were deleted after capture.
