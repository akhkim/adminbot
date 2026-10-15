# Events tab evidence

Synthetic data only. The real `renderEvents` Lit view and the production stylesheet were rendered in a
throwaway local Vite harness (not committed) and captured with headless Chromium at 2x. No API, IPinfo
or Slack call was made.

Fixture: the viewer's last sign-in places them in San Francisco. Made-up events: SynthConf 2026 in
San Francisco (happening now), Bay Workshop on Test Data in Palo Alto (in 5 days), FarConf 2026 in
Budapest (the viewer is Going) and one past event. Every member name is invented. City intros are on, so
"Also nearby" lists one synthetic member in the San Francisco Bay Area.

| File                   | Viewport | Theme |
| ---------------------- | -------- | ----- |
| `desktop-dark.jpg`     | 1280 px  | dark  |
| `desktop-light.jpg`    | 1280 px  | light |
| `mobile-390-dark.jpg`  | 390 px   | dark  |
| `mobile-390-light.jpg` | 390 px   | light |

What to check in each: the viewer's own city, with "based on your last sign-in location"; the in-town
prompt "Looks like you're in San Francisco during SynthConf 2026. Are you attending?"; "Near you" on
both Bay Area events but not on Budapest; dates and countdown; Map and Event page links; avatars with a
"+2" overflow; the Going / Not going toggle; the open Past section; and the intro settings.
At 390 px the page has no horizontal overflow (scrollWidth equals the viewport width in all four captures),
and no console errors were logged.
