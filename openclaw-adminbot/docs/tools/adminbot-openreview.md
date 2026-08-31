# AdminBot Reviewing Cycles (operator guide)

Chases missing reviews on OpenReview for every venue Zhijing serves, on a fixed
escalation ladder, so the manual "who hasn't reviewed yet" pass each cycle
disappears.

Venues are **discovered automatically** each run from OpenReview group
membership — there is no per-conference setup. A venue appears as one cycle per
role held there (a venue where she is both SAC and reviewer is chased twice,
independently).

## The ladder

Measured against the venue's `Official_Review` invitation due date.

| When                                 | As Area Chair                                                  | As Senior AC                             |
| ------------------------------------ | -------------------------------------------------------------- | ---------------------------------------- |
| Halfway through the reviewing period | Nudge assigned reviewers directly, asking them to submit early | Remind ACs to nudge their reviewers      |
| 7 / 4 / 2 / 1 / 0.5 days before      | Remind only reviewers who still owe a review                   | Remind ACs still holding missing reviews |
| 1 / 2 / 4 / 7 days **after**         | Serious overdue warning                                        | Active nudge to the AC                   |

Each milestone fires **at most once per cycle**, to the recipients who still owe
something at that moment. A paper whose reviews are all in is skipped (and
recorded as skipped, so it does not resurface if someone falls behind later).

Two things stay manual by design:

- **Removing a reviewer who says they cannot do it, and adding an emergency
  replacement.** The console lists ranked Jinesis members per unreviewed
  submission (research-overlap match, with conflicts and unavailability shown);
  assigning is an explicit click, never automatic.

  Some people are never candidates. Set **`reviewer_exempt`** on a member to keep
  them out of every suggestion whatever their topic match — a standing commitment
  about someone's time, so it is admin-only and cannot be set from a member's own
  profile. The profile the automation runs as is excluded automatically: whoever
  chairs a submission cannot also review it, so that needs no configuration. Both
  rules are enforced again when an assignment is actually posted, so the exemption
  holds even if someone calls the route directly. Removing an exempt reviewer stays
  allowed, which is how the rule gets applied to an assignment made earlier.

- **Zhijing's personal-email escalation** to a delinquent AC. The console shows
  who is still lacking; the outreach is hers to send.

## What sends by itself, and what waits

- **Halfway and the five pre-deadline reminders auto-send.** They are ordinary
  reminders to committee groups, the run route is admin-only, and each fires once.
- **All four overdue warnings become pending actions.** They carry real social
  weight and go out under Zhijing's name, so a human approves them in
  **Actions → Pending** before they leave.

Two further brakes, independent of the above:

- `ADMINBOT_OPENREVIEW_SEND` must be `1` in the env file or nothing is delivered
  at all — reminders are still composed, recorded, and visible in the console.
  A reminder withheld this way is recorded as **simulated**, not executed: the
  proposal stays approved, the audit event is `execution.simulated` and names
  the switch, and the cycle reports `dry_run` rather than `sent`. Executing it
  again once the switch is on really delivers. (Until this was fixed, the
  connector reported a withheld message as a success, so the console and the
  audit trail both showed deliveries nobody received.)
- A run that would exceed **50 messages** aborts _before_ sending anything.

## Setup

1. Put credentials in `~/.config/jinesis-adminbot/adminbot.env` (mode 600):

   ```
   OPENREVIEW_USERNAME=...
   OPENREVIEW_PASSWORD=...
   ADMINBOT_OPENREVIEW_SEND=0
   ```

2. Install/refresh the units. This adds `openreview-py` to the shared PYTHONPATH root
   and removes the systemd timer that used to own the schedule:

   ```bash
   deploy/aurora/install-user-services.sh --root <release> --start
   ```

