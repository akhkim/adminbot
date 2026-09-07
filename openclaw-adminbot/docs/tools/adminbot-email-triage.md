# Email triage: what happens to a message after AdminBot reads it

`scripts/adminbot-email-cron.sh` runs hourly and reads the last hour of the bot mailbox. Every
message it touches ends up in exactly one of three states, and the state is written back to Gmail
as a label. Only one of the three leaves the inbox.

| Outcome      | Label                   | Stays in the inbox? | Means                                                                                                                                               |
| ------------ | ----------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| completed    | `AdminBot/Handled`      | no — archived       | Every effect landed. Nothing for a person to do.                                                                                                    |
| needs review | `AdminBot/Needs Review` | **yes**             | Understood, but deliberately not automated: an unrecognized email, an untrusted sender asking for a privileged action, a bcc that matched no paper. |
| failed       | `AdminBot/Error`        | **yes**             | Something broke mid-pass. The reason is in the run's JSON summary and in `adminbot_email_messages.last_error`.                                      |

So **the inbox is the to-do list**. What is left in it after a pass is exactly the work that still
needs a person, and each piece of it carries a label saying which kind it is.

Administrators also see the `AdminBot/Needs Review` queue in Control UI under **Pending Actions →
Emails needing review**. Each card names the sender, subject, classification, and the exact reason
automation stopped. For venue evidence, the administrator can attach the message to one of the
currently open PaperFlow stages; this records the Gmail message id on the stage and stops its
reminders. `Not paper evidence` settles the review without changing a paper. Both decisions are
audited.

The Control UI decision deliberately does not alter or archive the Gmail message. Gmail remains the
human-readable source record, with its original `AdminBot/Needs Review` label, while the database
records that an administrator resolved the item so it does not remain in AdminBot's queue.

The queue keeps the 20 most recent decisions under **Recently reviewed**. That history names the
administrator and decision time and, for PaperFlow evidence, the paper and stage the message closed.
It is an inspection surface rather than an undo button: reversing a stage close is a separate paper
decision, while the original Gmail thread remains linked from every history row.

## Calendar requests from the lab's own addresses

The configured senders — `ADMINBOT_ONBOARDING_SENDERS` plus `ADMINBOT_CONTACT_EMAILS` — are taken
at their word when they ask for a calendar event. The classifier's confidence threshold, which
holds everything else below 0.8 for a person, does not apply to that one pairing of category and
sender, and the classifier is now told outright whether the real `From` header is on the list
rather than being left to infer authority from the writing. A note from one of those addresses
saying "put this on the calendar" becomes an event on the lab calendar in the same pass, with no
review step.

That is a deliberate trade, and it is bounded on the only side that matters: **this pass can add to
a calendar and read one, and can never remove anything from one.** The rule is an allowlist of
verbs (`calendarCommandRefusal` in `scripts/adminbot-email-automation.ts`) applied at the single
point every shell-out goes through, so a delete, a clear, or an event-emptying update is refused
before it reaches the CLI — including one a wrongly-classified or spoofed-looking email asked for.
A wrong event is a line somebody deletes by hand; a wrong deletion is a meeting nobody knows they
have lost.

Everything else a trusted sender can ask for — reimbursement forms, a CV talk entry, an onboarding
decision — keeps the confidence threshold. Those write to forms, a CV, and people's accounts, where
a low-confidence read is worth a human's glance.

## Why labels rather than deleting

The pass used to trash a fully handled message. That got the shape right — a handled message is not
to-do — but it lost two things worth keeping:

- **The record.** A trashed message is gone in 30 days, along with the only human-readable evidence
  of what the automation actually did. `AdminBot/Handled` is a searchable archive of exactly that.
- **The distinction.** Failures and needs-review messages were left in the inbox with no marking at
  all, which made them indistinguishable from mail that had simply not been processed yet. The one
  category that most needed to stand out was the one that stood out least.

Nothing is deleted now. Archiving is reversible, a label is a fact, and neither loses a message
somebody may need to read.

## How it behaves

- **Labels are created once per run**, and only on a run that found mail — most hours are empty and
  do not need three API calls to learn that.
- **The other two labels always come off.** A message that failed last hour and was handled this
  hour carries `AdminBot/Handled` alone, not two contradictory labels.
- **Filing failures are recorded and swallowed.** A message that was genuinely handled is not
  reported as failed because a label could not be written — the label is a filing aid, not part of
  the work. The problem still shows up in the run's `errors` array.
- **Already-handled messages are skipped, not re-filed.** They carry their label from the pass that
  handled them.

## Reading the results

In Gmail:

```
label:AdminBot/Error            # what broke
label:AdminBot/Needs-Review     # what a person has to decide
in:inbox -label:AdminBot/Handled -label:AdminBot/Error -label:AdminBot/Needs-Review
                                # what the automation has not looked at yet
```

The cron run itself prints a JSON summary (`found`, `completed`, `failed`, `needs_review`,
`skipped`, `errors`) and exits non-zero when anything failed, so a bad pass shows red in the
Control UI's Cron tab rather than passing silently.

## Related

- [PaperFlow stage nudges](/tools/adminbot-paperflow-nudges) — the bcc loop this pass closes
- [AdminBot meetings](/tools/adminbot-meetings) — recording notices, filed before the classifier
