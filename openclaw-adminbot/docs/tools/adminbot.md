---
summary: "Use AdminBot as a typed approval broker for sensitive lab admin actions."
read_when:
  - You want an agent to prepare reimbursements, candidate decisions, Slack invites, calendar changes, email drafts, social posts, recommendation letters, paper publishing tasks, or join form classifications
  - You need approvals and audit logging before an agent mutates external admin systems
  - You are building a restricted admin agent that can observe and propose but not execute directly
title: "AdminBot"
---

AdminBot is a plugin tool surface for running a restricted admin agent through
OpenClaw without giving the model direct authority over Slack, Gmail, Calendar,
forms, reimbursements, hiring decisions, recommendation letters, or public
posts. OpenClaw observes, summarizes, drafts, and requests typed proposals. A
separate local AdminBot service owns policy, approvals, connector scopes,
execution, and audit logs.

Use this shape when the same agent should actively read permitted conversations
or forms and suggest useful work, but every sensitive action must become a
specific approval item before anything mutates outside OpenClaw.

## Before you begin

You need a local AdminBot service listening on loopback, for example
`http://127.0.0.1:8765`. The service must implement these endpoints:

| Endpoint                              | Purpose                                                           |
| ------------------------------------- | ----------------------------------------------------------------- |
| `POST /proposals`                     | Create one typed action proposal.                                 |
| `POST /privacy/tasks`                 | Route reasoning through the VM-local privacy gate.                |
| `GET /proposals/pending`              | Return pending approval items.                                    |
| `GET /settings`                       | Return service defaults such as member privilege and escalation.  |
| `PUT /settings`                       | Update AdminBot service defaults.                                 |
| `GET /lab/members`                    | Return lab members and computed access profiles.                  |
| `PUT /lab/members/{member_id}`        | Create or update one lab member.                                  |
| `GET /papers`                         | Return paper pipeline records with computed timeline estimates.   |
| `PUT /papers/{paper_id}`              | Create or update one paper pipeline record.                       |
| `GET /papers/nudges`                  | Return due paper reminders and PI escalations.                    |
| `POST /approvals/{action_id}/approve` | Approve one immutable payload by hash.                            |
| `POST /actions/{action_id}/execute`   | Execute or simulate an approved action.                           |
| `GET /audit`                          | Return service audit events for local development and inspection. |

Keep external connector credentials in the AdminBot service. Do not place Slack,
Google, email, calendar, reimbursement, or social media write tokens in OpenClaw
workspace files, prompts, or model-visible memory.

Reimbursement packet generation shells out to Python and needs the
`python-docx` and `openpyxl` packages installed for that interpreter. For
local development, install them once with
`python3 -m pip install -r scripts/adminbot-reimbursement-requirements.txt`
(add `--user` or `--break-system-packages` if your platform requires it).
Without them, `POST /reimbursements/generate` fails with
`ModuleNotFoundError: No module named 'docx'`.

On Aurora there is no sudo and no system `pip`, so
`deploy/aurora/install-user-services.sh` bootstraps PyPA's official
[`pip.pyz`](https://bootstrap.pypa.io/pip/pip.pyz) zipapp (no preexisting pip
needed) and installs these packages with `--target` into a user-owned
directory at `~/.local/share/jinesis-adminbot/python-libs`. The AdminBot and
email-automation service units point `PYTHONPATH` at that directory so the
system `python3` picks the packages up. Rerun
`scripts/aurora-adminbot-host.sh --user <cs-user> deploy` (or
`install-user-services.sh` directly on the host) to (re)provision it —
`restart` alone does not rerun this install step.

### Private reasoning and NVIDIA NIM

The AdminBot service classifies every `adminbot_reason` request with local
Ollama `gemma4:e4b` before any remote call. Generic tasks can use NVIDIA NIM
`minimaxai/minimax-m3`. Private tasks are replaced with opaque placeholders;
only the sanitized task reaches NIM, and Gemma fills the placeholders locally.
Use `privacy="private"` or `sensitiveTerms` to force private handling. Missing
keys, uncertain or malformed classification, unsafe sanitization, and model
errors fail closed to local execution.

If the installed Ollama version cannot load Gemma, AdminBot falls back to the
local `gpt-oss:20b` model. This fallback can be slower, but it never sends the
raw request off the VM.

Run Ollama and keep model credentials and endpoints on the Red Hat VM:

```bash
export NVIDIA_API_KEY="nvapi-..."
ollama pull gemma4:e4b
pnpm tsx start-adminbot.ts
```

Vercel should serve static Control UI assets only. Prompts must connect directly
to the VM gateway over authenticated TLS; do not proxy or log prompts through a
Vercel Function, analytics collector, or other hosted middleware.

### Connect Gmail and Calendar with gog

Install and authenticate `gog` from `gogcli` on the AdminBot service host. The
provided `start-adminbot.ts` and built `start-adminbot.mjs` launch the durable
loopback service with `createGogAdminBotExecutor()`. The executor uses only
non-interactive, exact-command allowlists for Gmail drafts/sends and Calendar
create/update/delete operations.

For a headless service, configure gog's file keyring outside the repository and
provide its password through the service environment:

```bash
export GOG_KEYRING_BACKEND=file
export GOG_KEYRING_PASSWORD=<strong-keyring-password>
pnpm tsx start-adminbot.ts
```

A dry-run records `execution.simulated` but leaves the proposal approved, so the
same immutable proposal can later run live. A live request returns an error and
keeps the proposal approved when `gog` is unavailable, its payload is invalid,
or no connector handles the action type. The proposal is marked executed only
after `gog` succeeds.

Live gog payloads use these fields:

- `email.draft` and `email.send`: `to`, `subject`, `body`; optional `account`,
  `cc`, `bcc`, and `reply_to`.
- Calendar create/invite: `summary`, `from`, `to`; optional `calendar_id`,
  `account`, `attendees`, `description`, `location`, `timezone`, `all_day`, and
  `with_meet`.
- `calendar.reschedule`: `event_id`, `from`, and `to`, plus the optional Calendar
  fields above.
- `calendar.cancel`: `event_id`; optional `calendar_id` and `account`.

### Connect LinkedIn and X for paper posts

The AdminBot service can prepare and publish paper announcements to LinkedIn
and X after approval. Keep platform credentials in the service environment:

```bash
export LINKEDIN_ACCESS_TOKEN="..."
export LINKEDIN_AUTHOR_URN="urn:li:organization:..."
export X_ACCESS_TOKEN="..."
```

