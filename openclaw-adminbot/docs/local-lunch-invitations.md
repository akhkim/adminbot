# Automatic local lunch invitations

Ayush authorized this standing policy on October 24, 2026: automatically add location-matched people to all upcoming lab lunches, without a manual invitation queue. This supersedes the initial two-series proposal-only design.

The existing `adminbot-local-event-audience` job runs daily at its existing 07:40 gateway-time slot. It calls `/calendar/local-lunch-invites/run` without supplying any recipients, event IDs or locations. The server reads the configured lab calendar for the next seven days and discovers timed events with “lunch” in the title. It resolves a single city from the event's location or title. This includes Monday's ETH OAT lunch and Thursday's PEAKS lunch in Zürich, and other cities when a lunch exists there. Unknown or conflicting cities are reported, not guessed from university affiliations. An event may need a clearer location before it can qualify.

Recipients come from AdminBot's existing member map. Alumni and acquaintances are included. Hidden map entries and timezone-only/country-only placements are not used for automatic invitations. No additional location collection is enabled. Existing invite addresses are respected.

Each missing invitation still goes through the typed proposal, hash-bound approval, connector execution and audit trail. The approval identifies `system:local-lunch-policy`, never a person. The standing rule authorizes only additions derived server-side from the real calendar and roster. It never removes anyone or changes calendar ACLs. It targets upcoming occurrences rather than putting a short-term visitor on an entire recurring series indefinitely.

One idempotency key per calendar/event/address prevents duplicate invitations across daily, overlapping or stale reads. An uncertain failure is reported and is not silently replayed. Failed reads or a possibly truncated result do not start a pass. Connector failures remain failures, not successful invitations.

Deployment uses the existing Aurora pipeline and existing scheduler entry. After deployment, verify the saved job and run one pass through the authenticated operator UI. Inspect its execution receipts and Calendar attendees. A build or deployment alone does not prove delivery.
