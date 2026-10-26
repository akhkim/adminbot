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

| Piece                       | How it arrives                                            | Human effort per meeting   |
| --------------------------- | --------------------------------------------------------- | -------------------------- |
| Recording link, topic, time | Forwarded Zoom notice, read by the hourly email pass      | none, after one-time setup |
| Transcript → summary        | Host drops `.vtt` in a Drive folder                       | one download + one drag    |
| Attendance                  | Host drops the participant `.csv` in the same folder      | one export + one drag      |
| Attendance (no CSV)         | Host drops the **gallery view** `.mp4` in the same folder | one download + one drag    |

There is no attendance API on this account. The participant CSV is the authoritative source. The
gallery-view recording is the next best: the local vision model reads the name labels off one frame
every 30 minutes, which catches the people who never unmuted. The transcript pre-ticks only whoever
_spoke_ — a real help and a bad record. An admin can correct the roster on the tab, and a
correction outranks every later import. Precedence, strongest first: admin correction, participant
report, gallery snapshot, transcript.

**No Zoom AI Companion is involved**, by choice: its summaries are generated in Zoom's cloud. The
summary here is written by the lab's own model over a loopback endpoint, and the transcript is
deleted as soon as it has been summarized. What is kept is the summary, the speaker names and the
attendance — never the transcript text.

## 1. One-time setup

**Forward the notices.** Zoom mails the recording notice to whoever hosted, and that mail is the
whole integration — so every host who records needs a rule on their own mailbox, pointed at
`<ADMINBOT_BOT_EMAIL alias>+zoom@…`.

Match on the **sender**, not the subject. Zoom's subject wording is not a contract and has already
moved: an account may send `Cloud Recording - <topic> is now available` or
`Meeting assets for <topic> are ready!`, and a rule keyed on "cloud recording" silently stops
forwarding the day the template changes. `from:no-reply@zoom.us` survives both.

In Gmail (Settings → Filters):

- Matches: `from:no-reply@zoom.us has:"zoom.us/rec/"`
- Action: forward to `<ADMINBOT_BOT_EMAIL alias>+zoom@…`

In Outlook / Microsoft 365 (Settings → Mail → Rules → Add new rule):

- Condition: **From** → `no-reply@zoom.us`
- Action: **Forward to** (or **Redirect to**) → `<ADMINBOT_BOT_EMAIL alias>+zoom@…`

Either action works: the parser keys on the zoom.us recording URL in the body precisely because a
forward rewrites the sender and may re-wrap the body as HTML with `>` quoting. Forward to the
plus-alias rather than the bare address — it keeps recording mail identifiable in the bot inbox.

One thing to check on a university tenant: Microsoft 365 blocks automatic external forwarding by
default through its outbound anti-spam policy, and when it does the rule fails silently. If notices
stop arriving with the rule visibly enabled, that is the first thing to rule out — it needs a
tenant exception from IT rather than a change here.

**Create the drop folder.** A Drive folder the bot account can read, shared with everyone who
hosts. Put its id in the AdminBot env file:

```
ADMINBOT_MEETING_DROP_FOLDER_ID=<drive folder id>
```

**Check two Zoom settings** are on for the account: cloud recording, and _audio transcript_ for
cloud recordings. Without the second there is no `.vtt` and so no summary — the link and the
attendance still work. For snapshot attendance, also turn on **Record gallery view** under cloud
recording settings; without it Zoom produces only the active-speaker file, which shows one person
at a time and is ignored.

**Stand up the vision model** (optional; needed only for gallery attendance). On Aurora, after
`setup-qwen35-vllm.sh` has run once:

```
deploy/aurora/setup-meeting-vision-vllm.sh
```

It installs `jinesis-meeting-vision.service`: a second vLLM serving `Qwen/Qwen3.5-27B` on GPU 6
(by UUID), bound to `127.0.0.1:8006`, reusing the main install's virtual environment and
`vllm.env` key. It also installs a pinned static `ffmpeg` (`imageio-ffmpeg`) and writes
`ADMINBOT_MEETING_VISION_BASE_URL`, `ADMINBOT_MEETING_VISION_MODEL` and `ADMINBOT_FFMPEG_BIN` into
the AdminBot env file. GPU 6 is shared with other jobs on Aurora: if another process holds it, the
script writes the unit but does not start it, and prints the command to run once the GPU is free.

**Add the cron job.** In the Control UI's Cron tab, a `command` job running hourly:

```
scripts/adminbot-meeting-cron.sh
```

The recording notices need no job of their own — `scripts/adminbot-email-cron.sh` files those as
it reads the inbox.