`LINKEDIN_VERSION` is optional and defaults to `202506`. The service calls
LinkedIn's REST posts endpoint and X API v2 tweet creation endpoint only from
the approved `social_media.post_publicly` executor path.

Use `adminbot_prepare_paper_social_posts` for prompted papers. It reads the
AdminBot paper list and lab roster, builds LinkedIn text, splits X posts into a
280-character-safe thread, and records missing author tags in the proposal. Add
author tags to member notes before approval:

```text
X: @student_handle
LinkedIn: @student-name
LinkedIn URN: urn:li:person:abc123
```

If any requested platform tag is missing, execution refuses to post and reports
which member needs `X:`/`Twitter:` or `LinkedIn:`/`LinkedIn URN:` in the roster.

### Prepare approved Overleaf paper edits

Use `adminbot_prepare_overleaf_paper_edit` when the user asks AdminBot to edit a
paper through the Overleaf project link stored on the paper record. The tool
creates a `paper.overleaf_edit` T4 proposal that includes the Overleaf edit URL,
target source files, requested changes, and any affiliation-check findings. It
does not mutate Overleaf until the immutable proposal is approved and executed.

For affiliation-sensitive edits, set `mode="affiliation_check"`. AdminBot reads
the paper authors, the lab member list, and member notes such as:

```text
Affiliation: Jinesis Lab, University of Toronto & Vector Institute
Main affiliation: Jinesis
```

The check follows the supplied affiliation policy: use the exact Jinesis wording
for Jinesis-main-affiliation members, never use `Jinesis AI Lab`, require exact
confirmation for Zhijing and special collaborators, and do not infer EuroSafeAI
or company affiliation facts without evidence. Missing or uncertain affiliations
are recorded in the proposal and block execution until corrected or confirmed.

Approved Overleaf writes require a service-side bridge or compatible API kept
outside OpenClaw prompts and workspace files:

```bash
export OVERLEAF_API_BASE_URL="https://your-overleaf-bridge.example/api"
export OVERLEAF_ACCESS_TOKEN="..."
```

Without these variables, approved execution fails closed and leaves the proposal
approved for a later live run after the bridge is configured.

## Set up AdminBot

Run `openclaw setup`, choose the manual/custom flow, and accept the AdminBot
prompt. The setup step:

- enables the bundled `adminbot` plugin with loopback service defaults;
- creates a dedicated `adminbot` agent with the AdminBot skill pack;
- configures the hosted Jinesis Control UI at
  `https://jinesis-admin.vercel.app/`;
- gives that agent only Slack messaging and AdminBot proposal/approval tools;
- pins the conversational agent to local `ollama/gemma4:e4b` so raw turns are classified on the VM;
- removes the remaining built-in minimal-profile tool;
- disables elevated exec for that agent; and
- can route unmatched Slack conversations to the `adminbot` agent.

Slack conversation uses the normal OpenClaw Slack channel. Configure the Slack
channel as usual, then let AdminBot setup add the route binding when prompted.
More specific Slack bindings, such as a team or peer binding for another agent,
continue to win before the broad AdminBot Slack route.

## Manual plugin config

Enable the plugin and keep dry-run mode on while you evaluate proposals:

```json
{
  "plugins": {
    "entries": {
      "adminbot": {
        "enabled": true,
        "config": {
          "serviceBaseUrl": "http://127.0.0.1:8765",
          "serviceTokenEnv": "ADMINBOT_SERVICE_TOKEN",
          "defaultDryRun": true
        }
      }
    }
  }
}
```

`serviceTokenEnv` names the environment variable that holds the bearer token.
The token value is read by the plugin process and is not part of the model tool
arguments.

AdminBot setup also configures the hosted Jinesis Control UI. If you configure
AdminBot manually, add the same launch URL and browser origin:

```json
{
  "gateway": {
    "controlUi": {
      "launchUrl": "https://jinesis-admin.vercel.app/",
      "allowedOrigins": ["https://jinesis-admin.vercel.app"]
    }
  }
}
```

## Manual restricted agent

Prefer a dedicated agent and workspace. Do not reuse a general personal
assistant workspace for high-risk admin workflows. Include the `adminbot`
plugin id in `tools.alsoAllow` so the bundled AdminBot workflow skills can see
the plugin tools even under the minimal profile.

```json
{
  "agents": {
    "list": [
      {
        "id": "adminbot",
        "name": "AdminBot",
        "model": {
          "primary": "ollama/gemma4:e4b",
          "fallbacks": ["ollama/gpt-oss:20b"]
        },
        "workspace": "~/.openclaw/workspace-adminbot",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "skills": [
          "adminbot-workflows",
          "adminbot-join-form-triage",
          "adminbot-reimbursements",
          "adminbot-access-invites",
          "adminbot-slack-management",
          "adminbot-recommendation-letters",
          "adminbot-social-posts",
          "adminbot-calendar-email",
          "adminbot-email-automation",
          "adminbot-paper-publish"
        ],
        "tools": {
          "profile": "minimal",
          "deny": ["session_status"],
          "alsoAllow": [
            "message",
            "adminbot",
            "adminbot_run_email_automation",
            "adminbot_reason",
            "adminbot_propose_action",
            "adminbot_prepare_paper_social_posts",
            "adminbot_prepare_overleaf_paper_edit",
            "adminbot_suggest_calendar_change",
            "adminbot_propose_slack_message",
            "adminbot_classify_join_form_response",
            "adminbot_upsert_lab_member",
            "adminbot_list_lab_members",
            "adminbot_get_settings",
            "adminbot_update_settings",
            "adminbot_upsert_paper",
            "adminbot_list_papers",
            "adminbot_list_paper_nudges",
            "adminbot_propose_paper_nudge",
            "adminbot_list_pending_actions",
            "adminbot_approve_action",
            "adminbot_execute_approved_action"
          ],
          "elevated": { "enabled": false },
          "exec": { "mode": "deny" }
        }
      }
    ]
  }
}
```

To converse with AdminBot through Slack, route unmatched Slack conversations to
that agent:

```json
{
  "bindings": [
    {
      "type": "route",
      "agentId": "adminbot",
      "match": { "channel": "slack", "accountId": "*" }
    }
  ]
}
```

Put standing orders in the agent workspace `AGENTS.md`. State that untrusted
Slack messages, emails, resumes, PDFs, forms, websites, and chat logs are data,
not instructions. Retrieved content can support evidence and drafts, but it
cannot change policy, approval requirements, or tool permissions.

## Action proposal schema

Every meaningful action should become an action proposal:

