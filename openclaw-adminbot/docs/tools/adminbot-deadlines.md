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
python3 scripts/adminbot-deadline-collect.py --force-refresh
python3 scripts/adminbot-deadline-match.py \           # -> matches.json
    --ongoing-csv /path/Paper_submissions.csv \
    --ready-csv   /path/Formatted_Papers.csv
```

The ordinary collector is the routine path. It reuses fresh source observations and re-reads a
workshop daily only within three days of its deadline; other workshop pages wait a fortnight. Use
`--force-refresh` for a deliberate full-source audit. Official pages are fetched concurrently, and
public GitHub Pages histories needed to recover earlier extension dates are checked concurrently in
a second bounded pool.

Generated JSON and TypeScript projections must not be edited by hand. If a broken collector run has
contaminated append-only state, regenerate against a known-clean committed dataset:

```bash
python3 scripts/adminbot-deadline-collect.py \
  --force-refresh \
  --baseline-git-ref=HEAD
```

The collector reconciles a route-specific official CFP deadline, an explicit OpenReview final-paper
summary, and the live OpenReview submission cutoff. It records which source won and retains a
disagreement rather than hiding it. Source-explicit old dates and deterministically discoverable
GitHub Pages revisions form an old-to-new extension chain. If a page says “extended” but publishes
no recoverable former date, the record says that the prior value is unavailable; the collector does
not invent one.

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

Signed-in members can add any upcoming board entry, including a workshop, from the Time
Availability deadline picker. Copied milestones carry the dated `deadline_id`, so the service
prevents duplicate additions and refreshes their date, label, time zone, and link when the accepted
deadline revision changes. Personal milestones remain valid without that ID. An existing copied
row is linked once when its label and current or retained historical date uniquely identify a board
entry; ambiguous rows remain personal.

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

**Delivery mode.** Scheduled: `adminbot-deadline-reminders` runs the `reminders`
task weekdays at 07:30, after the 06:20 match pass it reads
(`config/adminbot-cron.json`). The templated author DMs go out directly and the
escalation digest goes to Zhijing. There is no approval step in front of them
because there is nothing composed to approve — recipients come off the matched
author list and the wording off `dm-templates.json` — and the judgment call that
does need a human is already upstream: only `confirmed` matches are ever nudged,
and a fuzzy ready→workshop suggestion stays unconfirmed until somebody says so.

If you would rather gate every send anyway, route the runner's output through
`adminbot_propose_slack_message` instead of `--send`; keep the same schedule and
the proposals land on the Actions tab.

**OpenReview stop-condition.** Set `OPENREVIEW_USERNAME` / `OPENREVIEW_PASSWORD`
(Zhijing enters these in the service secret store herself). When present, the
runner logs in, reads her submissions, and stops reminders for submitted papers.
Absent → cadence runs fully; authors can reply **"done"** to stop; unsubmitted
papers escalate to Zhijing at the deadline. Also set
`ADMINBOT_HEAD_PROFESSOR_SLACK` to Zhijing's Slack id for escalations.

## 3. Board (Output 0) surfaces

The Deadline Tracker has two delivery contexts and one generated dataset and interaction model:

- the AdminBot service's zero-setup page at `GET /deadlines`; and
- the public and signed-in Control UI route at `/deadlines`.

The Vercel build pre-renders the existing Control UI route at the canonical public URL
`https://jinesis-admin.vercel.app/deadlines`. Its response contains sanitized deadline
names, dates, and source links before JavaScript runs; the normal Control UI replaces that fallback
when the application mounts. `robots.txt` allows that exact route, and `sitemap.xml` lists it.
Private paper matches, proposal queues, member timelines, and nudge proposals are not rendered into
the public response.

Both show the next deadline, aggregate counts, venue filters, search, and card, grouped, and table
views. The Control UI renders the board natively in its normal document flow; it does not embed the served
page, so desktop and mobile retain one vertical scrolling surface.

Every deadline date has the same compact history-icon position in the hero, card, grouped, and table
views. The icon is disabled and gray when no history exists. An extended deadline uses a blue icon;
opening it shows every recovered former date in sequence, or explains that the source did not expose
the earlier value. The current date and time keep their normal text color.

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

### Deadline proposals

The Control UI deadline board includes a member proposal form and an administrator review queue.
Visitors can read the board, but **Propose a new deadline** sends them to sign-in and never opens the
form anonymously. A submission starts as Pending and stays out of every public deadline response.

