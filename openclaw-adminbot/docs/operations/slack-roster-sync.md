# Slack roster sync

The daily job that replaces the one-off Slack member export
(`scripts/adminbot-create-members-from-export.ts`). It reads the whole Slack workspace through
`users.list` and reconciles the lab roster against it through the normal member write path, so
field provenance, audits and the after-write hooks all run. Nothing is deleted automatically.

## Schedule and entry points

- Cron: `adminbot-slack-roster-sync` in `config/adminbot-cron.json`, daily at `25 6 * * *`
  (after the sheet roster sync at 06:10). It runs `scripts/adminbot-slack-roster-sync-cron.sh`,
  which posts to the service with `ADMINBOT_SERVICE_TOKEN`. Apply the schedule with
  `scripts/adminbot-cron-sync.sh`, as for every other job.
- Manual "sync now": `POST /members/slack-roster/sync`. It accepts an admin session or the service
  token, and refuses member sessions with 403. Body (optional): `{ "dry_run": true }` plans
  without writing. `{ "force": true }` overrides the size guard and requires an admin session.
- If the Slack reader is not wired, the route answers 503 instead of reporting an empty pass.

## Slack app scopes

The bot token in `SLACK_BOT_TOKEN` needs:

| Scope              | Why                                                            |
| ------------------ | -------------------------------------------------------------- |
| `users:read`       | `users.list`: IDs, names, deactivation, bot and guest flags, tz, avatars |
| `users:read.email` | `profile.email`, which is what an unlinked roster record matches on |

No write scope is used. The reader pages with `limit=200` and the cursor. It honours
`Retry-After` on HTTP 429, or on a 200 with `error: "ratelimited"`, retrying the same page up to
five times with a 120-second cap per wait. It throws instead of returning a partial workspace.

## What each kind of account does

Matching is by `slack_user_id` first, then by email. An email hit on a record that is already
linked to a different Slack account is never treated as a match.

| Slack account                      | On the roster                              | Not on the roster   |
| ---------------------------------- | ------------------------------------------ | ------------------- |
| Full member                        | Fields refreshed (below)                   | Created at `external_collaborator` |
| Single- / multi-channel guest      | Fields refreshed, noted in `skipped`       | Not imported        |
| Deactivated (`deleted: true`)      | `slack_deactivated_at` set; never deleted  | Not imported        |
| Bot, app user, Slackbot            | Left alone                                 | Not imported        |
| Test / placeholder                 | `lab_member.remove` proposal (T3, pending) | Not imported        |
| Do-not-contact                     | Left untouched, listed under `opted_out`   | Not imported        |

**Fields written.** Only `slack_user_id` (when empty), `avatar_url`, `timezone` (when empty;
the directory refresh owns the live zone) and `name` (only to repair a stand-in name like
"Test User"). A field whose provenance is `member` or `admin` is never overwritten. Writes are
stamped `import`.

**Test or placeholder detection is conservative.** It needs one of:

- the whole name (bracketed asides ignored) is `undefined`, `none`, `n/a`, `test`,
  `test user`, `test account`, `placeholder` or `dummy`;
- an RFC 2606 `@example.{com,org,net,edu}` email;
- the Slack user ID is listed in `ADMINBOT_SLACK_PLACEHOLDER_USER_IDS` (comma-separated).

Substrings never count, so "Tess Testa" is a real name.

**Do-not-contact is an opt-out, not a test row.** A name or title containing "do not contact" or
"DNC" (case-insensitive), or a bare "null", is a real person asking to be left alone. For
example, a member renamed their own record to `Null,do not contact`. The sync writes nothing to
such a record, so no after-write hook can invite, nudge or notify them. It never proposes the
record for removal. Instead it lists the record under `opted_out` with `action: "opted out;
admin review"`. The opt-out check runs before every placeholder rule.

## Removal proposals

A placeholder roster record is filed as `lab_member.remove` with:

- idempotency key `slack-roster-placeholder:<member_id>:<slack_user_id>`;
- policy `approvalPolicy("T3", ["admin"])`, so it is never auto-approved.

After an admin approves, the service runs the delete in-process through the same guarded path as
the Members tab. That path refuses self-delete, the head professor, and a member with a sign-in
credential, and it is never forced. The full record is kept in the `lab_member.deleted` audit row.

Execution fails without deleting if the record's Slack link changed after the proposal was filed.
A pending, executed or rejected proposal under the same key is never re-filed, so rejecting one
is final.

## Linking side effect

Linking `slack_user_id` on an existing member runs the existing after-write hook, which invites an
eligible member (full or coauthor-major) to the active channels. That is existing policy for any
link, not something new in this sync. Records created here start at `external_collaborator`,
which is not eligible.

## Guards and idempotency

- An empty Slack read is refused (422).
- A pass is refused, and reported with `refused`, when creations + deactivations + removals exceed
  max(10, 25% of the roster). An admin re-runs it with `force` after checking the read.
- Overlapping cron and manual runs share one pass.
- A second run against the same Slack data writes nothing and files nothing. A still-pending
  removal is reported again under its existing proposal id.
- Every pass records one `slack_roster_sync.completed` audit row with counts, `dry_run` and any
  refusal.

## Relationship to other jobs

- The sheet roster sync (`adminbot-roster-sync`) still owns roster membership and Member Type from
  the spreadsheet. This sync only adds the Slack-side view.
- The 4x-daily PeopleList/PaperList export (see `daily-sheet-export.md`) is unchanged and is not
  duplicated here.

Tests: `src/connectors/slack-users.test.ts`, `src/workflows/members/slack-roster-sync.test.ts`,
`src/kernel/service.slack-roster-sync.test.ts`, `src/api/server.active-channels.test.ts`. All
use mocked Slack responses and synthetic people.