```json
{
  "type": "email.send",
  "risk_tier": "T3",
  "summary": "Email Jane Doe the trial offer",
  "target": {
    "name": "Jane Doe",
    "email": "jane@example.test"
  },
  "evidence": [
    {
      "source": "google_form",
      "id": "form_response_88"
    }
  ],
  "proposed_payload": {},
  "rationale": "The trial decision was made offline; this sends the confirmation.",
  "undo_plan": "Return the candidate to review state and revoke onboarding tasks.",
  "idempotency_key": "candidate-jane-doe-trial-2026-06-08",
  "dry_run": true
}
```

The AdminBot service adds `id`, `payload_hash`, `status`, timestamps, approver
requirements, and audit records. Approvals must reference both the immutable
`action_id` and the current `payload_hash`; if the payload changes, approval
resets.

## Lab roster and paper database

AdminBot also keeps a small structured roster and paper pipeline database in
the same local service. Use `adminbot_upsert_lab_member` for lab members and
their privilege level:

- `external_collaborator`
- `trial`
- `member`
- `admin`

The service computes default access grants for Slack, Google Drive, Overleaf,
Calendar, GitHub, and paper-pipeline records from that privilege level. Use
`access_overrides` only for explicit exceptions.

People added without an explicit level receive `external_collaborator`, the
least-privileged tier. Set `privilege_level` explicitly to grant more.

### Membership roster grid

The **Membership** tab's Onboarding section reads the lab's own Google spreadsheet live over
`GET /membership/sheet`. It needs no configuration: it defaults to spreadsheet
`1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68`, gid `764749323`, which is the
`Full Slack Member List` tab.

Point it somewhere else with any of:

| Variable                       | What it names                                                 |
| ------------------------------ | ------------------------------------------------------------- |
| `ADMINBOT_MEMBER_SHEET_URL`    | A whole Sheets URL; the spreadsheet id and `gid` are read out of it |
| `ADMINBOT_MEMBER_SHEET_ID`     | The spreadsheet id alone                                       |
| `ADMINBOT_MEMBER_SHEET_GID`    | The tab, by gid                                                |
| `ADMINBOT_MEMBER_SHEET_TAB`    | The tab, by title                                              |
| `ADMINBOT_MEMBER_SHEET_RANGE`  | The poller's `Tab!A:Z` range; its tab name is used as a fallback |

Prefer a gid. A gid survives a rename and a tab title does not, so the grid resolves the gid to
whatever the tab is called at the moment of each read, and falls back to the configured title if
the metadata call fails. A gid explicitly configured beats an explicitly configured title; the
default gid does not, so an operator who spelled out a tab name keeps it.

When the grid cannot read the sheet it says which of the three fixable things went wrong -- the tab
does not exist under that name, AdminBot's Google account cannot open the spreadsheet, or its token
has expired. A `404` from the route itself is reported as what it is: the Control UI ships from
Vercel and the service from Aurora, so a Membership tab that reports no member-sheet route is
talking to a service that predates it and needs a deploy, not a broken spreadsheet.

### Member map

`GET /member-map` groups active members by city. It's rendered two places: the
**Map** tab in the console (`/adminbot`), and its own standalone page at
`GET /lab_stats/member_map` (an interactive Leaflet world map, embedded into
the console tab by iframe so the two never drift into different maps).
Alumni are left off both. Both Slack actions -- "Refresh from Slack"
(`POST /member-map/refresh`, below) and "Sync Slack IDs & timezones"
(`POST /members/directory/refresh-slack`) -- live solely in the standalone
page's own toolbar; the console tab carries no chrome of its own around the
iframe, so there is exactly one place to trigger either.

Both also run on a schedule, so neither button is the only way the data stays
current: `adminbot-member-directory` syncs ids and timezones at 05:40 and
`adminbot-member-map` re-reads profile locations at 06:10. The buttons are for
when you do not want to wait for tomorrow. The two are separate passes writing
separate fields, which is easy to misread from their names -- the ID/timezone
sync does not touch `slack_location`, and before the map pass was scheduled a
stale Slack stamp could outrank a fresher roster location indefinitely.

Both are also reachable without a person: `scripts/adminbot-member-directory-cron.sh`
calls `POST /members/directory/refresh-slack` once a day as an OpenClaw cron job,
so timezones stay current for the calendar without an admin remembering to press
the button. Slack is the only zone source that updates itself when somebody
travels or moves, and a stale zone mis-schedules meetings silently. The wrapper
authenticates with `ADMINBOT_SERVICE_TOKEN` out of the mode-600 env file, the
same way the OpenReview and mandatory-fields passes do, and its stdout becomes
the Cron tab's run summary. It is registered by the cron sync below, like every other recurring pass.

## Leaving

`graduated_month` is `yyyy-mm` and **member-editable** -- it is their plan, and they are the one who
knows when it moves. `status` is **not**: it sits in `SELF_PROFILE_PRIVILEGED_FIELDS`, so nobody can
declare themselves alumni.

That split is the whole shape of this sweep. Three asks, three audiences:

- **Two months before**, the member is asked whether their finishing month is still right, pointed
  at the guidebook's offboarding section, and told plainly that an admin marks them as alumni --
  so they do not go looking for a control they will never find.
- **Once the month has passed** and they are still on the roster as current, the admins get one
  message listing everyone due, with both ways to clear it: set them to alumni, or clear the month
  if they have not actually gone. A queue with one exit is a queue people leave rows in.
- **Three months before the ceremony**, somebody is asked to book it, with that year's graduates
  named -- including the ones who have already left, because a ceremony is for the year's graduates
  and somebody who finished in March is exactly who it is for.

AdminBot **never sets a status**. Flipping somebody to alumni has access consequences, and a sweep
should not be the thing that performs it -- so it asks, and stops asking the moment an admin has.

Months rather than days throughout, because the field is month-granular: a day count off a `yyyy-mm`
is a precision the data does not have. Each ask is remembered per month value, so a member who moves
their date is asked again about the new one and not about the old.

The ceremony month (June) and both lead times are named constants, not arithmetic buried in the
sweep, because they are a guess at a convocation calendar rather than a fact about this lab.

## Thesis milestones

The date is the member's own -- a milestone on their Time Availability timeline whose label reads
as a thesis -- rather than a field the lab keeps about them. That is the right source and it is also
the fragile one, so `workflows/members/thesis-milestones.ts` is the whole of "what counts as a
thesis" and it is deliberately narrow: `thesis`, `theses`, `dissertation`, as whole words, in any
casing.