## 2. What a host does after a meeting

Nothing, for the link. For the summary and attendance, once per meeting:

1. Zoom → Recordings → the meeting → download the **Audio transcript** (`.vtt`).
2. Zoom → Reports → Usage → the meeting → export **Participants** (`.csv`) — or, if that is a
   bother, download the **Gallery view** recording (`…_Recording_gallery_….mp4`) instead.
3. Drop them in the Drive folder.

Keep Zoom's filenames if you can: the date in `GMT20260812-100000_…` is how a file is matched to a
meeting. A renamed file still matches if the name contains the date. On a day with two recorded
meetings the topic has to appear in the filename too, or the file is left unattached and reported
in the job summary rather than guessed at.

## 3. What runs

- `scripts/adminbot-email-cron.sh` — hourly. A recording notice is recognized deterministically
  and filed **before** the classifier model sees it; it never reaches the needs-review pile.
- `scripts/adminbot-meeting-cron.sh` — hourly. Lists the drop folder, matches each new file to a
  meeting, folds it in, summarizes a transcript on the local model, samples a gallery recording
  for attendance, deletes the local copy. Files already folded in are skipped by Drive file id;
  unmatched ones are retried, because the meeting they belong to may not have been filed yet.
  Nothing in the Drive folder is moved or deleted.

Both print a JSON summary and exit non-zero on failure, so a bad pass shows red in the Cron tab.

## 3a. Attendance from the gallery recording

A dropped `.mp4` is sampled only when its name says it is the gallery layout (`gallery` or `gvo`,
as Zoom names it). Active-speaker and shared-screen-with-speaker files are left alone.

1. The pass downloads the recording into its scratch directory and reads its length with `ffmpeg`.
2. It takes one frame at **0:30, 1:00, 1:30 …** (`ADMINBOT_MEETING_SNAPSHOT_MINUTES`, default 30),
   up to 16 frames. A recording shorter than one interval gets one frame at its midpoint.
3. Each frame goes, as a JPEG data URL, to the vision model on GPU 6 — **only** that loopback
   server, never the shared LLM gateway or a hosted API. The model returns the frame's layout and
   the tile labels, under a strict JSON schema with thinking off.
4. Names from frames that show participant tiles (a gallery grid, or a shared screen with a tile
   strip) are unioned, matched to the roster by name (Zoom's `(he/him)` and `(Host)` suffixes are
   tolerated), and filed as `video_snapshot` attendance. Unmatched labels are kept as guests.
5. The video and every frame are deleted; the record keeps only the names and a `snapshots` stamp
   (offsets sampled, how many showed tiles, which model). The roster editor shows that stamp, so
   "0 of 3 frames showed participant tiles" tells an admin the file was not really gallery view.

All frames are read before anything is written, so a model failure halfway files nothing and the
whole recording is retried next hour. Until `ADMINBOT_MEETING_VISION_BASE_URL` is set, gallery
recordings stay in the folder and are listed under `deferred` in the job summary.

## 4. Short recordings

A test call, a room check and a meeting somebody rejoined by accident all produce a cloud
recording and a notice. Only recordings **longer than** **`meeting_minimum_minutes`** (default
**10**) are listed — strictly, to the second, so a 10:00 recording is hidden and a 10:01 one is
shown. Shorter ones are filed but not listed, so the tab stays a list of real meetings.

A recording's length comes from the first of these that knows it: a hand-filed or participant-report
meeting length, the recording length the Zoom notice states (the "Meeting assets" template gives it
to the second), then the span of the transcript. The series counts on the tab use the same rule.

Three things to know about it:

- A meeting whose length nothing has reported is **always listed**. The older "is now available"
  notice template states no duration, and a meeting filed by hand has no length field, so hiding
  unknowns would hide real meetings. Such a meeting is hidden once a transcript or participant CSV
  shows it was short.
- Short meetings are still **stored**, not discarded. Lowering the floor brings them back; nothing
  was lost. The artifact pass also still sees them, so a transcript for a nine-minute meeting
  reaches its record.
- The floor is admin-editable at **Admin → Settings → List recordings longer than (minutes)**, or
  over the API as `meeting_minimum_minutes` on `PUT /settings`. Zero lists everything.

## 5. Recovering from a missing notice

If a host's filter was not set up, the meeting is simply absent. An admin can file it by hand from
the tab — **File a meeting by hand**, with the topic, start time and share link — and then drop the
transcript and CSV as usual.

## 5a. Backfilling attendance from the Zoom dashboard

