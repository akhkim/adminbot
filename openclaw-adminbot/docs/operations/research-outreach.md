# Research outreach (submissions and acceptances to newsletters, and the acceptance sheet)

A venue's papers have to be told several ways, at four moments: the record of what was submitted,
then on acceptance each institute newsletter, the department's publication record and the lab's
own lists, then the follow-ups at camera-ready, and the social-media managers before the meeting.
Beside those sits the lab's own acceptance sheet. AdminBot drafts all of them from the paper records and an admin sends, copies or
appends each one. Nothing here runs on a schedule and nothing leaves the lab without a press. The
one thing AdminBot says unprompted is a Slack note that a venue's drafts are ready (below), and
that note sends no outreach itself.

It lives on **Lab Overview > Mailing list**. Compose from a venue and press Preview: the digest
appears as before, and under it **Research outreach** lists one folded row per outlet.

## What it reads

The papers recorded as accepted at the chosen venue (the same rule as the venue digest: the
recorded decision, not where a paper is aimed), the roster, and the head professor on file
(`head_professor_member_id`). A paper with no decision recorded is not in any acceptance draft. If
the lab has heard back, the decision belongs on the paper first.

Venues are compared after normalising the free text, so one conference's papers appear together
however each was typed: `EMNLP`, `EMNLP ARR Commitment`, `Findings of EMNLP`, `EMNLP 2025 System
Demonstrations` and `EMNLP 2026 (demo)` are all EMNLP, with Findings and demos kept as tracks. The
year is read from the label, else from the paper's `accepted_year`, so the `EMNLP` the OpenReview
sync stores is EMNLP of that year, and a cell cut short to `LREC-COLING 202` is read with the
paper's year. A workshop is its own venue. Normalising only affects reading: stored venues are not
rewritten.

The submissions record is the one exception: it lists every paper sent to the venue, with where
each stands (under review, accepted, rejected, withdrawn). A paper aimed at the venue that has not
reached the submission step is left out, and the row says how many were.

## Which papers go to which outlet

Routing follows the authors:

| Audience       | A paper is included when                  |
| -------------- | ----------------------------------------- |
| `pi`           | the head professor is an author           |
| `senior`       | one of the configured `senior_authors` is |
| `pi_or_senior` | either of the above                       |
| `lab`          | any author is the lab's own (see below)   |

| Outlet key         | Stage              | Channel | Default audience | Draft                                                     |
| ------------------ | ------------------ | ------- | ---------------- | --------------------------------------------------------- |
| `mpi_submissions`  | After the deadline | Email   | `senior`         | Every paper submitted to the venue, with its status       |
| `mpi_record`       | On acceptance      | Email   | `senior`         | Numbered list: title, authors, link. Complete as drafted  |
| `mpi_minerva`      | On acceptance      | Email   | `pi_or_senior`   | Short summary per paper                                   |
| `vector`           | On acceptance      | Email   | `pi`             | Faculty-newsletter spotlight item                         |
| `dcs`              | On acceptance      | Email   | `pi`             | One congratulation line per paper                         |
| `sri`              | On acceptance      | Email   | `pi`             | Round-up line: title, venue, name, one-sentence summary   |
| `ellis`            | On acceptance      | Email   | `pi_or_senior`   | Achievement item                                          |
| `cls`              | On acceptance      | Form    | `pi_or_senior`   | Papers grouped by kind, pasted into the form              |
| `caif`             | On acceptance      | Email   | `lab`            | Multi-agent papers only                                   |
| `external_list`    | On acceptance      | Email   | `lab`            | Announcement for the lab's external mailing list          |
| `author_links`     | At camera-ready    | Email   | `lab`            | Asks authors of papers with no arXiv link to add it       |
| `featured_article` | At camera-ready    | Outline | `lab`            | Article outline for the first two papers; a person writes |
| `lab_blog`         | At camera-ready    | Outline | `lab`            | A blog-post skeleton per paper for the lab website        |
| `cifar_insights`   | At camera-ready    | Form    | `lab`            | A pitch for a non-technical post                          |
| `social_managers`  | Before the meeting | Email   | `lab`            | Post copy with links, for the institutes' social teams    |

For `lab`, "the lab's own" means the head professor, or a roster member whose **Member Type** is
full member or major coauthor. Being on the roster is not enough: minor coauthors, visiting
professors and alumni are left out. An author counts when the paper links them to that member, or,
for authors never linked, when the printed name matches the member's name exactly.