A **defence** deliberately does not match. Nobody grades a thesis five days after the viva -- they
grade it before -- so treating one as a submission would remind the head professor about work she
has already done.

Two things happen:

- **Fourteen days before**, the member is pointed at the guidebook's "Submitting your thesis"
  section, while reading it can still change what they do, and told that moving the date on Time
  Availability is enough for AdminBot to follow it.
- **Five days after**, the head professor is asked to grade what was due -- one message however many
  theses are ready, addressed to her about them. Unlike the escalation DM the member is not in it:
  this is a task of hers, and a student who has just submitted does not need to watch their
  supervisor being reminded to mark it.

Each is said once, tracked in the nudge ledger under `thesis_milestone`. The subject carries the
date, so **moving a thesis re-arms both messages** while re-saving the same timeline does not. Both
windows are open-ended on the late side, because a sweep that fired only on exactly day 14 or
exactly day 5 would miss every date the cron ran late for -- the ledger is what stops the open end
becoming a daily repeat.

## City channels

A city gets a Slack channel at **four members** -- `#group-toronto`, `#group-zurich`,
`#group-tuebingen`. More than three, so four: below that a city channel is two people who already
talk, and creating one is how a workspace ends up with a directory of dead rooms, which makes the
live ones harder to find.

Members are **added rather than asked**, and added **once**. `city_channel_invited_at` on the record
is the entire opt-out: somebody put in a channel who leaves stays left, because without a stamp the
next pass would put them back every few days -- an argument with a person that a cron job always
wins. Reading channel membership instead would be the same bug in better clothes, since "not in the
channel" is exactly what having left looks like. The stamp goes on whether or not Slack accepted, so
a workspace that refuses does not become a nightly retry against everyone in that city.

The field is not on the self-editable whitelist, so a member cannot clear it to be re-added.

The city comes from `resolvePlace` -- the same resolver the member map uses -- so "Zürich",
"zurich", "currently Zurich" and the IANA zone `Europe/Zurich` all land on one channel. A second
normalizer would eventually disagree with the map, and the failure would be somebody who appears in
Zürich on the map and is invited to nothing. Channel names come from the gazetteer key rather than
the label, because `#group-zürich` is not a channel anyone can have.

After the invite the member is told where they were put, the guidebook section about working from
there (Toronto, Zürich and Tübingen have one; other cities simply get no link), and how to leave --
in that order, with the leaving part not buried. They did not ask for this, so the message that
announces it is also the one that has to make undoing it obvious.

AdminBot **does not create channels**. A missing `#group-<city>` fails the invite and is reported;
opening a channel is a decision about the workspace's shape, and a sweep that quietly makes rooms is
how a directory fills with them.

## Onboarding cycles

A member's setup checklist is a **cycle**, not a one-off. It opens at registration and re-opens
whenever their `status` or `privilege_level` changes -- the two facts that change what the lab is
asking of them.

Re-opening clears the acknowledgement on the steps flagged `reaffirm_on_standing_change`, and only
those: today, compute access and the communication norms. Everything else -- follow the lab on
LinkedIn, put a photo on your profile, set your Drive folder up the agreed way -- is one-time fact,
and re-asking all of it on every promotion would teach people to click through reading material
without reading it, which is the one failure a checklist of reading material cannot survive.

`opened_at` is why the cycle is a thing rather than the checklist simply existing: it is the clock
the follow-up runs on. Without it, "still not done after ten days" could only be measured from the
account's creation, so somebody promoted in their third year would be chased on day one about a
checklist that opened that morning.

The follow-up (`scripts/adminbot-onboarding-chase-cron.sh`) asks once at ten days and every two
months after that. It names the outstanding steps rather than counting them, and says _why_ the
list re-opened -- a member who finished onboarding two years ago and has just been promoted would
otherwise read it as a bug. It is deliberately not an escalating nudge.

## Nudges, and which of them escalate

Every nudge goes three ways: a Slack DM, a notification in the portal, and a warning across the top
of the member's dashboard. The notification is filed before the send and kept whatever the send
does, so a Slack outage -- or a member with no linked Slack account -- cannot be what decides
whether somebody was ever told.

| Nudge                          | Runs                | Channel        | Escalates |
| ------------------------------ | ------------------- | -------------- | --------- |
| Setup checklist still open     | 10 days, then 60    | Slack          | no        |
| Onboarding follow-up           | 5 business days, +3 | Slack          | **yes**   |
| Never signed in                | every 3 days        | Slack          | no        |
| Thesis deadline approaching    | 14 days before      | Slack          | no        |
| Thesis ready to grade          | 5 days after        | Slack          | no        |
| Finishing month approaching    | 2 months before     | Slack          | no        |
| Alumni transition due          | month passed        | Slack          | no        |
| Graduation ceremony            | 3 months before     | Slack          | no        |
| Paper evidence slots           | weekdays 09:10      | Slack          | **yes**   |
| Profile fields / term timeline | weekdays 09:20      | Slack          | **yes**   |
| Pre-registration               | Thursdays 14:00     | Slack          | **yes**   |
| PaperFlow venue stage          | weekdays 09:00      | email          | no        |
| Weekly paper updates           | Mondays 10:00       | Slack          | no        |
| Meeting attendance             | Mondays 09:30       | Slack          | no        |
| Profile photo                  | on demand           | Slack          | no        |
| Onboarding step                | admin-triggered     | Slack or email | no        |
| Workshop matches               | admin presses Nudge | Slack          | no        |
| Ad-hoc admin nudge             | admin types it      | Slack or email | no        |

### The onboarding follow-up ladder

The onboarding email itself is sent by hand. What follows it is not:

1. **Five business days** after the welcome, if the member has neither signed in nor edited
   anything, a Slack reminder. Business days, so somebody welcomed on a Thursday is not chased over
   their first weekend.
2. **Three days later**, a second reminder, which says it is the second and says the next thing that
   happens is a person.
3. **Five days after that**, both reminders land on the professor's page under that member's name,
   and AdminBot stops asking.

Any sign of life ends it at any step -- a sign-in or an edit the member made themselves. The
escalation writes `escalated_at` on the notifications the ladder already filed, so it arrives in the
queue the professor's page already reads rather than in a second list to remember to check.

Running alongside it is a standing reminder for anyone who has **never signed in at all**, every
three days. It stands aside while the ladder owns a member, so a newly welcomed member is never
chased twice in the same week about the same thing in different words.

