# Collaborate member map

These shots show the real `renderLabSharing` view (the Collaborate tab) and the Dashboard card
(`renderMemberMap`), styled by the production stylesheet (`ui/src/styles.css`) and rendered by the
UI's own Vite config. The data is synthetic and not hand-drawn. The service's own `buildMemberMap`
and `toPublicMemberMapSummary` produced it from an invented 62-member roster ("Avery Synth",
"Blake Sample", ...). Each result then went through `parseMemberMap`, the parser the live loader
uses. The map's `loadedAt` was set three minutes back, so the card reads "Updated 3 min ago".

`before/` holds the shots from the previous commit on this branch, before the IP-first placement and
the redesign.

## Synthetic roster

Sign-in times were set relative to the capture time.

| Who                                                                | Count | Where they land                                                        |
| ------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------- |
| Stated city only, no sign-in                                       | 29    | Their stated city, "· from profile"                                    |
| Fresh sign-in (2 h to 9 days ago)                                  | 13    | The sign-in city, "· from sign-in today / yesterday / N days ago"      |
| Travellers: stated Toronto, signed in from San Francisco or London | 3     | The sign-in city                                                       |
| Stale sign-in (20 days ago, New York), stated Toronto              | 2     | Toronto, "· from profile"                                              |
| "My stated city only", signed in from Seattle an hour ago          | 1     | Vancouver, its stated city                                             |
| "Hidden"                                                           | 2     | Not on the map and not counted                                         |
| Slack time zone only, profile time zone only                       | 3 + 2 | The zone's city, "· from Slack time zone" / "· from profile time zone" |
| Country only (roster "Germany", sign-in country India)             | 2 + 2 | The country, drawn hollow                                              |
| Nothing at all                                                     | 3     | Counted under "could not be placed"                                    |

The admin map placed 57 members in 12 places: 16 by sign-in city, 32 by stated city, 5 by time
zone and 4 by country.

## Shots

Headless Chromium (Playwright) captured these at deviceScaleFactor 2.

- **Collaborate, "Where the lab is":** `desktop-{light,dark}.png` (1280x900) and
  `mobile-{light,dark}.png` (390x844). At 390px `scrollWidth` equals the viewport, so nothing
  scrolls sideways. The list wraps under the plot.
- **Highlight:** `desktop-{light,dark}-hover.png` hovers the San Francisco row. Its pin lifts, the
  other pins dim, and a popover names the people with where each place came from ("San Francisco ·
  from sign-in today"). `mobile-{light,dark}-tap.png` taps the same row at 390px. The row stays
  picked and the pin lifts. The popover is hidden on phones so it never covers the list.
- **Sources:** `sources-desktop-light.png` shows the Toronto and San Francisco rows expanded,
  mixing "Toronto · from profile" with "Toronto · from sign-in today".
- **Who sees what:** `member-desktop-light.png` is the counts-only map a signed-in member gets. It
  uses the same places as the admin map but shows no names. `anonymous-desktop-light.png` is what a
  signed-out visitor gets. Sign-in cities are left out, so the travellers fall back to Toronto and
  sign-in-only members appear at their country ("United States", "Germany").
- **Dashboard:** `dashboard-card-{light,dark}.png` is the same map in the Dashboard's card style.
- **Loading:** `loading-mobile-light.png` is the Collaborate state before the first map arrives.

## Isolation

No AdminBot service, Slack, IPinfo, DB-IP or Google API was contacted. The only off-host request
was the Google Fonts stylesheet that `styles.css` imports, and no page errors were logged. The
fixture page and its JSON lived outside version control and were deleted after capture.
