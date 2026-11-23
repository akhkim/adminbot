# API usage and automation telemetry

Owner: AdminBot maintainers.

## Why

Admins could not see who uses the `adminbot` CLI and API tokens, which operations they call, or
how much the cron sweeps actually do. This adds a small usage log to the AdminBot SQLite database
on Aurora and an admin-only page that reads it. Nothing goes to an external analytics service.

## What is recorded

One row for each **authenticated** API request, with:

- the time;
- the acting member id. Under "view as" this is the admin, not the member being viewed;
- how the request authenticated (`session`, `api_token` or `service`) and, for a token, its
  public `tok_…` id;
- the client and, for the CLI, its version:
  - `cli`: the User-Agent is `adminbot-cli/<version>`, which the CLI now sends;
  - `website`: a member session that is not the CLI. The Control UI sends its session as
    `Authorization: Bearer` with credentials omitted, so there is no cookie to go by;
  - `other`: an API token or the service token from anything but the CLI, such as curl or cron.

  The User-Agent counts as the CLI only when it is exactly `adminbot-cli/<version>`, at most 64
  characters. The version is kept as `major.minor.patch`, each part a number of at most three
  digits with no leading zero. Any prerelease or build suffix, up to 32 characters, is kept only
  as `-pre`, never its text. A User-Agent that does not fit is not the CLI: the request counts as
  `website` under a member session and `other` otherwise. This stops a caller from writing free
  text into the admin page, or growing the rollup with a new version on every request;

- the OpenAPI operationId (`unmatched` for a path outside the contract), the method and the
  status. A client that disconnected before the whole response was written is recorded as 499,
  even if the status line had already been sent;
- the duration in milliseconds;
- for service-token requests, counters the service kept while handling the request, such as
  `nudges_sent.<domain>`. A nudge counts when its ledger `nudge_count` goes up.

Each cron run reported by `scripts/lib/adminbot-cron-run.sh` now also sends its duration and
counters to the heartbeat. A job writes the counters as `name<TAB>count` lines to
`$ADMINBOT_RUN_METRICS_FILE` (`scripts/lib/adminbot-run-metrics.ts` does this). The email
automation sweep reports `emails.found`, `emails_status.completed`, `emails_status.failed`,
`emails_status.needs_review`, `emails_status.skipped` and `errors`. Counter names must match
`[a-z][a-z0-9_.:-]{0,63}`, values must be non-negative integers, and a run keeps at most 40.

## What is never recorded

- Token values, passwords, session ids or cookies.
- Request or response bodies, so no email bodies, paper text or form contents.
- Query strings or raw paths. A path like `/lab/members/{id}` names a person, so only the
  OpenAPI template's operationId is kept.
- IP addresses. The token row already keeps its last-used IP, as before.
- Unauthenticated requests.

## Retention

Request rows and the daily rollup are kept for 90 days (`adminBotApiUsageRetentionDays`). Older
rows are deleted at most once an hour during a normal write. The one exception is
`adminbot_api_usage_members`: one row per member and client holding only the first and last
request time. It is not pruned, so "first used the CLI" stays true after the request rows are gone.

Writes are buffered and flushed in one transaction every few seconds, so a crash can lose the last
few seconds of telemetry. A batch that fails to write is dropped with a warning in the gateway log
that gives the row count and the error, never the rows.

## Merging and deleting members

- Deleting a member purges their rows from the request log, the daily rollup and
  `adminbot_api_usage_members`.
- Merging a duplicate into a member moves the duplicate's usage onto the survivor:
  - in the daily rollup, cells that collide are summed (requests, errors, total time), with the
    larger max duration and the later last-request time;
  - in `adminbot_api_usage_members`, the earlier first time and the later last time are kept.
- Renaming a member id moves their usage rows to the new id.
- Before any of these, the write buffer is flushed, so rows recorded a moment earlier are purged,
  merged or renamed too instead of bringing the old id back.

## Who can see it

Only admins and the service token (`privilegedOnly`):

- `GET /usage/summary?days=N`: totals and breakdowns by day, member, operation, client and auth.
- `GET /usage/requests?member_id=&limit=`: recent request rows.
- `GET /usage/automation?days=N`: cron runs and service sweeps with their durations and counters.
  A sweep is a service-token request that is not a GET. The cron heartbeat is left out: it already
  appears as the run under `jobs`.
- `GET /usage/adoption?days=N`: CLI adoption and power users.
  - Token holders: members with at least one live token (not revoked, not expired), and how many
    of them have used the CLI.
  - Each holder or CLI user's first and last CLI use.
  - Distinct CLI users per week over the retained 90 days. Weeks start on Monday, UTC. The series
    starts at the first Monday inside the retained log, so the oldest week is never a partial week
    that looks like a dip.
  - Power users in the window, ranked by calls, then active days, then distinct operations. Each
    row has the CLI, website and other share of calls and the top three operations. Service-token
    calls are left out.
  - Dropped off: members who used the CLI before but not in the last 30 days.

A non-admin token, including a `power_user` pilot token, gets 403 on all four.

### Performance

The page makes three reads: summary, adoption and automation.

- Summary and adoption read the daily rollup through a covering index in their grouping order,
  so the scan needs no sort and no table read. They share one cached window of that scan: the
  member, operation and client cells, and one row per member and day.
- Each flush of the write buffer adds its rows to that window instead of throwing it away, so the
  page's own GETs, which are usage rows too, do not force a rescan between its reads. Any other
  write to the database (a heartbeat, a member edit, a prune) makes the next read scan again.
- Automation reads service rows through a partial index that holds every column it needs, so its
  scans never touch the request table. It reads only the heartbeats inside the window from the
  audit log, through an `(event_type, timestamp)` index.
- All totals and groupings are computed in SQLite, so nothing loads every row into JavaScript.

**Supported ceiling.** The page is built for up to 162,000 rollup cells in the 90-day window (40
active members each calling 45 operations every day), 50,000 service runs and an audit log of
200,000 events, 26,000 of them heartbeats. The run and heartbeat numbers match the cron manifest:
55 jobs run about 310 times a day, so 90 days hold about 28,000 runs. The cell count is well above
the lab's real use. At that size a cold load of the page's three authenticated GETs, sent together
as the Control UI sends them, takes about 250 to 400 ms on a laptop.

An earlier version of the test seeded 60 members x 60 operations (324,000 cells). Cold loads at
that size took 350 to 850 ms on a laptop and over 1 second on CI, which runs about twice as slow,
so the ceiling was lowered to a lab size the budget can promise on CI hardware.

`api/server.usage.test.ts` seeds this ceiling in a SQLite-backed server and times the real
`/usage/summary`, `/usage/adoption` and `/usage/automation` requests. Before each of five loads it
writes an unrelated audit event, as the live store does between visits, so every load scans cold.
It asserts that the fastest is under 1 second. One slow attempt on a busy CI machine does not fail
it; five in a row do. If the lab outgrows the ceiling, rerun that test at the new size before
raising it.

In the Control UI, **Lab overview → API Usage** shows these numbers for a 7-, 30- or 90-day
window, with CLI adoption, power users and drop-off above the request breakdowns. Members do not
see the tab.

## Known gaps

- Nudges sent after the response has closed, such as paced campaigns, are not counted.
- The email sweep reports counts by status only, not by email category.
