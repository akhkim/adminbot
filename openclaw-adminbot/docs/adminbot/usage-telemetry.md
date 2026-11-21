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
- the client (`cli`, `website` or `other`) and, for the CLI, its version. The CLI now sends
  `User-Agent: adminbot-cli/<version>`, and the version is kept only when it parses as semver;
- the OpenAPI operationId (`unmatched` for a path outside the contract), the method and the
  status (499 when the client hung up first);
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
request time. It is not pruned, so "first used the CLI" stays true after the request rows are gone. Writes are buffered and flushed in
one transaction every few seconds, so a crash can lose the last few seconds of telemetry.

## Who can see it

Only admins and the service token (`privilegedOnly`):

- `GET /usage/summary?days=N`: totals and breakdowns by day, member, operation, client and auth.
- `GET /usage/requests?member_id=&limit=`: recent request rows.
- `GET /usage/automation?days=N`: cron runs and service sweeps with their durations and counters.
- `GET /usage/adoption?days=N`: CLI adoption and power users.
  - Token holders: members with at least one live token (not revoked, not expired), and how many
    of them have used the CLI.
  - Each holder or CLI user's first and last CLI use.
  - Distinct CLI users per week over the retained 90 days. Weeks start on Monday, UTC.
  - Power users in the window, ranked by calls, then active days, then distinct operations. Each
    row has the CLI, website and other share of calls and the top three operations. Service-token
    calls are left out.
  - Dropped off: members who used the CLI before but not in the last 30 days.

In the Control UI, **Lab overview → API Usage** shows these numbers for a 7-, 30- or 90-day
window, with CLI adoption, power users and drop-off above the request breakdowns. Members do not
see the tab.

## Known gaps

- Nudges sent after the response has closed, such as paced campaigns, are not counted.
- The email sweep reports counts by status only, not by email category.
