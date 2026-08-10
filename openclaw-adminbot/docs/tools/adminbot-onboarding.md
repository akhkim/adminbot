# AdminBot Onboarding Nudges (operator guide)

Chases outstanding onboarding steps — the LinkedIn org join, by default — over
Slack DM, and records completion from the member's own ✅ reaction. LinkedIn
exposes no API that can verify membership, so the member's reaction (or their
toggle on the AdminBot welcome screen) is the record.

## How the loop works

1. An admin kicks off a round from the Control UI roster ("Select: LinkedIn not
   joined" → nudge), or the cron pass below sends the first DM itself. The
   message asks the member to react ✅ once they have joined.
2. `scripts/adminbot_onboarding_confirm.py` runs on cron. Per pending member it
   reads the DM with the bot and either
   - **confirms**: the newest nudge carries a ✅/☑️/✔️/👍 from that member →
     marks the step complete via `POST /lab/members/:id/onboarding/:step`
     (service principal, audit-logged) and replies "Got it — recorded as done",
   - **re-nudges**: the newest nudge is older than the cadence (default 3 days,
     `--cadence-days`) → sends the reminder again, or
   - **waits** until the next run.
3. The Control UI needs no sync step: the roster, welcome screen, and laggard
   filter read the same service state the poller writes.

Slack is the send-state store — "when did we last nudge" is the timestamp of
the bot's newest nudge in the DM — so there is no second database to drift.

## Schedule it

Create the schedule as an OpenClaw cron job so the pass appears in the Control
UI's Cron tab, then sync it to Aurora (same flow as the OpenReview pass,
`docs/tools/adminbot-openreview.md`):

```bash
pnpm openclaw cron add \
  --name adminbot-onboarding-confirm \
  --description "Record ✅ reactions on onboarding nudges; re-nudge stale ones" \
  --cron "10 */2 * * *" \
  --command-argv '["bash","<repo>/scripts/adminbot-onboarding-cron.sh","confirm"]' \
  --timeout-seconds 300

scripts/aurora-adminbot-host.sh --user <cs-user> sync-cron-jobs
```

Every two hours is plenty: confirmations only gate the next re-nudge round, and
a reaction is never lost by waiting. `confirm-preview` is the same pass with
sends and writes disabled — use it to sanity-check who would be re-nudged.

The wrapper loads secrets through `scripts/lib/adminbot-cron-env.sh` (mode-600
env file, never the job spec). It needs `ADMINBOT_SERVICE_TOKEN`,
`SLACK_BOT_TOKEN` (scopes: `im:history`, `chat:write`), and — when the service
is not on `http://127.0.0.1:8765` — `ADMINBOT_BASE_URL`.
