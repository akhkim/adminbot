# Member request editing evidence

These are browser captures of the actual Lit member-request components with production CSS and synthetic data. The local component fixture mocks the save callback; service HTTP regression tests separately verify persistence, admin authorization, stale edits, duplicate emails, and approval using the edited profile. No live member data or production invitations were used.

Before: base 991232ca, pending Alex Example with `full, coauthor-major` and no Edit control. After: the same fixture and framing after selecting only `coauthor-major` and saving; it remains in the review queue. The updated editor captures show the original request before correction, with the notes field spanning the form. Mobile is 390×844; desktop light is 1280×900. `editor.jpg` and `light-editor.jpg` are native browser clips of the popover; `light-context.jpg` retains its context.

Browser checks: open Edit, change type, Save (popover closes and card updates), reopen, Cancel (no save), and inspect mobile/dark and desktop/light readability. The preview has no production authentication or external connectors. Existing onboarding, calendars, and roster writes run only on a separate approval.