Both are driven by `adminBotDormantChaseMemberTypes` in `contracts/actions.ts`, which is `["full"]`
today. Adding `"alumni"`, `"own-pace-advisee"` or `"coauthor-major"` to that array is the whole
change needed to bring those groups in -- nothing else reads a member type to decide who is chased.
Alumni are refused separately and always, so adding `"alumni"` there will mean "an alumnus still
holding a lab role", never "chase people who have left".

Both run from `scripts/adminbot-disengagement-cron.sh`, which is safe to run daily: the cadences
live in the service, so a doubled crontab cannot turn either into a daily nag.

The four that escalate are the four where nobody finding out costs something that cannot be
recovered later: a missing submission link when the deadline does not move, a blank profile or
timeline that everything downstream is planned from, a paper the group meeting cannot plan around
because nobody registered it, and a member who never arrived at all -- who is the one case where
the thing that has gone wrong is invisible from every other page, because somebody who has never
signed in generates no rows anywhere. The rest are worth saying and worth reading, and a sweep that
pulled the head professor into every unanswered one would train everybody to ignore the ones that
matter.

The onboarding ladder escalates on its own schedule rather than through
`adminBotNudgeEscalateAfterDays`: it has already asked twice on a clock the lab chose, so the
generic five-days-unread rule would only ask a third time before doing the same thing.

An important nudge that is still unread after `adminBotNudgeEscalateAfterDays` (five) is stamped
`escalated_at` and appears on the professor's page, under that member's name, with everything of
theirs that is overdue. The member gets one Slack DM saying it has gone there. It escalates once.

**AdminBot sends the PI nothing.** Not a Slack DM, not a portal notification, not a dashboard
warning -- their entire queue is the escalation list on their own page. Two rules keep it that way:
`sendMemberNudge` refuses the head professor ahead of the notification write, which covers every
sweep because that function is the only place a notification is ever created; and the escalation,
which used to open a three-way DM with them in it, now writes only to the desk.

The member is still told, and told where it went, so this is not a private complaint about them --
which was the reason the three-way DM existed. What changed is that the professor reading it in a
DM was the same item said twice to the one person who cannot act on it by replying.

`POST /nudges/send` -- the one route where the text and the recipients come from a browser --
deliberately drops `important`. The reason the escalation can auto-execute is that nothing but a
server-computed sweep can raise the flag, so "AdminBot escalated this" cannot come to mean "an
admin typed something and waited".

## Scheduled passes

Every recurring AdminBot job is declared in [`config/adminbot-cron.json`](../../config/adminbot-cron.json)
and applied with:

```bash
scripts/adminbot-cron-sync.sh            # apply the manifest
scripts/adminbot-cron-sync.sh --dry-run  # show what it would change
```

The sync is idempotent -- a job already in the store is edited to match rather than added again --
so it is safe on every deploy and is the intended way to change a schedule. It never removes a job
the manifest does not mention; it names it and leaves it alone.

Registration used to be a `pnpm openclaw cron add` block copied out of whichever doc described that
feature. Three of the fourteen wrappers had one and the rest were registered by hand on the host, so
"what does AdminBot run, and when" could only be answered by reading the cron store on Aurora -- and
a job that was never registered is silent: nobody is nudged and nothing errors.

| Job                                 | Schedule             | What it does                                                                 |
| ----------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| `adminbot-email`                    | `5 * * * *`          | Hourly inbound email triage pass                                             |
| `adminbot-openreview`               | `15 0,6,12,18 * * *` | Reviewing-cycle pass, four times a day                                       |
| `adminbot-meeting-artifacts`        | `20 * * * *`         | Meeting artifact drop-folder pass                                            |
| `adminbot-member-directory`         | `40 5 * * *`         | Daily Slack timezone/directory sync                                          |
| `adminbot-slack-directory`          | `45 5 * * *`         | Daily Slack channel directory refresh                                        |
| `adminbot-deadline-refresh-venues`  | `50 5 * * *`         | Refresh conference/workshop deadlines from official CFPs                     |
| `adminbot-deadline-refresh-matches` | `20 6 * * *`         | Re-map papers onto the refreshed deadlines                                   |
| `adminbot-vector-roster`            | `30 6 * * *`         | Daily Vector sponsor spreadsheet refresh                                     |
| `adminbot-graduations`              | `0 8 * * 1`          | Confirm finishing months, chase alumni transitions, and arrange the ceremony |
| `adminbot-city-channels`            | `0 7 * * 1,4`        | Add members to their city Slack channel once a city reaches four             |
| `adminbot-email-templates`          | `30 8 * * 1`         | Check the email-template doc against the shipped copy                        |
| `adminbot-paperflow-nudges`         | `0 9 * * 1`          | PaperFlow venue-stage nudges, once a week                                    |
| `adminbot-paper-slot-nudges`        | `10 9 * * 1-5`       | Chase the evidence each paper still owes                                     |
| `adminbot-mandatory-fields`         | `20 9 * * 1-5`       | Chase profiles and term timelines that are still blank                       |
| `adminbot-onboarding-chase`         | `40 9 * * 1-5`       | Chase setup checklists still open after ten days, then every two months      |
| `adminbot-thesis-milestones`        | `50 9 * * 1-5`       | Guidebook nudge before a thesis deadline, grading reminder five days after   |
| `adminbot-meeting-attendance`       | `30 9 * * 1`         | Chase members who have stopped coming to the group meeting                   |
| `adminbot-weekly-updates`           | `0 10 * * 1`         | Ask authors for the week's paper updates                                     |
| `adminbot-prereg-nudges`            | `0 14 * * 4`         | Pre-meeting pre-registration sweep                                           |
| `adminbot-onboarding-confirm`       | `10 */2 * * *`       | Onboarding-step confirmation loop                                            |
| `adminbot-nudge-escalation`         | `0 11 * * 1-5`       | Ask the head professor to chase what nobody answered in five days            |

Times are the gateway's. The nudge passes are staggered through the morning and
`adminbot-nudge-escalation` runs after them on purpose: it reads what those passes filed, so running
it first would chase yesterday's list.

The pass stamps `timezone` from Slack's `tz`, backfills `slack_user_id` by email
for members the roster never linked, and re-tallies 7-day message counts -- one
route does all three, and the timezone is the reason it runs daily. A member
Slack answers nothing for has their zone cleared; a member the _lookup failed_
for keeps what they had, so one bad night on the Slack API cannot blank the
roster's mandatory timezone field.

The endpoint is public, but its response shape depends on who's asking:

- Signed in as **admin**: `{ mode: "full", places: [...{ ...place, members:
[{ member_id, name, source, avatar_url?, last_login_at? }] } ], unplaced,
counts }` -- names included, plus each member's Slack avatar and last login
  time where known, for the recently-active faces shown per city.