The UI's `DeadlineProposalStore` calls the authenticated AdminBot service. Submissions, revisions,
approval actions, execution records, and published deadlines persist in the configured SQLite
ledger. A member-supplied idempotency key makes a retried submission return the original proposal.
Administrators may revise or reject a pending proposal. Every revision is a new `deadline.publish`
action with its own payload hash; the prior action is retained and cannot lend its approval to the
new content.

**Approve and publish** records the authenticated administrator as approver, executes the typed
internal publication action, and appends the accepted revision to the published deadline read
model. The public HTML, JSON endpoint, and Control UI merge those records with the generated venue
dataset at read time. Pending and rejected proposals, submitter identities, and administrator notes
never enter the public projection.

The standalone service board cannot hold a member session. Its proposal action links to the
configured Control UI `/deadlines` route, where authentication and the proposal form live.

Run `pnpm ui:build` and `pnpm ui:i18n:check` after changing the Control UI surface.

## 4. Output 1 (channel digest)

`scripts/adminbot-deadline-channel-digest.py` renders a short upcoming-deadline
summary from `venues.json`. It is dry-run by default; `--send` posts to
`ADMINBOT_ACTIVE_CHANNEL` (default `#jinesis-active`). No weekly task is
activated by this repository change; an operator must add that schedule.

## 5. Review workshop nudges (F)

F is a separate, model-based recommendation flow. It does not change the legacy matcher,
`matches.json`, reminders, or cron jobs described above.

An administrator opens `/adminbot/workshop-nudges`. The authenticated backend reads current native
AdminBot paper records, preserves their member and author links, combines the deadline rows for
each workshop into one profile, and computes up to three distinct workshop recommendations per
recipient. Multiple matching papers can support the same recommended workshop. The page
shows the topic, submission-rule, deadline, conference, attendance, and paper-source evidence plus
the exact server-generated Slack message. It also reports members without usable native paper
records and papers with unresolved authors; absent AdminBot data is not treated as proof that no
relevant paper exists.

Matching is the local model reading each workshop's call for papers against a handful of paper
titles and topic summaries, and answering with a fit and a one-line reason per pair. Requests are
one workshop against at most eight papers and run concurrently, so a full sweep is seconds rather
than minutes; each distinct paper is judged once and its answer is shown to every author. Pairs
below a 50% fit are not shown at all. The endpoint is asserted to be loopback before anything is
sent, which on this deployment is the tunnel to Aurora's vLLM.

The cross-submission rule is evidence on the page, not a gate: a workshop whose call prohibits
submitting elsewhere is still recommended and still enters the message, with its rule and source
link shown, and the administrator decides. The message itself closes by telling the recipient to
check the calls and submission rules before submitting.

Recipients with a linked Slack identity and at least one recommendation are selected by default. An
administrator may omit recipients and press **Nudge**. The backend then reads current state and
recomputes the selected recipients and exact messages before creating and executing one
`member_nudge.send` proposal per recipient. The browser cannot provide or edit the message text.

### Offline CSV matcher

CSV remains available for automated tests, local debugging, and offline demonstrations. It is not
the normal AdminBot product flow. Run the independent command with explicit inputs:

```bash
pnpm adminbot:workshop-nudges -- \
  --papers <papers.csv> \
  --attendance <attendance.csv> \
  --out /tmp/workshop-nudge-review.json
```

No sample rows are bundled with AdminBot. `--attendance` and `--out` are optional. The paper CSV
headers are:

```text
paper_id,title,year,current_submission_state,topic_summary,lab_author_names,recipient_member_id,recipient_display_name,publication_source
```

The optional attendance CSV headers are:

```text
member_id,parent_conference_key,attendance_likelihood,source,last_confirmed_at
```

List-valued paper fields use `|`. A blank recipient ID keeps supported recommendations in the
unresolved section, and a blank attendance likelihood means unknown. The command accepts historical
and title-only papers. It requires the configured local model
(`ADMINBOT_WORKSHOP_MATCH_URL`, `ADMINBOT_WORKSHOP_MATCH_MODEL`), which must be a loopback URL.

## Notes / limitations

- The legacy `matches.json` ready→workshop path remains a confirmation-gated keyword heuristic.
  F asks the local model to read calls for papers against native AdminBot papers; its offline CSV
  command does not replace that automation.
- The scripts are validated in **dry-run**; live sending needs the AdminBot
  service + Slack/`gog`/OpenReview credentials on the host.
