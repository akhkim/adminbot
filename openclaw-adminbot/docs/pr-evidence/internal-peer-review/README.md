# Internal peer review evidence

Actual Lit component and production styles with synthetic data and mocked API, captured through supported computer use on 3 November 2026. No provider request, invitation, assignment or document access was exercised.

Verified expand → load → edit purpose and HTTPS link → nominate Reader Example → save, then browser reload and load retained all three fields. This fixture uses sessionStorage; real SQLite persistence, ownership, revisions, invalid nominees and stale sessions are covered separately by API/store/UI tests. Keyboard focus reached the native controls; nomination disables once selected. Desktop and requested390×844 viewport light/dark were inspected. Captures are native JPEG bytes; mobile browser capture is compositor-scaled and labelled accordingly.

- [Desktop dark, saved](desktop-dark.jpg)
- [Desktop light, reloaded](desktop-light.jpg)
- [Mobile dark](mobile-dark.jpg)
- [Mobile light](mobile-light.jpg)

All saved images were reopened and inspected for readable labels, overflow, clipping and privacy. Rendered PR images are checked after publishing and before readiness. Fixture does not establish production deployment.

To reproduce, copy fixture.html to ui/.artifacts/internal-peer-review-preview.html and serve with the existing Vite UI. Synthetic state uses adminbot-synthetic-peer-review-fixture in sessionStorage.

Desktop-detail.jpg is an unmodified native-resolution crop of desktop-dark.jpg, added after the full context image proved too small at normal PR scale.
