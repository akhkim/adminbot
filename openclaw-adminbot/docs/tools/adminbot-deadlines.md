# AdminBot Deadline Tracker (operator guide)

Collects the lab's conference/workshop deadlines, retains expired history, and drives reminders.
Three outputs share one dataset (`extensions/adminbot/content/deadlines/venues.json`):

- **Output 0** — a live countdown **board** (`deadlines-board.html`).
- **Output 1** — a periodic digest posted to **#jinesis-active** (see below).
- **Output 2** — per-author **Slack DM reminders** on a 30/15/7/3/2/1-day
  cadence, stopping when the paper is submitted, else escalating to Zhijing.

## 1. Refresh the data

```bash
python3 scripts/adminbot-deadline-collect.py          # -> venues.json
python3 scripts/adminbot-deadline-match.py \           # -> matches.json
    --ongoing-csv /path/Paper_submissions.csv \
    --ready-csv   /path/Formatted_Papers.csv
```

On Aurora, export the two sheets first with the authenticated `gog`/`gws`
account (the same one used elsewhere), then pass them as `--ongoing-csv` /
`--ready-csv`. Without local CSVs the matcher falls back to the Google Sheets
CSV endpoint using `ADMINBOT_ONGOING_SHEET_ID` / `ADMINBOT_READY_SHEET_ID`.

The collector merges by stable deadline id. Top-level fields are the current
projection; append-only `revisions` retain earlier accepted dates, and explicit
`venue_aliases` bridge existing deadline-board and venue-catalog identifiers.
Both deadline pages expose Upcoming and Past views. Reminder, matching, calendar,
summary, Time Availability, and My Work consumers continue to select only the
current upcoming projection relevant to their workflow.

`matches.json` marks **ongoing** papers `confirmed:true` (deterministic `Venue`
match) and **ready→workshop** suggestions `confirmed:false`. A human sets
`confirmed:true` on the workshop pairs they approve before those get nudged.

## 2. Reminders (Output 2)

```bash
python3 scripts/adminbot-deadline-reminders.py            # dry-run (prints)
python3 scripts/adminbot-deadline-reminders.py --send     # actually DM
```

Author→Slack ids resolve from the AdminBot roster
(`GET $ADMINBOT_SERVICE_BASE_URL/lab/members` → `slack_user_id`).

**Delivery mode.** Recommended: schedule the runner ~daily as an OpenClaw cron
job (same pattern as `adminbot-paper-nudge-reminders.mjs`); the templated author
DMs go out directly and the escalation digest goes to Zhijing. If you prefer a
human gate on every send, route the runner's output through
`adminbot_propose_slack_message` instead of `--send`.

**OpenReview stop-condition.** Set `OPENREVIEW_USERNAME` / `OPENREVIEW_PASSWORD`
(Zhijing enters these in the service secret store herself). When present, the
runner logs in, reads her submissions, and stops reminders for submitted papers.
Absent → cadence runs fully; authors can reply **"done"** to stop; unsubmitted
papers escalate to Zhijing at the deadline. Also set
`ADMINBOT_HEAD_PROFESSOR_SLACK` to Zhijing's Slack id for escalations.

## 3. Board (Output 0) surfaces

The Deadline Tracker has two delivery contexts and one generated dataset and interaction model:

- the AdminBot service's zero-setup page at `GET /deadlines`; and
- the public and signed-in Control UI route at `/adminbot/deadlines`.

Both show the next deadline, aggregate counts, venue filters, search, and card, grouped, and table
views. The Control UI renders the board natively in its normal document flow; it does not embed the served
page, so desktop and mobile retain one vertical scrolling surface.

The served page is implemented by:

- `extensions/adminbot/src/workflows/deadlines/board.ts` — `renderDeadlinesWebUi(items)`
  returns the self-contained board (generated from `content/deadlines/deadlines-board.html`).
- `extensions/adminbot/src/workflows/deadlines/generated/dataset.ts` — `DEADLINE_VENUES`
  (generated from `content/deadlines/venues.json`).
- `extensions/adminbot/src/api/server.ts` — `GET /deadlines` (HTML board) and
  `GET /deadlines/venues.json` (JSON), next to `GET /adminbot`.

It is reachable the same way as the `/adminbot` console (loopback or SSH forwarding on the service
host). The first-class Lit view lives in `ui/src/ui/adminbot/views/deadlines.ts`; anonymous visitors
receive the same view inside the public Control UI shell. `adminbot-deadline-collect.py` regenerates
the server and UI dataset projections together so their labels and classifications stay aligned.

Run `pnpm ui:build` and `pnpm ui:i18n:check` after changing the Control UI surface.

## 4. Output 1 (channel digest)

`scripts/adminbot-deadline-channel-digest.py` renders a short upcoming-deadline
summary from `venues.json`. It is dry-run by default; `--send` posts to
`ADMINBOT_ACTIVE_CHANNEL` (default `#jinesis-active`). No weekly task is
activated by this repository change; an operator must add that schedule.

## Notes / limitations

- Topic-match (ready→workshop) is a keyword heuristic with false positives; it
  is **confirmation-gated** on purpose. A future version can swap in embeddings.
- The scripts are validated in **dry-run**; live sending needs the AdminBot
  service + Slack/`gog`/OpenReview credentials on the host.
