# Workshop nudges

Which of the lab's papers belong at which of a conference's workshops, sent to the people who could
submit them — once per conference, in the fortnight before that conference's workshops start
closing.

Matching itself is a language model reading each workshop's call for papers against each paper.
That was always the interesting part; the part that kept failing was the timing. An administrator
had to notice that EMNLP's workshops were about to close, open the tab, wait out a pass of tens of
minutes, tick recipients and press Send — for every conference in the season. This is that loop
without the noticing.

## The loop

1. A daily cron tick asks the service whether any conference is due.
2. A conference is **due** when its first still-open workshop deadline is fourteen days away or
   less, and the lab has never been told about that conference.
3. If one is, AdminBot matches every current paper against that conference's open calls and Slacks
   each author the workshops their papers fit.
4. The conference is written off in the nudge ledger. It is never announced again.

Most days nothing is due, and then the whole job is two dataset reads and a ledger query with no
model calls at all.

## Once, and only once

This is the constraint the whole design is built around, so it is worth being precise about what
guarantees it.

A cron job fires on a cadence. A window — "within two weeks" — is true on every one of the
fourteen days inside it. A sweep that only checked the window would therefore send the same
recommendations every morning for a fortnight. What prevents that is not the schedule but the
record: the `workshop_nudge` domain of the nudge ledger, keyed by parent conference.

Two kinds of row live there:

- **A per-member row** for each person who actually received a message. Written the moment that
  member's send succeeds, not in a batch at the end — a crash between the send and the stamp is
  exactly the case that produces a double text, so the window is kept as small as it can be.
- **A pass marker** (`member_id` of `__pass__`, which cannot collide with a real member id) saying
  the pass ran at all. Written when the pass finishes, whether or not anybody was messaged.

The marker is what separates "nobody has been told" from "the pass ran and matched nobody". Without
it, a conference whose pass found no eligible papers would look untouched and be re-run every night
until its deadline — tens of minutes of model time a day, for nothing.

The per-member rows are checked again immediately before each send. That only matters in one
situation: a pass that died after messaging some people but before its marker was written, then
retried. Those people are skipped and said so in the output rather than silently dropped.

Because all of this is a lookup rather than a schedule, the route is safe to call as often as you
like. Running it twice in a minute sends nothing the second time.

## Which conference, and when

"First workshop deadline" means the earliest deadline that is **still open** under that parent
conference, not the earliest that ever existed. A conference whose first two workshops have already
closed is still worth telling people about for its third.

Deadlines are AoE (UTC−12), so a deadline dated the 19th is open until the 20th at 11:59:59Z, and
the countdown is measured to that instant rather than to midnight on the printed date.

A conference discovered late — one whose first deadline is already four days out because the
deadline dataset only just picked it up — still qualifies. Late is worse than on time and much
better than never, and the alternative silently skips exactly the conferences whose calls appeared
at short notice.

## One conference per tick

A pass is thousands of model calls and tens of minutes. When several conferences are due at once,
the sweep takes the one nearest its deadline and names the rest as `deferred`; tomorrow's tick
takes the next. On a daily cron that costs a day and stays comfortably inside a fourteen-day
window, and it keeps a single cron invocation from running three passes back to back.

The sweep also stands down entirely when an administrator's own pass is already in flight. The
model time is real and the conference keeps.

## Who gets a message

The same people the manual Send would reach, and the message is composed by the same code — the lab
should not be able to tell from a message whether a person pressed the button.

Members with no Slack id on file are reported as skipped and **not** stamped in the ledger. They
have not been told, and recording them as told would permanently suppress the one message that
conference ever gets.

## Running it by hand

```bash
curl -X POST -H "Authorization: Bearer $ADMINBOT_SERVICE_TOKEN" \
  http://127.0.0.1:8765/workshop-nudges/run
```

The route takes the service token rather than an admin session, like the other cron-driven sweeps:
it accepts no recipient list and no message text. Which conference is due comes from the deadline
dataset, who hears about it comes from the matcher and the roster, and whether it has happened
before comes from the ledger — so there is no admin-composed content for a member-session gate to
protect.

The response says what happened:

```json
{
  "conference": { "key": "emnlp-2026", "label": "EMNLP", "first_deadline_aoe": "...", "days_until": 9 },
  "created": [{ "member_id": "...", "proposal_id": "...", "status": "..." }],
  "skipped": [{ "member_id": "...", "reason": "..." }],
  "deferred": ["neurips-2026"]
}
```

`conference: null` is the ordinary outcome on most days, with `reason` saying why.

## The manual tab still exists

**Workshop Matches** in the Control UI is unchanged: an administrator can still run a pass for any
conference and choose recipients by hand. It writes the same ledger, so a conference announced by
hand will not be announced again by the sweep.

## Files

- `extensions/adminbot/src/workflows/papers/workshop-schedule.ts` — which conference is due
- `extensions/adminbot/src/api/server.workshop-nudges.ts` — the pass, the sends, the ledger writes
- `scripts/adminbot-workshop-nudge-cron.sh` — the cron entry point
- `config/adminbot-cron.json` — `adminbot-workshop-nudges`, daily at 07:00