Papers by the head professor or a configured senior author (for example the MPI collaborator in
`senior_authors`) are the ones that reach the MPI outlets. The audience column above sets this.

The multi-agent filter is a match on the title, so the row says to review the selection. An
outlet's audience can be overridden in the configuration.

## Sent, or only copied

A row offers **Send** only when all of these hold: the outlet is an email outlet, recipients are
configured, at least one paper matches, every paper has a link, and the draft has nothing left for
a person to write. Form outlets link to their form. Outlines (the featured article, the blog posts)
are starting points for a writer: they are copied, never mailed.

Three outlets are addressed differently:

- `mpi_submissions` goes to its configured `to`, or, when none is configured, to the
  submission-report address in **Settings**.
- `author_links` goes to the authors themselves. The addresses are read from the roster (the
  address the lab writes to, else the sign-in address) for authors linked to the paper; the head
  professor is left out. A configured `to` is ignored, `cc` is honoured. An author who is not on
  the roster cannot be reached, and the row says so. The row also says whether the venue's
  camera-ready deadline has passed, when one is on file.
- `external_list` should be given one list or group address. Everything in `to` is visible to every
  recipient, so do not paste individual subscribers there.

Some outlets print one sentence beside each paper. Those sentences are typed once, in **One
sentence per paper** above the outlets: one box per accepted paper, saved on the paper when the
box is left, and reused by every draft that asks for one. Until a paper has its sentence, drafts
that need it carry the placeholder `[one-sentence summary]` and can only be copied, so a
placeholder is never mailed. A paper's link is its arXiv link, or its Drive PDF until that exists,
so an acceptance can go out before the camera-ready.

A send posts only the venue and the outlet key. The service recomposes the draft and takes the
recipients from its own configuration, so a tab left open cannot mail an old list and no request
can name an address. Each send is audited as `paper_outreach.sent` or `paper_outreach.failed`
with the venue, outlet, recipients and paper ids. Replies go to the digest's reply-to address.

This follows the admin-click rule in [AdminBot](/tools/adminbot): the route is admin-session-gated
and audited, and the admin's press on a draft already on screen is the approval.

## Configuration

Recipients are deployment configuration, never repository content.

```bash
ADMINBOT_OUTREACH_CONFIG={"senior_authors":["Senior Author Name"],"outlets":{"vector":{"to":["newsletter@example.org"],"cc":["editor@example.org"]},"cls":{"form_url":"https://example.org/form"}}}
```

- `senior_authors`: names matched against a paper's author list.
- `outlets.<key>.to` / `.cc`: addresses. An outlet with no `to` is copy-only.
- `outlets.<key>.form_url`: the form a form outlet is submitted through.
- `outlets.<key>.audience`: overrides the default routing for that outlet.

The value is all-or-nothing. If it does not parse, or names an unknown outlet, every send is
refused and the tab shows the reason; the drafts can still be read and copied. Unset, every outlet
is copy-only.

The contact list itself is kept in the lab's admin guidebook. Copy addresses from there into the
service environment; do not commit them.

## The acceptance sheet

The lab spreadsheet's `Peer-Reviewed PaperAcceptance` tab (header
`year | paper title | conference | authors | paper_link`) is written by the six-hourly
[sheet export](/operations/daily-sheet-export), like
PaperList and PeopleList: one row per accepted paper, newest year first, each conference's rows
together, rebuilt whole from the database every run and protected against hand edits. A paper appears
there by being recorded as accepted (or accepted on OpenReview); there is nothing to add by hand.

For that tab, leave `ADMINBOT_ACCEPTANCE_SHEET_URL` unset: the insert path below would write rows the
next export overwrites anyway. The insert path is for a tab people keep themselves.

### Inserting into a person-kept tab

With `ADMINBOT_ACCEPTANCE_SHEET_URL` pointing at a tab people keep, AdminBot only reads it and inserts
new rows; it never moves or rewrites one already there:

1. **Check the sheet** reads the tab and names the accepted papers it does not hold. A paper
   counts as present when its title, year and conference match a row, ignoring case and
   spacing (the conference compared after normalising, so `EMNLP ARR Commitment` in the tab is
   EMNLP), whatever has since been edited in the authors or link cells.
