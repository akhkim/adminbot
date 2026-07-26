# AdminBot Deadline Tracker (operator guide)

Collects the lab's upcoming conference/workshop deadlines and drives reminders.
Three outputs share one dataset (`extensions/adminbot/deadlines/venues.json`):

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

## 3. Board (Output 0) as a Control-UI surface

**Served page — IMPLEMENTED (mirrors the existing `/adminbot` console).**
The AdminBot service now serves the board:

- `extensions/adminbot/src/deadlines-web-ui.ts` — `renderDeadlinesWebUi(items)`
  returns the self-contained board (generated from `deadlines/deadlines-board.html`).
- `extensions/adminbot/src/deadlines-dataset.ts` — `DEADLINE_VENUES`
  (generated from `deadlines/venues.json`).
- `extensions/adminbot/src/mock-service.ts` — `GET /deadlines` (HTML board) and
  `GET /deadlines/venues.json` (JSON), next to `GET /adminbot`.

Reachable the same way as the `/adminbot` console (loopback / SSH-forward on the
service host). Verified by inspection only — run `pnpm build` on the host to
certify TypeScript compilation.

**First-class Lit tab in `jinesis-admin.vercel.app` — TODO (needs `pnpm ui:build`
+ `pnpm ui:i18n:sync`; not applied here because those gates cannot run in the
authoring environment).** Exact edits, mirroring the `adminbot` tab:

1. `ui/src/ui/navigation.ts` — add `"adminbotDeadlines"` to the `adminbot` group
   in `TAB_GROUPS`, to the `Tab` union, and to `TAB_PATHS`
   (`adminbotDeadlines: "/adminbot/deadlines"`); add an `iconForTab` case
   (e.g. `case "adminbotDeadlines": return "loader";`).
2. `ui/src/i18n/locales/en.ts` — add `tabs.adminbotDeadlines` and
   `subtitles.adminbotDeadlines`; then `pnpm ui:i18n:sync`.
3. `ui/src/ui/views/deadlines.ts` — a Lit view that renders the board. Simplest:
   fetch `/deadlines/venues.json` from the service and render the same cards, or
   host the board page and embed it. (Do not `innerHTML` the served page —
   its `<script>` will not execute.)
4. `ui/src/ui/controllers/deadlines.ts` — a `loadDeadlines(host)` loader.
5. `ui/src/ui/app-settings.ts` — add an `adminbotDeadlines` case to the
   `refreshActiveTab` switch.
6. `ui/src/ui/app-render.ts` — register the lazy view for `adminbotDeadlines`.

Then `pnpm ui:build` to compile and `pnpm ui:i18n:check`.

## 4. Output 1 (channel digest) — not yet wired

Post a short "upcoming this week" summary of `venues.json` to `#jinesis-active`
on a weekly cron. Reuses the same dataset + `adminbot_propose_slack_message`.

## Notes / limitations

- Topic-match (ready→workshop) is a keyword heuristic with false positives; it
  is **confirmation-gated** on purpose. A future version can swap in embeddings.
- The scripts are validated in **dry-run**; live sending needs the AdminBot
  service + Slack/`gog`/OpenReview credentials on the host.
