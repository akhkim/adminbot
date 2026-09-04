# PaperFlow stage nudges

The venue half of PaperFlow — reviews, the rebuttal window, the decision, camera ready, conference
travel — is the half nobody in the lab controls. An author cannot make reviews arrive; they can
only tell us when they did. This is the loop that asks, and the loop that stops asking.

## The loop

1. Once a paper's **Submission page** slot is filled, AdminBot starts asking the author holding the
   paper about the one stage it is waiting on.
2. The email says what it wants and names the bot mailbox: _forward the venue notification from an
   email address saved on your AdminBot profile_.
3. The forward lands in that mailbox. The hourly email pass verifies the member sender, classifies
   it, matches it to the paper, and records the evidence.
4. The stage is done. It is never nudged again, and the paper moves on to the next question.

Nothing else closes a stage from the author's side — no form, no checkbox. That is deliberate: the
mail already exists, the author is already reading it, and forwarding it from a known address is
the smallest authenticated handoff we can ask.

Do not only bcc AdminBot on the original venue-originated message. Its `From` address is the venue,
not the author, so the trusted-sender gate deliberately files it under `AdminBot/Needs Review`
instead of silently closing a stage. Forwarding the message from an address saved on the author's
profile makes the visible instruction and the security rule agree.

## Who gets the email

The **first full member in the author list**, walking the authors in order:

- `member` and `admin` privilege levels count. `trial` and `external_collaborator` do not — a
  trial member has not committed to the lab, and an external collaborator is not ours to chase.
- Alumni and external statuses are skipped even though the privilege level survives them leaving.
- Authors who resolve to nobody on the roster are skipped. AdminBot has no address for an outside
  coauthor and no standing to chase one.

Names are matched tolerantly, not by string equality: same first name, same last name, and the
shorter spelling's remaining parts appearing in order in the longer one. Author lists and roster
rows disagree about middle names as a rule — the roster says _Rahul Shrestha_, the papers say
_Rahul Babu Shrestha_ — and exact matching would route every one of those papers to nobody while
looking exactly like a paper with no lab member on it. Two people who merely share a surname do
not match, and a single-token name is never matched loosely.

So a paper whose first author is an external collaborator routes to whoever is next and is inside
the lab. The email says so, and tells them to forward it if somebody else is actually handling the
venue correspondence.

A paper with **no** full member on its author list is reported as unroutable rather than dropped —
in the preview, and in the cron job's output. Dropping it would make it look identical to a paper
with nothing outstanding, which is exactly the paper somebody needs to look at.

### The priority override

`ADMINBOT_PAPERFLOW_PRIORITY_MEMBER_ID` names a roster member who takes the venue cycle ahead of
author order whenever they are on the paper. It exists because one person currently holds the
venue cycle for the lab regardless of where they sit in any given author list. It is configuration
rather than a name in a conditional so that the day it stops being true, it is one env var to
unset.

## The stages

One at a time, in order. A paper waiting on reviews is never simultaneously asked whether the
decision came out — asking both in one mail is how an author learns the sender does not know where
their paper is.

| Stage          | PaperFlow node | Opens when                                 | Closed by                                                   |
| -------------- | -------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `reviews_out`  | `RV`           | The submission page is on file             | A forwarded review notification                             |
| `rebuttal`     | `RB`           | Reviews evidenced, no rebuttal doc on file | A forwarded rebuttal, or an author reply saying none is due |
| `decision`     | `DC`           | Rebuttal accounted for                     | A forwarded decision mail                                   |
| `camera_ready` | `CM`           | `venue_decision` is `accept`               | A forwarded camera-ready confirmation                       |
| `conference`   | `CA`           | `venue_decision` is `accept`               | A forwarded registration or booking confirmation            |

Recording a `venue_decision` closes the early stages too — an admin recording an accept has told us
the decision came out by a route at least as good as a bcc. A `reject` ends the cycle; the paper's
next move is a new venue, which re-opens the ladder when somebody records it. A dormant paper (24
months, no `dormant_override`) is left alone.

## Cadence

One question per stage per person, once a **week**. The author cannot make the answer arrive sooner
— the venue decides when reviews land — so a tighter cadence buys nothing and spends the one thing
that makes these mails work, which is that receiving one still means something.

The clock lives in `adminbot_nudge_ledger` under the `paperflow_stage` domain, shared with the
Slack slot sweep. That sharing is the point: it is what stops somebody being emailed about reviews
in the morning and Slacked about a poster in the afternoon.

## What runs

`scripts/adminbot-paperflow-nudge-cron.sh` — **weekly**, Mondays at 09:00, added in the Control
UI's Cron tab as a `command` job:

```
scripts/adminbot-paperflow-nudge-cron.sh
```

Weekly, matching the cadence it enforces. It ran every weekday on the theory that the ledger is
the real clock and a daily job only lets a stage that came due overnight go out that morning --
true, but it meant five chances a week for a scheduling bug to become five emails, and a paper
whose stage closed on Tuesday was asked the next question on Wednesday.

