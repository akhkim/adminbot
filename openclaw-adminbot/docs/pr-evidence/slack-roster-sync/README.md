# Evidence: Slack roster sync

## Screenshots

No UI change. The feature is a scheduled job plus an admin-only API route
(`POST /members/slack-roster/sync`). Removal proposals appear in the existing proposal queue, which
is unchanged. There is nothing new to screenshot.

## Sample sync report (synthetic)

Produced by running `AdminBotService.syncSlackRoster` against an in-memory store. The Slack reader
was stubbed, so no real Slack call was made, and every person, email and Slack ID is invented.
Proposal IDs are replaced with `<id>`.

Fixture: a roster of five and a Slack workspace of nine accounts:

- `linked` is already linked by Slack ID, and their avatar is member-chosen;
- `by-email` is unlinked and has the same email as `UEMAIL`;
- `leaver` is linked to `ULEFT`, which is deactivated in Slack;
- `test-row` is named "Test User", with an `@example.com` email;
- `mem_synthetic_dnc` renamed themselves `Null,do not contact`. This is a member-sourced edit, and
  they are an external collaborator with nudges off;
- also in Slack: `UNEW` (a new full member), a single-channel guest, a bot and Slackbot.

What the first run shows:

- one new person is created at least privilege;
- one record is linked by email. Its empty timezone was filled; `linked`'s member-chosen avatar
  was left alone;
- the leaver is flagged (`slack_deactivated_at`), not deleted;
- the test row becomes one **pending** `lab_member.remove` proposal (T3, admin). Nothing is deleted;
- the `Null,do not contact` member is reported as `opted out; admin review`. It is not written to
  and not proposed for removal;
- guests and bots are not imported.

What the second run shows: nothing is applied and no new proposal is filed. The same pending
proposal is reported again, which shows the sync is idempotent.

```json
{
  "first_run": {
    "creates": [
      {
        "slack_user_id": "UNEW",
        "member": {
          "id": "new-person",
          "name": "New Person",
          "email": "unew@lab.test",
          "slack_user_id": "UNEW",
          "privilege_level": "external_collaborator",
          "avatar_url": "https://avatars.test/UNEW.png",
          "timezone": "America/Toronto",
          "notes": "Created from the Slack roster sync."
        }
      }
    ],
    "updates": [
      {
        "member_id": "by-email",
        "slack_user_id": "UEMAIL",
        "matched_by": "email",
        "changes": [
          {
            "field": "slack_user_id",
            "from": "",
            "to": "UEMAIL"
          },
          {
            "field": "avatar_url",
            "from": "",
            "to": "https://avatars.test/UEMAIL.png"
          },
          {
            "field": "timezone",
            "from": "",
            "to": "America/Toronto"
          }
        ]
      }
    ],
    "deactivations": [
      {
        "member_id": "leaver",
        "slack_user_id": "ULEFT"
      }
    ],
    "reactivations": [],
    "removals": [
      {
        "member_id": "test-row",
        "member_name": "Test User",
        "slack_user_id": "UTEST",
        "reason": "name \"Test User\" is a placeholder"
      }
    ],
    "opted_out": [
      {
        "member_id": "mem_synthetic_dnc",
        "member_name": "Null,do not contact",
        "slack_user_id": "UDNC",
        "reason": "roster name \"Null,do not contact\" asks not to be contacted",
        "action": "opted out; admin review"
      }
    ],
    "skipped": [
      {
        "slack_user_id": "UGUEST",
        "kind": "single_channel_guest"
      },
      {
        "slack_user_id": "UBOT",
        "kind": "bot"
      },
      {
        "slack_user_id": "USLACKBOT",
        "kind": "slackbot"
      }
    ],
    "conflicts": [],
    "unchanged": 1,
    "applied": {
      "created": 1,
      "updated": 1,
      "deactivated": 1,
      "reactivated": 0
    },
    "proposals": [
      {
        "member_id": "test-row",
        "proposal_id": "<id>",
        "status": "pending"
      }
    ],
    "failed": [],
    "slack_users": 9,
    "roster_size": 5,
    "dry_run": false,
    "synced_at": "2026-10-15T06:25:00.000Z"
  },
  "second_run": {
    "creates": [],
    "updates": [],
    "deactivations": [],
    "reactivations": [],
    "removals": [
      {
        "member_id": "test-row",
        "member_name": "Test User",
        "slack_user_id": "UTEST",
        "reason": "name \"Test User\" is a placeholder"
      }
    ],
    "opted_out": [
      {
        "member_id": "mem_synthetic_dnc",
        "member_name": "Null,do not contact",
        "slack_user_id": "UDNC",
        "reason": "roster name \"Null,do not contact\" asks not to be contacted",
        "action": "opted out; admin review"
      }
    ],
    "skipped": [
      {
        "slack_user_id": "UGUEST",
        "kind": "single_channel_guest"
      },
      {
        "slack_user_id": "UBOT",
        "kind": "bot"
      },
      {
        "slack_user_id": "USLACKBOT",
        "kind": "slackbot"
      }
    ],
    "conflicts": [],
    "unchanged": 4,
    "applied": {
      "created": 0,
      "updated": 0,
      "deactivated": 0,
      "reactivated": 0
    },
    "proposals": [
      {
        "member_id": "test-row",
        "proposal_id": "<id>",
        "status": "pending"
      }
    ],
    "failed": [],
    "slack_users": 9,
    "roster_size": 6,
    "dry_run": false,
    "synced_at": "2026-10-15T06:25:00.000Z"
  }
}
```

## Tests

All Slack traffic in the tests is mocked:

- `src/connectors/slack-users.test.ts` covers cursor paging, profile normalization, HTTP 429 and
  `ratelimited` Retry-After handling with a cap and a retry budget, and Slack and HTTP errors;
- `src/workflows/members/slack-roster-sync.test.ts` covers classification, matching, provenance,
  deactivation, placeholders, the exact `Null,do not contact` case and idempotency;
- `src/kernel/service.slack-roster-sync.test.ts` covers apply, the second run, rejection,
  approval executing the delete in-service, relink drift, dry run, the guards and the shared pass;
- `src/api/server.active-channels.test.ts` covers route auth, the 503 when no reader is wired,
  and that only an admin can use `force`.
