# AdminBot Deadline Tracker (operator guide)

Collects the lab's conference/workshop deadlines, retains expired history, and drives reminders.
Three outputs share one dataset (`extensions/adminbot/content/deadlines`):

- **Output 0** — a live countdown **board** in the Control UI at `/deadlines`.
- **Output 1** — a periodic digest posted to **#jinesis-active** (see below).
- **Output 2** — per-author **Slack DM reminders** on a 30/15/7/3/2/1-day
  cadence, stopping when the paper is submitted, else escalating to Zhijing.

## 1. Refresh the data

```bash
python3 scripts/adminbot-deadline-collect.py          # -> deadlines.json
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

Workshop notification requirements are separate from individual decision dates. The shared
NeurIPS requirement is represented as a “Notify authors by” milestone, never as each workshop's
actual decision date. The UI keeps both milestones distinct and displays conflicting observations.

Both ordinary collection and offline output regeneration migrate legacy workshop notification
values. Shared NeurIPS values become unverified policy dates; other legacy values remain as
`notification_previous_aoe` with unverified status. Revision history is retained. The existing
NLP4PI submission date remains available but is marked unverified if it lacks extraction evidence.
The UI labels unverified values explicitly.

An exact deadline carries `deadline_at` as a UTC instant; the Control UI defaults to the browser timezone. When a source gives only a date, `deadline_at` is empty and `deadline_time_precision` is `date_only`. `deadline_date` retains the published day and `deadline_timezone` records the known zone, or an empty string when the zone is unknown. The original timezone is preserved when the source supplies it; normalized legacy AoE stamps alone do not establish the source timezone.

`deadline_planning_at` is the exact cutoff when known. For a date-only source it is the start of that day in the known zone, or UTC+14 when the zone is unknown. The compatibility field `deadline_aoe` represents the same planning instant for existing scheduled consumers. This boundary is an early planning target, not evidence that submissions close then. The board shows the source day with “time unknown”, uses the normal countdown style, and explains the boundary in the deadline details. Reminder messages, calendar entries and copied member milestones identify these as planning cutoffs. Passing one does not trigger a missed-submission escalation. A matched exact OpenReview cutoff remains authoritative when the website supplies only a date.

Workshop website extraction and OpenReview observation have separate clocks. A successful website
read saves its parsed `website_deadline_candidates` alongside `profile_extracted_at`. Between
website checks, fresh OpenReview observations are reconciled against those cached candidates,
including abstract/full-paper matching and source disagreements. `source_checked_at` can advance
while `profile_extracted_at` stays unchanged. A skipped website check cannot restore an older
OpenReview cutoff. Existing datasets without cached candidates need one website read on the next
successful OpenReview observation. If neither source supplies a new observation, the previous
result and its check time are retained.

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

The public and signed-in Control UI routes share one deadline board at `/deadlines`.
The AdminBot service's `GET /deadlines` endpoint returns JSON for the board and scheduled consumers.
The operator console links directly to the Control UI board using `ADMINBOT_CONTROL_UI_URL`
(or `ADMINBOT_DASHBOARD_URL`, then the built-in Control UI address).

The Vercel build pre-renders the existing Control UI route at the canonical public URL
`https://jinesis-admin.vercel.app/deadlines`. Its response contains sanitized deadline
names, dates, and source links before JavaScript runs; the normal Control UI replaces that fallback
when the application mounts. `robots.txt` allows that exact route, and `sitemap.xml` lists it.
Private paper matches, proposal queues, member timelines, and nudge proposals are not rendered into
the public response.

The board shows the next deadline, aggregate counts, venue filters, search, and card, grouped, and table
views. The board stays in the normal document flow, with one vertical scrolling surface on desktop and mobile.

In the Control UI, every deadline date has the same compact history-icon position in the featured
deadline panel and the card, grouped, and table views. The icon is disabled and gray when no history
exists. An extended deadline uses a blue icon; opening it shows every recovered former date in
sequence, or explains that the source did not expose the earlier value. The current date and time
keep their normal text color.

The board is implemented in `ui/src/ui/adminbot/views/deadlines.ts`. Anonymous visitors receive
that same view in the public Control UI shell. The operator console links to it.
`GET /deadlines` remains a public service endpoint for current dates and approved
corrections. The collector regenerates the service and UI dataset projections together. Update explicit `ADMINBOT_DEADLINE_DATASET_PATH` overrides to the renamed dataset when deploying. Deploy the updated UI and cron readers with the service because the API path changes together.

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

Run `pnpm ui:build` and `pnpm ui:i18n:check` after changing the Control UI surface.

## 4. Output 1 (channel digest)

`scripts/adminbot-deadline-channel-digest.py` renders a short upcoming-deadline
summary from `deadlines.json`. It is dry-run by default; `--send` posts to
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


## Member deadline recommendations

Signed-in members can recommend a deadline to another active member from the board. The form searches members in pages and loads linked papers only after choosing the recipient. Several papers may be included in one recommendation. Search and member selection share a row; paper choices and long message previews scroll inside the form.

Preview creates a proposal without sending. Only its author can approve and send that exact preview to the Slack conversation containing AdminBot, the recommender, and the recipient. Changed deadlines or linked Slack identities require a new preview. Duplicate sends share an execution key across restarts. A failed send retains the preview for retry.

The board requests recommendation indicators only for visible deadlines. The directory endpoint offers separate bounded member and recipient-paper queries. Paper authorship is filtered before pagination. Requests and rendered selections are cleared on account changes; late responses are ignored. Anonymous views neither load nor display recommendations, and public deadline JSON excludes them.

### Location filtering