- Anyone else (anonymous, or a signed-in non-admin member):
  `{ mode: "summary", places: [...{ ...place, count }], counts }` -- a
  headcount per city, no names, no `unplaced` list (the header counts already
  say how many are unplaced). See the end of "Login location" below for why
  the split lands on names specifically, rather than the map as a whole.

`POST /member-map/refresh` (re-reading Slack -- see below) stays admin-only
regardless: publishing a headcount is one thing, triggering a real Slack API
call on someone else's behalf is another.

Location comes from three sources, tried in a fixed order, each one falling
through to the next whenever it fails to resolve -- not only when it is empty.

1. **Slack**, city-level. `POST /member-map/refresh` reads each member's Slack
   profile (a workspace location field if one is configured, otherwise their
   timezone, whose IANA name carries a city) and stamps it on the member as
   `slack_location`. A member Slack no longer knows about has their stamp
   cleared rather than left stale, so an old value cannot outrank a fresher
   source forever. That clearing only happens when the pass runs, which is why
   it is scheduled daily (`adminbot-member-map`, 06:10) rather than left to the
   button: this is the one source of the three that cannot refresh itself, and
   it is the one the other two defer to.
2. **Last-login location**, country-level only. Stamped automatically on every
   successful sign-in from the caller's IP (see "Login location" below) -- there
   is nothing to manually refresh here, it is already as current as their most
   recent login.
3. **Roster `location`**, city-level -- what they typed once, at signup or when
   an admin added them. Tried last on purpose: unlike the two sources above, it
   never updates itself.

All three are free text (or, for last-login, a plain country name), so the
resolver copes with what people actually write: institutions (`ETH` becomes
Zürich), accents and spelling variants (`Tuebingen`/`Tübingen`), several places
at once (`Zurich/Tuebingen/Toronto` takes the first), parentheticals, and
leading hedges (`Mainly Montreal`). Anything none of the three sources can
place is listed under **Not placed** with whatever the highest-priority source
that had text wrote -- that is the signal to add a city (or country, for
last-login) to the tables in `extensions/adminbot/src/member-map.ts`, not a
reason to guess. A member placed by last-login only (no city, just a country)
shows on the map as a dashed, lighter dot, distinct from a real city-level
placement.

### Login location

On every successful login, if `IPINFO_TOKEN` is configured, AdminBot
geolocates the caller's IP (via IPinfo's free "Lite" tier -- country and
continent only, not city-level) and stamps `last_login_at` /
`last_login_country` / `last_login_continent` on the member record. This is
best-effort and fire-and-forget: it never blocks or fails the login itself,
and with no token configured it is simply skipped. It is visible to the
member on their own profile ("Last login location", top of the Profile tab)
and to admins in the Members table.

Behind a reverse proxy (Render, Fly, etc.) the caller's real IP only reaches
AdminBot via the `X-Forwarded-For` header, since the proxy terminates the
actual connection -- set `ADMINBOT_TRUST_PROXY=1` in that environment so
`remoteIp()` reads it, otherwise every login resolves to the proxy's own
(private, unroutable) address and nothing ever gets recorded. Leave this unset
for any deployment where the app might be reached directly: trusting the
header there would let a caller spoof both this and IP-based rate limiting by
hand-writing it.

Names are gated on read, not the map itself: the brainstorming doc describes
this as a public website function, and publishing 144 people's names and
locations was a decision worth making deliberately rather than inheriting
from the view being built -- so the map is public, but only ever in the
counts-only `summary` shape above unless the request carries an admin
session. Both `/lab_stats/member_map` and the console's Map tab reflect this
directly: a signed-out visitor (or a signed-in non-admin member) sees dots
sized by headcount with no names anywhere, and only an admin session sees who
is actually where.

### Time availability

Each member maintains their own time availability as plain text on their
profile, one period per line:

```
Until 09032026: 20% Rebuttals, 30% Studying, 50% FAR AI Collaboration
Until 12312026: 60% Game Theory, 40% Teaching
```

The date is the end of the period written as `MMDDYYYY` (ISO `YYYY-MM-DD` is
accepted too), and periods run consecutively from today. Percentages within a
period may add up to less than 100 but never more; whatever is left over shows
as unallocated rather than being scaled up to fill the bar.

`away` is the one reserved activity name, for time out of the lab entirely --
holiday, an internship, a semester elsewhere:

```
Until 12312026: 20% Thesis, 80% away (internship at DeepMind)
Until 02152027: 100% away (parental leave)
```

The reason in parentheses is optional but worth writing: it is what the chart
labels the band with. Away time is deliberately not the same as unallocated
time. Unallocated reads as spare capacity someone could take on more work in;
away is the opposite, and mixing them would tell an AC hunting for an emergency
reviewer that someone on internship is wide open. It renders in its own neutral
band rather than a categorical colour, and a member who is away for **all** of
their current period is not proposed as an emergency reviewer at all. Being
partly away does not gate them out -- they are still around, just with less time. The service parses
the text once on save and stores the structured periods, so a bad line is
rejected with a message saying what to fix.

The console renders this as a stacked chart per member, one band per period with
its width proportional to how long the period runs. The roster's Availability
column shows a compact strip for the period in force today; the full chart is on
the member's own profile and in the admin person editor. Members can set this
themselves without an admin, the same as the rest of their profile.

Use `adminbot_upsert_paper` for each paper. The standard pipeline is:

1. `brainstorming_docs`
2. `overleaf_writing`
3. `submission`
4. `google_drive_pdf`
5. `arxiv_polish`
6. `social_posts`
7. `slide_making`
8. `poster_making`

Paper records store links such as Brainstorming Docs, Overleaf view/edit URLs,
submission URL, Google Drive PDF, arXiv URL, GitHub URL, Twitter/LinkedIn
drafts, Google Slides, and poster output. For arXiv polish, track paper mentor,
affiliation, and GitHub-link checks. For social posts, authors write Twitter
first; AdminBot can adapt the content for LinkedIn and suggest tags. For poster
making, start from the top six meaningful slides and rearrange them into a
poster plan.

When AdminBot asks authors for the next paper step, record
`reminder.status="waiting_on_authors"` and `last_author_dm_at`. Calling `adminbot_list_papers` returns each paper with an estimated Gantt-style timeline derived from the current progress step. Calling `adminbot_list_paper_nudges` returns author reminders or a `head_professor_escalation` after three business days without an author reply. Set `head_professor_member_id` to Zhijing's lab-member id for Andrew's lab, then use `adminbot_propose_paper_nudge` to create the approval-gated Slack reminder that asks Zhijing to nudge the paper authors directly.
The same defaults can be managed through service settings:
`paper_escalation_business_days` and `head_professor_member_id`.

