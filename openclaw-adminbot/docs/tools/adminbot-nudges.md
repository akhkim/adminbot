# Nudge campaigns

A nudge campaign is one Slack DM to each member a rule picks. Before this module every such nudge
wrote its own recipient filter, its own "already asked?" check and its own audit, and some skipped
the dry run. `extensions/adminbot/src/workflows/nudges/campaign.ts` writes those rails once. A
campaign supplies only who it is about and what each person gets.

## What the module does, in order

1. **Filter.** Alumni are never candidates. The campaign's own rule (`decide(member)`) runs next,
   then the rules every nudge shares:
   - never the head professor (`head_professor`);
   - never someone off the nudge list, since `receives_nudges` must be `true` (`nudges_off`);
   - never someone Slack cannot reach (`no_slack_id`). A campaign can opt out of this one with
     `requireSlack: false` to keep the older behaviour, where such a member still gets the portal
     notification;
   - never someone the ledger says was asked inside the cooldown (`already_sent`).

   Every skip is counted by reason.

2. **Dry run.** This is the default: a body without `dry_run: false` is a preview. It returns
   `count`, `skipped` (reason → number) and up to three `samples` (`member_id`, `name`, the
   rendered `message`), and sends nothing.
3. **Confirm guard.** A real send needs `{ dry_run: false, confirm: N }`, where `N` is the count the
   admin saw. If the roster moved in between, the route answers **409** with the current count
   rather than messaging a different set of people. With no `confirm` it also answers 409.
4. **Send.** One member at a time, 1.1 s apart, to stay under Slack's DM rate limit. Each send goes
   through `sendMemberNudge`, so it is a proposal, an executed `openclaw message send` and a portal
   notification, exactly like every other nudge. A failure is collected in `failed` and does not
   stop the run.
5. **Ledger and audit**, per delivered member:
   - a row in `adminbot_nudge_ledger` with `domain` and `subject_id` both set to the campaign key;
   - a `nudge_campaign.sent` audit row (`{ campaign, member_id }`), next to the usual
     `member_nudge.sent`.

   Nothing is stamped for a member who was not delivered to, so a retry picks them up.

**Scheduled runs** (a cron with the service token) bypass the confirm guard and nothing else. They
still filter, pace, stamp and audit.

### Cooldown

`cooldown_days` on the campaign reads the ledger:

| Value  | Meaning                                                          |
| ------ | ---------------------------------------------------------------- |
| `null` | Once per member, ever.                                           |
| `0`    | No cooldown: every run asks again (the profile photo behaviour). |
| `N`    | Not again within `N` days of the last send.                      |

The ledger table already existed for the paper and milestone nudges, so campaigns need no new table
or migration. `profile_photo` was added to `adminBotNudgeDomains`. The
Postgres migration script copies the table as it is.

## Campaigns

`GET /nudges/campaigns` (admin or service token) lists each campaign with `members_reached` and
`last_sent_at`, read from the ledger. The admin dashboard shows this listing.

| Campaign                 | Key             | Route                            | Cooldown | Runs              |
| ------------------------ | --------------- | -------------------------------- | -------- | ----------------- |
| Profile photo guidelines | `profile_photo` | `POST /profile-photo/review/run` | none     | manual, confirmed |

There is no location nudge. AdminBot never asks members where they are; the member map is filled
from automatic sources only.

### The preview/confirm element

`<adminbot-nudge-campaign route="..." label="...">` (`ui/src/ui/adminbot/views/nudge-campaign.ts`)
is the admin button for any campaign route. It previews first, showing the count, skips and
samples, and sends only on a second press of **Send to N**, which posts `confirm: N`. No campaign
mounts it yet; the attendance and paper-slot migrations below are its first users.

### Profile photo guidelines

`POST /profile-photo/review/run` reviews photos, then runs this campaign. Like every other
campaign it takes `{dry_run, confirm}`: a body-less POST is a preview (`dry_run` defaults to true)
and nothing is sent until a second POST carries `dry_run: false` and `confirm` equal to the
previewed `count`; a mismatch is a 409. The info has `scheduled: false`, and no cron calls the
route. The review itself still runs, and saves each assessment, on a preview. Otherwise:

- every non-compliant member is messaged on every confirmed run (no cooldown);
- members without a Slack ID still get the portal notification;
- the guideline text gets the portal link appended;
- the response still reports `nudges_created` and `nudges_skipped`.

Three things differ:

- each send gets its own `member_nudge.sent` audit row, instead of one row per batch;
- sends are 1.1 s apart;
- each delivered member gets a ledger row, so the listing can show who was reached.

## Adding a campaign

1. Write `workflows/nudges/<name>.ts`. Export an `AdminBotNudgeCampaignInfo` constant and a
   function that returns an `AdminBotNudgeCampaign` with `decide(member)`.
2. Add its key to `adminBotNudgeDomains` and its info to `ADMINBOT_NUDGE_CAMPAIGNS`.
3. Add a service method that calls `runNudgeCampaign`, and a route that reads the mode with
   `campaignModeFromBody`. The route is `adminSessionOnly` unless a cron runs it.
4. In the UI, mount `<adminbot-nudge-campaign route="..." label="...">`.

## Not migrated yet (follow-ups)

These nudges still use their own filtering. They were left alone because each has scheduling or
escalation behaviour that a straight port could change:

- meeting attendance, paper evidence slots, weekly paper updates, profile fields and term timeline,
  pre-registration, the onboarding ladder, never-signed-in, and the thesis and graduation nudges;
- **photo review with no reviewer.** With no reviewer configured, the deterministic fallback can
  mark every member non-compliant. The preview now shows that count before anything is sent, but a
  confirmed run would still DM all of them; a cooldown or a "reviewer unavailable" refusal would
  close this;
- `profile_photo_review.last_guideline_dm_at` is written but never read. The campaign ledger now
  holds the same fact.
