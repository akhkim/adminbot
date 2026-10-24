# Zürich lunch invitations

The existing `adminbot-local-event-audience` job checks both recurring lunches daily:

- Monday, 12:00–13:00 Europe/Zurich: Jinesis Lunch & Meeting at ETH OAT, Andreasstrasse 5, 20th floor.
- Thursday, 12:30–13:30 Europe/Zurich: PEAKS-EuroSafeAI lunch, Zeughausstrasse 31.

The calendar and series IDs are pinned in `config/adminbot-cron.json`. They were read from the Jinesis calendar on October 24, 2026. A replacement series needs its ID updated there. The job retains its existing 07:40 slot in the gateway timezone and uses one existing scheduler entry, not a second controller.

The existing audience rules use recorded city or Slack timezone. Alumni and acquaintances may attend local lunches. University affiliation alone does not establish current location. A pending or approved proposal with the same action and payload is reused on later checks. Guests already invited are not proposed again. Unknown guests and stale location evidence retain the existing protections.

Calendar visibility is separate from an invitation. This pass creates approval cards; it does not approve or execute them. Additions and removals still pass through AdminBot's existing admin approval and execution flow. Do not enable additional location collection or change credentials to activate this job.

After the reviewed release is deployed, sync the existing manifest job with the supported cron sync wrapper. Confirm its saved command names both series, run one pass through the existing owner, review the resulting cards and verify Calendar attendee readback after approved execution. Until that happens, the daily workflow is prepared rather than live-verified.