For local development, open the mock service at `/adminbot` to manage settings,
members, active papers, due nudges, pending actions, and audit events in a
browser. The Control UI also supports a non-admin view: the admin password opens
the full AdminBot dashboard, while the general password `jinesis` opens a
read-only paper/member view. The console talks to the same local service
endpoints as the AdminBot tools, so it does not create a second source of truth.

These records are operational state, not freeform memory. They belong in the
AdminBot service ledger so reminder timing, privilege levels, and paper links
survive restarts.

The bundled development service can keep this ledger in memory for tests, or it
can auto-create a local SQLite file with
`createAdminBotSqliteService({ databasePath })`. Set `auditRetentionDays` to
prune old audit events while preserving the proposal, approval, execution, and
idempotency rows needed for safety checks.

For local development, the mock service can use the same zero-setup ledger:

```ts
createAdminBotMockService({
  databasePath: "state/adminbot.sqlite",
  auditRetentionDays: 30,
});
```

Use Markdown for standing orders, workflow notes, rubrics, and human-readable
proposal exports. Use the SQLite ledger for the small amount of structured
state that must survive restarts: immutable payload hashes, approval records,
execution status, idempotency keys, and audit events.

## Member availability and lab capacity

Each lab member records how much time they have, on what, and when they are
away. Members own this data: they edit it themselves under **My profile**, and
nothing else in AdminBot overwrites it without being asked to.

A member's schedule is two lists on their roster record.

`availability` holds committed working time as one row per project per date
range: `start`, `end`, `hours_per_week`, an optional `project`, and an optional
`note`. Two project values are special. Omitting `project` means a whole-term
baseline commitment not tied to any one project. The reserved value `__open__`
means declared spare capacity — hours the member is offering for something new
or to help others. It is a sentinel, not a real project, so it never appears in
their `projects` list.

`time_off` holds periods away from the lab: `start`, `end`, a `kind` of
`vacation`, `internship`, `course_load`, `travel`, `conference`, or `other`, and
an `availability` of `none` or `partial`. Availability is deliberately separate
from the reason, because either can apply to the same kind: a conference might
block the week entirely or leave someone partly available, and so might a heavy
teaching semester. `none` zeroes the week; `partial` still counts toward
capacity at a reduced rate. AdminBot never infers one from the other.

Both lists are validated on write. Dates must be `YYYY-MM-DD` and are parsed as
UTC calendar days so a server timezone cannot shift a range onto the neighbouring
day; a range cannot end before it starts; `hours_per_week` must be between 0 and
168; and each list is capped at 200 rows.

`availability_updated_at` is stamped by the service, not the caller. It moves
only when the schedule content actually changes, so saving an unrelated profile
field — a new website, a corrected name — does not reset it. That makes it a
usable staleness signal for finding members whose hours have gone out of date.

### Reading it

**My profile** shows the member their own `Time Availability_<name>` timeline:
weeks across, one row per project, with declared open capacity and time off
drawn as distinct non-project bands. A Table view lists the same rows as text.
The editor sits directly beneath the chart and redraws it on every keystroke;
nothing is written until the member saves.

**Capacity** shows the whole lab: one row per member over the same week columns,
with a project keeping the same colour across everyone so a commitment can be
traced between people. Alongside it are the current week's totals — people
scheduled, committed hours, declared open hours, and how many people are away —
plus a per-project staffing roll-up and a capabilities roll-up derived from
member research branches and topics. The capabilities table reads the roster
rather than the schedule, so it still answers "can the lab do X" for members who
have not recorded any availability yet.

Time-off _reasons_ are visible lab-wide only to `admin` sessions. Everyone else sees that a person is away or partly away, without why.
A member always sees their own reasons. Why someone is away — an internship, a
hard semester — is personal, so the lab-wide default is the less revealing one.

### Importing from a planning doc

Members who already track availability in a Google Doc can link it instead of
retyping it. The link goes in **My profile → Planning doc**, and must be an
`https` `docs.google.com` or `drive.google.com` URL: the importer fetches it
server-side with the AdminBot Google account, so the field is restricted to
hosts that account can legitimately read.

The doc has to be shared with the importer's account — `Viewer` is enough.
Without that the export comes back empty and the import reports a failure for
that member. The account is exported as `ADMINBOT_DRIVE_ACCOUNT` and shown in
the UI beside the field, so the instruction cannot drift from the account doing
the reading.

Run the importer with:

```bash
node --import tsx scripts/adminbot-availability-import.ts --db state/adminbot.sqlite --dry-run
```

| Flag                      | Effect                                                     |
| ------------------------- | ---------------------------------------------------------- |
| `--db <path>`             | AdminBot SQLite ledger; defaults to `$ADMINBOT_DB_PATH`.   |
| `--member <id>`           | Import one member instead of everyone with a linked doc.   |
| `--reference-date <date>` | Anchor for relative wording in the doc; defaults to today. |
| `--dry-run`               | Print what would be written and change nothing.            |
| `--force`                 | Overwrite a schedule that already has rows.                |

Planning docs share no common structure — some are tables, some bullet lists,
some prose — so extraction is a constrained model call rather than a parser. It
converts stated effort into hours (`2 days a week` becomes 16) and resolves
dates against the reference date, which is why a doc saying only "Sept 14" still
lands on a year. Anything it cannot place on a definite date is reported as
`unresolved` for a human to deal with instead of being guessed into a row. The
document is treated strictly as data; text inside it that looks like
instructions is never followed.

Imports are written through the same validated self-profile path a member's own
save uses, so the service remains the only authority on what a valid schedule
is. **A schedule that already has rows is skipped** unless `--force` is passed:
an extraction is a guess, and a row a member typed is not. Start with
`--dry-run` and a single `--member` before importing across the roster.

## Skills and code responsibilities

Implement most AdminBot features as skills over a small typed code surface.
The plugin ships a bundled AdminBot skill pack. The `adminbot-workflows` skill
routes requests to focused skills for reimbursements, candidate decisions,
recommendation letters, social posts, calendar/email, PaperPublish,
Slack/Vector access, Slack management, and join-form classification. Skills
should read permitted context, follow lab-specific instructions, gather
evidence, draft content, and decide which AdminBot proposal to create. The code
surface should stay responsible for security-sensitive mechanics:

