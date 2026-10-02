# Member profile and paper usability fixes

Profile save notifications reserve space above the Feedback launcher and wrap/scroll long messages on narrow screens. Self-profile writes validate changed fields, preserving unrelated imported values while continuing to validate any newly submitted URL and reject privilege changes. HTTPS Overleaf read-only CV links are accepted; this does not check that a document is publicly accessible.

Stored member sessions resume after bootstrap configuration resolves. Temporary HTTP failures (including rate limits and proxy outages) retain the session for retry; explicit 401/403 responses clear it. Session expiry, revocation and server authorization remain enforced.

My Projects & Papers places add and bulk-hide controls before decision banners. Bulk hiding can search titles and select matching papers. It is a per-member, per-browser preference and never deletes a paper or changes a coauthor's view. Show hidden papers restores the list.

Publication track (Main/Findings) is independent of presentation format. The new track is stored as `artifacts.publication_track`, through the existing authorized paper update and gateway fallback. Legacy Main/Findings values in `presentation_type` remain readable and are preserved as track metadata when a later paper save replaces the format. Card, banner and spreadsheet share the same interpretation. Explicit empty track values clear the answer.