For meetings that never got a participant CSV — from before the drop folder, or ones nobody
exported — the host can download a month at a time from the Zoom web portal (**Reports → Usage**,
or **Dashboard → Meetings → Past**, exported _with meeting details_). That file,
`meetinglistdetails_<from>_<to>.csv`, holds one row per participant session for every meeting in
the range, so it is a different shape from the per-meeting report the drop folder takes; don't drop
it there. Import it on the deploy host instead:

```bash
cd /w/406/adminbot/current
node --import tsx scripts/adminbot-meeting-attendance-import.ts \
  meetinglistdetails_*.csv --topic "Weekly Jinesis Meeting" --min-participants 15 \
  [--aliases aliases.json] [--apply]
```

- **Which meetings:** those with _more than_ `--min-participants` distinct people (rejoins
  counted once). Every stray opening of the meeting room is its own meeting in the export, and this
  is what leaves those out. `--topic` limits it to one series.
- **Where it lands:** on the record a recording notice already filed, matched by series and
  recording length, since a notice whose date line did not parse is filed at the time its mail
  arrived. Otherwise it files a new record under `zoom-<meeting id>-<date>`, the id a recording
  notice for the same meeting would produce. The new record has source `participant_report` and
  needs no recording link, because Zoom's report alone proves the meeting happened. Either way the
  record's start time and length are set from the report.
- **Who:** attendance is written as `participant_report`, so a line an admin ticked by hand still
  outranks it. Notetaker bots are dropped. A display name that matches no member by email or name
  ("Andrew K", a first name alone) stays a guest unless `--aliases` maps it: a JSON object of
  display name → member id, or `null` to drop the name (a room's account). The dry run lists every
  unmatched name with the members it could be, so the alias file can be written from it. Keep the
  alias file with the exports, outside the repo; it names lab members.
- **Dry run first:** nothing is written without `--apply`, and re-running with `--apply` changes
  nothing further. Review the unmatched names before applying: every meeting that gets a roster
  counts toward the Monday "missed two meetings" reminder, and a member left as an unmatched guest
  is counted absent.

## 6. Who sees what

The tab groups recordings by meeting: one dropdown per title (case and spacing ignored, so
"Weekly Lab Meeting" and "weekly lab meeting " are one series). The lab's weekly meeting
(`ADMINBOT_GROUP_MEETING_TOPIC`, default "Weekly Jinesis Meeting") is always listed first; the
rest follow newest series first. Each dropdown shows how many recordings it holds and when it last
met. Opening a dropdown lists every recording of that meeting, newest first, ten at a time. The
first series opens on arrival with its newest recording unfolded. Behind it: `GET /meetings/series` is the index (titles and counts only, the same for
every viewer), and `GET /meetings?series=<key>` pages one series with the usual per-viewer
redaction. A title is the only grouping key, so a meeting renamed in Zoom starts a new dropdown.

The tab is member-level. A member sees the recording, the summary, their own attendance line and a
headcount. The roster itself is admin-only: an admin sees the members recorded as present, each
with a **Remove** button, and adds anyone missing by searching the member list and pressing
**Add**. Both write a manual correction, which no later import overrides. The service, not the
tab, keeps the roster from members (`listMeetingsForMember`).

## Environment

| Variable                            | Purpose                                                           |
| ----------------------------------- | ----------------------------------------------------------------- |
| `ADMINBOT_MEETING_DROP_FOLDER_ID`   | Drive folder hosts drop transcripts and participant CSVs into     |
| `ADMINBOT_BOT_EMAIL`                | Account Gmail and Drive are read as (already required)            |
| `ADMINBOT_LOCAL_BASE_URL`           | Loopback model endpoint for the summary; must be loopback         |
| `ADMINBOT_LOCAL_MODEL`              | Model id to summarize with                                        |
| `ADMINBOT_MEETING_VISION_BASE_URL`  | Loopback vision server for gallery snapshots; unset = deferred    |
| `ADMINBOT_MEETING_VISION_MODEL`     | Vision model id (required when the base URL is set)               |
| `ADMINBOT_MEETING_VISION_API_KEY`   | Optional; defaults to `VLLM_API_KEY`                              |
| `ADMINBOT_MEETING_SNAPSHOT_MINUTES` | Minutes between sampled frames (default 30)                       |
| `ADMINBOT_FFMPEG_BIN`               | `ffmpeg` used to read the recording (default: `ffmpeg` on PATH)   |
| `ADMINBOT_GROUP_MEETING_TOPIC`      | Series listed first on the tab (default "Weekly Jinesis Meeting") |