3. Create the schedule as an **OpenClaw cron job**, so the pass appears in the Control
   UI's Cron tab with its run history, next-run time, and last error. Create it locally,
   then sync it to Aurora — the sync rewrites the repo path to the remote release path:

   ```bash
   pnpm openclaw cron add \
     --name adminbot-openreview \
     --description "AdminBot reviewing-cycle pass" \
     --cron "15 0,6,12,18 * * *" \
     --command-argv '["bash","<repo>/scripts/adminbot-openreview-cron.sh"]' \
     --timeout-seconds 900

   scripts/aurora-adminbot-host.sh --user <cs-user> sync-cron-jobs
   ```

   Every six hours, not daily: the tightest rung of the ladder is half a day before the
   deadline, and a daily tick would step over it.

   The job runs `scripts/adminbot-openreview-cron.sh`, which reads the service token from
   the mode-600 env file rather than carrying it in the job spec — cron job specs are
   stored in the database and shown in the browser. Its stdout becomes the run summary,
   and it exits non-zero when the pass reports errors, so a misconfigured run shows red in
   the Cron tab instead of green.

   Because cron runs inside the Gateway, the Gateway has to be up for the pass to fire.

4. Map lab members to OpenReview by setting `openreview_id` (their `~Tilde_Id1`)
   on each roster entry. Without it a member can be suggested as an emergency
   reviewer but not assigned.

## Running it by hand

```bash
# Dry run: reports exactly what would be sent, sends nothing.
curl -s -X POST -H "Authorization: Bearer $ADMINBOT_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' --data '{"send":false}' \
  http://127.0.0.1:8765/openreview/cycle/run | jq

# Current state: cycles, deadlines, outstanding counts, milestones already fired.
curl -s -H "Authorization: Bearer $ADMINBOT_SERVICE_TOKEN" \
  http://127.0.0.1:8765/openreview/status | jq
```

Or use the **Reviewing** tab in the console (admin only), which has
a "Run cycle now" button with a send toggle that defaults to off. The Control UI's
**Cron** tab shows whether the schedule itself is firing; the Reviewing tab shows what
the passes actually did.

The bridge script is usable on its own for debugging:

```bash
export PYTHONPATH=~/.local/share/jinesis-adminbot/python-libs
python3 scripts/adminbot-openreview.py discover | jq
python3 scripts/adminbot-openreview.py status --venue <venue-id> --role ac | jq
```

## Reading the output

Each cycle reports `status` per milestone:

- `sent` — delivered through OpenReview.
- `proposed` — waiting for approval in Pending actions (all overdue warnings).
- `dry_run` — composed and validated, not delivered.
- `skipped` — nothing outstanding for that milestone.
- `blocked` — could not send; `detail` says why. The usual cause is that the
  venue does not grant this role a per-submission message invitation, or the
  anonymous signature for that submission could not be resolved.

`missed` lists milestones whose 12-hour catch-up window closed unfired (the box
was down, or the venue was discovered late). They are **not** sent late — a
venue found after its deadline sends one overdue warning, not the whole ladder.

## Troubleshooting

- **`no_credentials`** — `OPENREVIEW_USERNAME` / `OPENREVIEW_PASSWORD` are not
  in the service environment. Every subcommand no-ops rather than failing.
- **Nothing discovered** — the venue must expose a `review_name` and a due date
  on its review invitation; venues whose deadline is more than 60 days past are
  dropped. The run result carries a `skipped` list naming each dropped venue and
  why, so `venues: 0` is never ambiguous. The due date is read from the
  venue-level review invitation when this profile may read it, and otherwise
  from one of the per-submission invitations it spawns — most venues expose the
  venue-level one to organizers only, so a plain reviewer/AC/SAC gets a 403 on
  exactly the venues they serve on and only the fallback finds the cycle.
- **The job never runs** — cron lives inside the Gateway, so check the Gateway is
  up first. The Control UI's Cron tab shows the next run time and the last run's
  status; a red run's summary carries the pass output verbatim.
- **`message_denied`** — venue-specific permission. Some venues do not let an AC
  message reviewers through the API. Nothing is rerouted to personal Gmail; the
  milestone is recorded blocked and surfaced in the console for a manual send.
- **A reminder went out twice** — it should be impossible: the milestone table is
  keyed `(venue_id, role, milestone_key)`. Check
  `sqlite3 ~/.openclaw/state/adminbot.sqlite 'select * from adminbot_openreview_milestones'`.