The location selector applies to cards, groups, tables, and the next-deadline summary alongside the existing search and classification filters. A workshop uses its own published site when available; otherwise it inherits the parent conference’s sites. A workshop with an unresolved site at a multi-site conference therefore appears under each possible parent site. “Location unknown” selects entries without any published site.

Deadline board display timezone: the browser timezone is the default for visitors and members. The searchable timezone control offers Local, Original, and named IANA zones (including UTC and AoE), and remembers the choice in browser storage independently of the member profile. Exact deadlines and their history show the UTC offset calculated for that deadline date, including daylight saving. The selector identifies named zones with their IANA identifiers, such as America/Toronto. Original uses each record's source timezone; older records without it explicitly say the source timezone is unknown and show UTC. Date-only source dates remain unchanged, while their early planning boundary is converted in details. Display choices do not affect countdowns, ordering, reminders, or saved timeline instants.

## Abstract registration prerequisites

Paper rows distinguish `abstract_requirement` values `required`, `not_required`, and `unknown` (including missing metadata). A matching abstract deadline links to its dated abstract row through `abstract_deadline_id`; without a usable linked row, its deadline remains explicitly unknown. The existing milestone timeline shows the abstract date even when it is in the past or excluded by the current filters, without a duplicate sentence beside the countdown. Milestones show their label and date without a separate passed status. Undated abstract states use the same compact milestone row: “Date unknown” for a confirmed requirement without a date, “Requirement unknown” when unverified, “Not required” when explicitly optional, and “Sources disagree” for conflicting evidence. Confirmed requirements and evidence remain in deadline details.

The collector recognizes explicit registration requirements, explicit absence or optional registration, and matched abstract/paper stages. A matching abstract date is displayed without inferring that registration is mandatory. Silence is unknown. Separate tracks and conference editions are not linked; stale rows and later abstract dates cannot supply a prerequisite. An optional abstract can have a published date without becoming mandatory. Conflicting website statements remain unknown and retain a conflict marker. Website requirements travel with cached website evidence, so a skipped or failed page read does not silently erase them.


### Workshop schedule display

In Upcoming, each workshop's displayed date, stage label, countdown, and urgency refer to its next published stage. A workshop with a passed submission can remain Upcoming while decisions or camera-ready dates are ahead. Once all stages have passed, Past shows the submission date. Cards, Groups, and Table share an expandable schedule, and switching views preserves which workshop schedules are open. A shared organizer notification cutoff is not a workshop decision date.

## Extraction evidence

Workshop reconciliation retains `deadline_observations` in the canonical dataset and generated consumers. Each observation carries its extracted date and precision, workshop URL, document or script-asset URL, extraction method, milestone, evidence, and decision. Website evidence can agree with or conflict with the matched portal cutoff; it does not silently move that cutoff. Unselected and rejected candidates remain inspectable. Skipped website checks retain their existing evidence and check age.

A page whose title or main heading explicitly identifies a different edition cannot supply the current deadline. Crossed-out dates can support extension history but cannot be selected as the current deadline. Explicit abstract and full-paper targets reject evidence for the other milestone. These guards do not prove that every unlabeled page or script belongs to the requested track; those cases still need source review.

Script assets remain a bounded fallback when the page supplies no deadline candidates. Their observations identify the actual asset separately from the workshop URL. Historical recovery remains limited to forced refreshes with extension evidence and insufficient date history. These observations describe submission deadlines; conference-wide notification policy and notification-date precedence are unchanged.


## Workshops without a submission date

Discovered workshops remain in the dataset with an empty `deadline_aoe` until a source supplies a usable date. Their stable IDs let later collection update the existing entry. Previously observed deadlines are retained when a source temporarily stops reporting them.

The board includes undated workshops in their usual venue groups, after dated entries in Upcoming, with “Deadline unknown” and neutral styling. It does not show a countdown or an Add to timeline action. Known notification or conference dates remain available as milestones, without substituting for the missing submission deadline. Undated workshops are excluded from deadline-driven matching, reminders, escalation, and channel digests.

### Deadline board layout

Group headers and expanded rows use compact padding; narrower layouts share space between countdowns and source links without breaking the countdown text. Urgency pills use the regular UI font and retain their urgency colors. Cards use compact spacing and place location and publication policy together. Conference/workshop colors distinguish entry types. Urgency pills and thin 2px left stripes across cards, group summaries, deadline rows, and the featured deadline reinforce the countdown colors. Outer cards and groups have a faint urgency tint that fades to the right; the top and bottom border colors fade into the neutral border. Interior rows retain straight urgency stripes. Card badges and stage labels can yield space without overflowing. Milestone dates break between the calendar date and time when needed, preserving room for their labels. Cards in each grid row share the same height, and a conference name already used as the title is not repeated in its subtitle.

Cards, grouped rows, and the table share the same date formatting and countdown calculation. The next-deadline summary uses the same clock as its entry. Entry type, archival status, location, and timezone controls remain visible on phones and desktop.

Publication-policy labels open a short explanation by click, tap, or keyboard. The header shows the latest source check across the dataset; each deadline’s details show its own source-check date. Correction and personal-timeline actions occupy a separate row above the source links. Official-site links remain at the right end of the source row for visitors and signed-in members.

On phones, filters use two columns when space permits and one column on narrow screens. Search remains full-width, venue chips scroll horizontally, and search and filters use 32px heights, while venue chips and view switches use 28px heights with spacing between separate controls. These compact sizes also apply on desktop.

The frontend temporarily falls back to `/deadlines/venues.json` when `/deadlines` is missing or returns the legacy HTML page instead of a dataset. Empty current datasets remain valid, and authentication or server errors are not hidden by the fallback. Remove this compatibility read after the backend serves JSON at `/deadlines`.