The email-handoff side needs no job of its own — `scripts/adminbot-email-cron.sh` handles it as it reads the
inbox.

### Environment

| Variable                                | Required | What it does                                                                                                                                                          |
| --------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMINBOT_BOT_EMAIL`                    | yes      | The mailbox the emails tell authors to forward evidence to. Without it the sweep returns 503 and sends nothing — a nudge without a destination is worse than silence. |
| `ADMINBOT_PAPERFLOW_PRIORITY_MEMBER_ID` | no       | Roster id of the member who takes the venue cycle ahead of author order.                                                                                              |
| `ADMINBOT_SERVICE_TOKEN`                | yes      | What the cron script authenticates with.                                                                                                                              |

## What this changed on the paper card

The Projects & Papers card is drawn to the chart's shape: the writing steps as a trunk, then
Branch 1–4 (Presentation, Social, Archival, Venue) in the chart's own numbering, so the card and
the diagram can be read side by side.

Two halves, deliberately distinguishable at a glance:

- **Fields somebody fills in.** The evidence slots. Four pairs that were two halves of one chart
  node now share a row — the two Overleaf links (`OV`), the submission page and its id (`SB`), the
  X and LinkedIn posts (`PS`), the poster and where it physically is (`PO`). 24 slots, 20 rows.
- **The venue ladder, which fills itself in.** Reviews → Rebuttal → Decision → Camera ready →
  Conference, rendered read-only with what closed each rung. There is no control on it, because
  there is nothing a person can do to make reviews arrive; the one action available is the forward,
  which is what the waiting rung asks for.

The `rebuttal_doc` slot is gone. It was a link somebody pasted, and the `rebuttal` stage now
covers it — keeping both would have given the card two accounts of the same fact, free to
disagree.

Above the checklist sits what the paper _is_, rather than what has been done to it, all three
editable by any author on the record:

| Field            | Record field      | Why it is there                                                                                                                                                              |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Author list      | `authors`         | Order decides who the venue-stage emails reach. Until now it could only be changed from the admin form.                                                                      |
| Feedback givers  | `feedback_givers` | Who was asked to read the draft. Not authors, and not the social consent rows — a question the card could not answer at all before.                                          |
| Aimed conference | `venue`           | Quoted in the stage emails and matched against the deadline board. Writes `venue`, not `artifacts.conference`: two places to record one answer is how they came to disagree. |

Both name lists are one comma-separated line rather than a chip editor, because what people
actually do with an author list is paste it.

## Routes

- `GET /papers/paperflow-stages` — the preview. Every paper with an open stage, who holds it, and
  whether it is due this pass. Computed by the same walk the send uses, so what an admin reads is
  what would actually go out.
- `POST /papers/paperflow-stages/run` — the send. Takes the service principal, because it accepts
  no message and no recipient list: both come from the author list and the stage registry, so there
  is no admin-composed content for the member-session gate to protect.
- `POST /papers/paperflow-evidence` — record that a stage closed. `{paper_id, stage, ...}`. Pass
  `recorded_by: "admin"` to close one by hand, which skips the classifier's confidence floor.

## Why a forwarded message can be trusted, and where it is not

Closing a stage stops a chase, and the failure mode is silent by construction — there is no message
that fails to arrive for anyone to notice. So three gates stand before anything is written:

1. **The sender is in the lab.** The From address has to match a roster member's email, calendar
   email or correspondence email, or be a configured privileged sender. Otherwise the mail is
   queued for review. This is why the user-facing instruction says to forward rather than merely
   bcc the original venue message.
2. **The model picks from a closed set.** It is shown only the papers that have an open stage right
   now, with the one stage each is waiting on, and may return only a pair from that list — plus
   "none of these", which is the correct answer for most mail.
3. **The pick is re-checked.** A constrained decode is a strong hint, not a guarantee, so the paper
   and the stage are both verified against the same list before the write, and a match below **75%**
   confidence is refused.

Anything failing a gate lands in the needs-review pile with a reason. That costs a human thirty
seconds and cannot lose a paper.

### Recovering an already received message

If an author followed the earlier BCC instruction, open **Pending Actions → Emails needing review**
in Control UI. The card explains why the message was held and offers only papers with a currently
open venue stage. Confirm the message, choose the matching paper, and press **Attach and stop
reminder**. That records the message id and closes the stage without weakening the trusted-sender
rule. The already filed email is not retried automatically because a needs-review outcome is
intentionally settled until a person decides it.

The underlying `POST /papers/paperflow-evidence` route remains available for operators and batch
recovery, but the normal recovery path no longer requires constructing that request by hand.

## Related

- [AdminBot](/tools/adminbot)
- `packages/nudge-engine/docs/paperflow.md` — the graph these stages mirror
