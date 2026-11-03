# UI evidence handoff — not yet verified

This is an actual Lit component/production-style fixture with synthetic local state and mocked API. It does not contact any provider or persist a real nomination.

Copy fixture.html to ui/.artifacts/internal-peer-review-preview.html, start Vite locally, and open that path using supported computer-use tools. Exercise Load → edit incomplete purpose/link → nominate Reader Example → Save private draft; verify no-send/no-access wording and reload persistence within the fixture (synthetic draft only in sessionStorage under adminbot-synthetic-peer-review-fixture; no production persistence proof). Verify error/stale/session behavior using focused tests plus real API fixture if needed. Check desktop,390x844 mobile, light/dark, keyboard and long strings. Inspect saved files/actual encoding, then rendered PR at pinned head. No screenshot or visual verification is claimed in this PR yet.

UI evidence is a release/review completion gate. The current developer environment lacks supported browser/CUA tools; EA may collect the three passes. Do not send real requests or grant manuscript access as a test.
