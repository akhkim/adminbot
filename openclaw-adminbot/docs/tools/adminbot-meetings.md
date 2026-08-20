# AdminBot Meeting Recordings (operator guide)

Collects the lab's recorded group meetings — the recording link, who attended, and a summary
written by the lab's own model — and shows them on the **Meeting Recordings** tab, under Lab
Sharing.

## Why it is shaped this way

The lab's Zoom is an educational account with **developer mode off**: no Marketplace app, no
OAuth, no API, and so nothing that Zapier or a Zoom app could hook into either. Everything below
is built on the two things Zoom gives up without an API — the mail it sends the host when a cloud
recording finishes, and the files a host can download from the web UI.

That splits the pipeline in half:

| Piece                     | How it arrives                                    | Human effort per meeting |
| ------------------------- | ------------------------------------------------- | ------------------------ |
| Recording link, topic, time | Forwarded Zoom notice, read by the hourly email pass | none, after one-time setup |
| Transcript → summary      | Host drops `.vtt` in a Drive folder                | one download + one drag  |
| Attendance                | Host drops the participant `.csv` in the same folder | one export + one drag  |

Attendance has no automatic path at all on this account. The transcript pre-ticks whoever *spoke*,
which is a real help and a bad record — it misses everyone who never unmuted — so an admin can
correct the roster on the tab, and a correction outranks every later import.

**No Zoom AI Companion is involved**, by choice: its summaries are generated in Zoom's cloud. The
summary here is written by the lab's own model over a loopback endpoint, and the transcript is
deleted as soon as it has been summarized. What is kept is the summary, the speaker names and the
attendance — never the transcript text.

## 1. One-time setup

**Forward the notices.** In the Zoom-hosting Google account, add a filter:

- Matches: `from:no-reply@zoom.us subject:("cloud recording")`
- Action: forward to `<ADMINBOT_BOT_EMAIL alias>+zoom@…`

Forward to the plus-alias, not the bare address. Gmail rewrites the sender on a forward, so
nothing downstream may key on it; the parser keys on the zoom.us recording URL in the body, and
the alias keeps recording mail identifiable in the inbox. Every host who records needs this filter
on their own account.

**Create the drop folder.** A Drive folder the bot account can read, shared with everyone who
hosts. Put its id in the AdminBot env file:

```
ADMINBOT_MEETING_DROP_FOLDER_ID=<drive folder id>
```

**Check two Zoom settings** are on for the account: cloud recording, and *audio transcript* for
cloud recordings. Without the second there is no `.vtt` and so no summary — the link and the
attendance still work.

**Add the cron job.** In the Control UI's Cron tab, a `command` job running hourly:

```
scripts/adminbot-meeting-cron.sh
```

The recording notices need no job of their own — `scripts/adminbot-email-cron.sh` files those as
it reads the inbox.

## 2. What a host does after a meeting

Nothing, for the link. For the summary and attendance, once per meeting:

1. Zoom → Recordings → the meeting → download the **Audio transcript** (`.vtt`).
2. Zoom → Reports → Usage → the meeting → export **Participants** (`.csv`).
3. Drop both in the Drive folder.

Keep Zoom's filenames if you can: the date in `GMT20260812-100000_…` is how a file is matched to a
meeting. A renamed file still matches if the name contains the date. On a day with two recorded
meetings the topic has to appear in the filename too, or the file is left unattached and reported
in the job summary rather than guessed at.

## 3. What runs

- `scripts/adminbot-email-cron.sh` — hourly. A recording notice is recognized deterministically
  and filed **before** the classifier model sees it; it never reaches the needs-review pile.
- `scripts/adminbot-meeting-cron.sh` — hourly. Lists the drop folder, matches each new file to a
  meeting, folds it in, summarizes a transcript on the local model, deletes the local copy. Files
  already folded in are skipped by Drive file id; unmatched ones are retried, because the meeting
  they belong to may not have been filed yet. Nothing in the Drive folder is moved or deleted.

Both print a JSON summary and exit non-zero on failure, so a bad pass shows red in the Cron tab.

## 4. Short recordings

A test call, a room check and a meeting somebody rejoined by accident all produce a cloud
recording and a notice. Anything shorter than **`meeting_minimum_minutes`** (default **10**) is
filed but not listed, so the tab stays a list of real meetings.

Three things to know about it:

- A meeting whose length nothing has reported yet is **always listed**. Zoom's notice states no
  duration, so length is unknown until a transcript or a participant CSV lands — and the hours in
  between are exactly when someone goes looking for the recording.
- Short meetings are still **stored**, not discarded. Lowering the floor brings them back; nothing
  was lost. The artifact pass also still sees them, so a transcript for a nine-minute meeting
  reaches its record.
- The floor is admin-editable at **Admin → Settings → Minimum meeting minutes**, or over the API
  as `meeting_minimum_minutes` on `PUT /settings`. Zero lists everything.

## 5. Recovering from a missing notice

If a host's filter was not set up, the meeting is simply absent. An admin can file it by hand from
the tab — **File a meeting by hand**, with the topic, start time and share link — and then drop the
transcript and CSV as usual.

## 6. Who sees what

The tab is member-level. A member sees the recording, the summary, their own attendance line and a
headcount. The roster itself is admin-only, and the service enforces that
(`listMeetingsForMember`), not the tab.

## Environment

| Variable                           | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `ADMINBOT_MEETING_DROP_FOLDER_ID`  | Drive folder hosts drop transcripts and participant CSVs into    |
| `ADMINBOT_BOT_EMAIL`               | Account Gmail and Drive are read as (already required)           |
| `ADMINBOT_LOCAL_BASE_URL`          | Loopback model endpoint for the summary; must be loopback        |
| `ADMINBOT_LOCAL_MODEL`             | Model id to summarize with                                       |