2. **Add N missing rows** puts each missing row where it belongs in a tab kept newest year first,
   with one conference's rows together within a year:
   - after the last row of the same year, conference and track, when the tab has one;
   - otherwise before the first row that sorts after it (newer years first, then conference, then
     main, Findings, demos, workshops);
   - otherwise after the last filled row. That is also where a row with no year goes, and rows a
     person left without a year are passed over.

   The tab is read again at write time, so a row somebody typed in between is not duplicated. All
   inserts go in one Sheets API `batchUpdate`, so either every row lands or none does.

New rows take the formatting of the row above them. The five columns above are written as plain
text, so a title beginning with `=` stays text. Columns to the right of them are the tab's own:

- **Per-row formulas** (for example a column that builds a CV entry from A:E) are copied into each
  new row from the neighbouring row, with relative references shifted onto the new row.
- **`ARRAYFORMULA` and `={...}` columns** are left alone. They extend themselves, and copying the
  formula that owns the array would break the whole column.
- **Typed values** in those columns are left blank for a person to fill.

The conference cell is written normalised, with the track kept (`Findings of EMNLP`,
`EMNLP System Demonstrations`), because a CV formula needs to say "Findings".

If the first row is not the expected header, nothing is written and the tab says so. Each write is
audited as `acceptance_sheet.rows_added`; a failed read or write as `acceptance_sheet.failed`.

```bash
ADMINBOT_ACCEPTANCE_SHEET_URL=https://docs.google.com/spreadsheets/d/<spreadsheet-id>/edit?gid=<tab-gid>
```

Paste the tab's URL from the address bar. The value belongs in the service environment, not the
repository. The gid is required: a spreadsheet id alone would mean
the first tab, which is the member roster. The service account needs edit access to the
spreadsheet. Unset, **Copy rows** still puts the rows on the clipboard, tab-separated, for pasting
by hand.

## Acceptance note on Slack

When the OpenReview sync records an acceptance that was not on
the paper before, AdminBot tells the admins that the outreach drafts for that venue are ready. The
note names the venue and lists every paper on file accepted there, not only the new ones, because
the draft it points at lists them all. It also links the Mailing list tab, where the venue is picked
from the list. It goes out once per venue: a later acceptance at the same venue does not repeat it.
An acceptance an author typed in by hand is not news to anyone and sends nothing.

The note is the typed action `slack.outreach_ready`: proposed, passed by its policy (T1, auto),
executed and audited as `outreach_ready.notified`. It goes to the channel in
`ADMINBOT_OUTREACH_READY_SLACK_CHANNEL` when that is set, and otherwise as a DM to the head
professor's Slack id on the roster. With neither, nothing is sent; the venue is audited as
`outreach_ready.skipped` with the reason and is left unmarked.

```bash
ADMINBOT_OUTREACH_READY_SLACK_CHANNEL=C0123456789   # optional; unset means a DM to the head professor
```

The note sends no outreach. Every draft still goes out only when an admin presses **Send** on the
tab. A note that failed to send is reported in the sync response and audited, but it is not
retried by the next sync, because the paper is no longer newly accepted then. Check the tab by hand
for that venue.

## API and CLI

| Route                                    | Does                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| `GET /papers/outreach?venue=`            | Drafts for a venue, the acceptance rows, any config error     |
| `POST /papers/outreach/send`             | `{venue, outlet}`: mails one sendable draft                   |
| `POST /papers/outreach/summary`          | `{paper_id, summary}`: saves one paper's sentence (max 400)   |
| `POST /papers/outreach/acceptance-sheet` | `{dry_run}`: compares; appends only when `dry_run` is `false` |

All four are admin-only and appear in the generated OpenAPI spec and CLI. `POST
/papers/openreview-sync/run` reports `newly_accepted` paper ids, and, when it was not a dry run,
`outreach_ready` with the venues it notified or skipped.

## Not built yet

- Moving a paper's link from its Drive PDF to arXiv in drafts already sent. A draft uses the
  arXiv link once the paper has one, and the Drive PDF until then. Nothing re-sends at
  camera-ready.
- Writing the one-sentence summaries, and the prose of the featured articles and blog posts.
  AdminBot outlines them; a person writes them.
- Publishing a blog post to the lab website. The skeleton is copied into the site's repository
  by hand.
