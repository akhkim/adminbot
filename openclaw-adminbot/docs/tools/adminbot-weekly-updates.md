# Weekly updates

What each author did on a paper this week, in their own words, and the Sunday sweep that asks the
people who have not said yet.

## Why prose

Everything else on a paper card is an artifact: a link, a tick, a submission id. Each of them
either exists or does not, and none of them answers the question a coauthor actually asks on a
Monday — what moved last week, and who moved it. That answer is prose, it is per person rather
than per paper, and it is worth reading only if it is written while the week is still fresh.

One entry per author per paper per week. A member writes their own line and nobody else's: the
service takes the author from the session, and an admin gets no exception, because the whole value
of the log is that every line is first-hand.

## The week key

Weeks are keyed by their **Monday, in UTC** (`adminBotWeekStart` in
`extensions/adminbot/src/contracts/paper-weekly-updates.ts`).

- Monday-start, so a Sunday reminder asks about the week that is *ending*. A Sunday-start week
  would make the Sunday sweep ask about a week one day old.
- UTC, so the key is computable from a date alone in both the service and the browser, without
  either consulting a settings row. Two people in Toronto and Zurich writing on the same evening
  report the same week and land in the same bucket.

## What runs

`scripts/adminbot-weekly-update-cron.sh` — **Sundays**, added in the Control UI's Cron tab as a
`command` job:

```
scripts/adminbot-weekly-update-cron.sh
```

Suggested schedule: Sunday evening in the lab's own timezone, late enough that the week is over
and early enough that the answer is still same-day.

Running it more than once is harmless. The service records who it asked about which week in the
audit ledger (`paper_weekly_updates.nudged`) and will not ask the same person twice for the same
week, so an hourly crontab, a retry and a manual press all collapse into one nudge. The next week
is a new question.

Papers that are dormant or rejected are skipped: nobody owes a weekly line on a paper that is
resting, and a sweep that asked would teach people to ignore it.

### Environment

| Variable | Required | What it does |
| --- | --- | --- |
| `ADMINBOT_SERVICE_TOKEN` | yes | What the cron script authenticates with. |
| `ADMINBOT_PORT` | no | Defaults to 8765. |

## Routes

| Route | Who | What |
| --- | --- | --- |
| `POST /papers/{id}/weekly-updates` | member session | Writes the caller's own line. `body`, optional `week_start` to correct an earlier week. |
| `GET /papers/{id}/weekly-updates` | any signed-in principal | The log for one paper. Also carried on `GET /papers/{id}/slots` as `weekly_updates`, which is how the card gets it. |
| `GET /papers/weekly-updates/pending` | privileged | Preview: who owes a line this week, from the same walk the sweep sends from. `?now=` for a fixed clock. |
| `POST /papers/weekly-updates/run` | privileged | The sweep. One Slack message per person listing every paper they owe. |

## What it does not do

- **No replies.** The log is a column of first-hand accounts, not a thread. A coauthor who wants to
  respond has Slack.
- **No status field.** "What did you do" is the question; a dropdown of on-track/blocked would be
  answered by everyone the same way within a month.
- **No prose in the audit log.** `paper_weekly_update.saved` records the paper and the week and
  nothing else — the entry is somebody's account of their own week, and the audit log is read by
  more people than the paper card is.
