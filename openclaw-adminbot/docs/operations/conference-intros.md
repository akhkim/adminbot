# Conference intros

When lab members confirm Going to a conference on an accepted paper, AdminBot introduces them to
each other in a three-person Slack group DM (`slack.conference_intro`). It runs after the existing
`#conf-<venue>-<year>` channel invite, from the same save, and through the same proposal, policy
and execution gate.

## Who is in each intro

- Only attendees marked Going on the conference roster who have a linked Slack account and are not
  alumni. Personal trips from the Travel tab are not included yet.
- Nothing is sent until three such people exist. The first intro then covers all three.
- After that, each newly Going person gets one intro with the two co-attendees whose research
  themes overlap most with theirs. Themes come from `research_topics` and `projects`, classified
  in `workflows/members/research-themes.ts`.
- If fewer than two co-attendees share a theme, the remaining places are a seeded random sample.
  The seed is the conference key plus the member, so a retry offers the same people. The message
  says when a pick was random.
- Anyone already named in a delivered intro for that conference is not introduced again.

## What the message says

Plain text (Slack `mrkdwn` off). It contains:

- the names, and the shared themes where there are any;
- **When**: the main conference dates from the deadline dataset, plus the number of days left;
- **Where**: the conference location, plus a Google Maps search link;
- **Event page**: the conference homepage from the dataset.

Multi-site conferences list each site. If the dataset has no row for the conference, the message
says AdminBot has no dates or location on file. It never guesses. COLM is not in the collector's
dataset today, so a COLM intro would hit this case.

## Safety

- `autoPolicy("T1")`, the same as the other server-composed group DMs (`member_nudge.escalate`,
  `paper_integrity.alert`). The service computes the recipients and the text; no caller supplies
  them.
- The Slack executor refuses any `slack.conference_intro` payload that does not have exactly three
  distinct Slack user IDs.
- The idempotency key `conference-intro:<conference>:<member>` and the Slack `client_msg_id`
  prevent a replay from posting twice. Runs for the same conference are serialized.
- An unexecuted attempt whose recipients or text have changed is removed and proposed again. An
  intro an admin rejected stays rejected.

## Manual run

`POST /papers/conference-rosters/<key>/intros` (admin session only) runs the same pass and returns
`{ introduced, skipped, failed }`. Use it after fixing a Slack outage. It does not resend
delivered intros.