| Layer            | Owns                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills           | Reimbursement preparation, candidate workflow, recommendation-letter workflow, social post drafting, calendar/email triage, PaperPublish preparation, Slack management playbooks, and join-form classification rubrics. |
| AdminBot tools   | Typed proposals, lab-member and paper-record updates, due-nudge listing, payload hashing, pending-action listing, approval submission, and execution requests.                                                          |
| AdminBot service | Policy, approver roles, lab roster, paper database, reminder timing, connector credentials, connector scopes, idempotency, execution, and audit retention.                                                              |

This keeps setup light while avoiding prompt-only security policy. A skill can
say "prepare a reimbursement packet from these receipts"; the service still
decides whether the packet can be submitted, who must approve it, and whether
the exact payload has already been executed.

## Risk tiers

Start with this policy:

| Tier                              | Default behavior                                                       | Examples                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `T0` observe                      | Auto-run when data access is permitted.                                | Summarize, classify a join form, detect opportunities.                                                                          |
| `T1` draft                        | Auto-run when policy allows.                                           | Draft email, draft social post, prepare reimbursement packet, draft recommendation letter.                                      |
| `T2` reversible internal action   | Auto-run only when reversible and explicitly allowed.                  | Label email, create internal task, create tentative calendar hold.                                                              |
| `T3` sensitive external action    | Requires explicit approval.                                            | Send email, invite Slack guest or member, send calendar invite.                                                                 |
| `T4` HR, public, financial, legal | Requires explicit approval; some actions should require two approvers. | Accept or decline candidates, submit reimbursements, post publicly, send recommendation letters, submit paper publishing tasks. |

Never auto-decline candidates, auto-post public content, auto-send
recommendation letters, auto-submit reimbursements, or auto-send external
messages unless your AdminBot service policy explicitly permits that action
after the required approval.

## Policy file

Keep lab-specific policy in the AdminBot service, not in OpenClaw prompts:

```yaml
candidate_decisions:
  accept_direct:
    requires_approval: true
    approver_roles: ["pi"]
  accept_trial:
    requires_approval: true
    approver_roles: ["pi", "lab_manager"]
  decline:
    requires_approval: true
    approver_roles: ["pi", "lab_manager"]

social_media:
  draft:
    auto_allowed: true
  post_publicly:
    requires_approval: true

calendar:
  create_tentative_hold:
    auto_allowed: true
  send_invite:
    requires_approval: true
```

The action broker should check approval status, risk tier, actor permissions,
connector scope, idempotency key, rate limits, dry-run state, and policy
constraints immediately before execution.

The bundled development service implements the policy defaults above, immutable
payload-hash approvals, idempotent execution replay, and audit events for
proposal creation, auto-approval, approval recording, simulated execution, real
execution, and idempotency replay.

## Production readiness

Run in dry-run mode for one or two weeks. Track false positives, missed
opportunities, bad evidence, privacy leaks in drafts, approval rejections, and
manual edits before increasing autonomy.

Store evidence pointers rather than large raw dumps. An audit record should be
able to reconstruct a decision through source IDs, short snippets, hashes, and
access-controlled links without copying entire private chats or emails into a
separate model-visible store.

Keep connector scopes minimal. Start read-only for Gmail, Slack, Calendar, and
Forms. Add write scopes only for the workflows that have service-side approval
checks and audit logging.

## Related

- [Email template drift check](/tools/adminbot-email-templates)
- [PaperFlow stage nudges](/tools/adminbot-paperflow-nudges)
- [Email triage](/tools/adminbot-email-triage)
- [Standing orders](/automation/standing-orders)
- [Per-agent sandbox and tool restrictions](/tools/multi-agent-sandbox-tools)
- [Skills config](/tools/skills-config)
- [Lobster](/tools/lobster)
- [Plugin manifest](/plugins/manifest)

## Where members are, over time

Three roster fields answer "where is this person" and each overwrites itself, so nothing could
answer **"when did they move"** — which is the question that matters when a member spends three
months in Berlin and keeps being invited to a 10am Toronto meeting.

`adminbot_member_locations` is an append-only timeline fed by three sources:

| Source          | Written by                                                            |
| --------------- | --------------------------------------------------------------------- |
| `self_reported` | any profile edit that changes `location` / `current_city`             |
| `login_ip`      | the country of a successful sign-in (IPinfo Lite, country-level only) |
| `slack_profile` | the member-map Slack sweep                                            |

An observation is appended only when it **differs** from the last one from the same source, so a
member who signs in twice a day adds no rows and the timeline stays a change log.

**Inference never writes a profile.** When recent sign-ins disagree with the profile for long
enough — 2 sign-ins spanning 3 days, counted over the unbroken run of the current country — the
member gets a banner on their own profile quoting the evidence. Confirming writes `current_city`
and a timezone guessed from it through the ordinary self-edit; dismissing writes nothing and
settles the question for that country only. A later move somewhere else asks again.

Routes: `GET`/`POST /profile/location-prompt` (self only), `GET /lab/members/:id/locations` (self
or admin), `GET /lab/location-drifts` (admin — everyone worth re-checking before scheduling).

### Where it is used

**Reporting.** Two paths. The banner on the profile is the reactive one, raised when sign-ins
disagree. **Time Availability → "Trips away from home"** is the planned one: a member logs a city
with a date range, the same way they log a commitment, and it is stored on `trips` alongside
`availability` and `time_off`. The profile's `location` stays the home address.

A trip is not time off. A time-off row says a member is unavailable and says nothing about where
they are; somebody working normal hours from Berlin is fully available and six hours off the lab's
clock, which is the case that produced 10am invites landing at 4pm.

A logged trip also answers the drift prompt in advance: sign-ins from a country a member already
logged a trip to raise no question, because they have already said where they are.

**Scheduling.** The calendar grid carries a one-line `✈` marker on days somebody is away — the
person's name when it is one, a count when it is more, with the full list in the tooltip. The
invite list shows each attendee's own clock for the selected event, in bold with `(early)` / `(late)` when it lands before 08:00 or from 21:00. A member the
roster cannot place reads "local time unknown" rather than a guessed clock face. An attendee whose
recent sign-ins disagree with their profile carries a `⚑ may be in <country>` flag, because their
local time was computed from a location nobody has confirmed.

The zone comes from `resolveAttendeeZoneAt`, resolved against the event's own date, most specific
first: a logged trip covering that day, then an explicit `timezone`, then a zone guessed from
`current_city`, then from `location`. So September invites read in Berlin time and October invites
read in home time without the member touching anything twice.
