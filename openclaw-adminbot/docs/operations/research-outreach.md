# Research outreach (acceptances to newsletters, and the acceptance sheet)

When a venue's decisions are in, the same acceptances have to be told several ways: each institute
newsletter, the department's publication record, the social-media managers, and the lab's own
acceptance sheet. AdminBot drafts all of them from the paper records and an admin sends, copies or
appends each one. Nothing here runs on a schedule and nothing leaves the lab without a press.

It lives on **Lab Overview > Mailing list**. Compose from a venue and press Preview: the digest
appears as before, and under it **Research outreach** lists one folded row per outlet.

## What it reads

The papers recorded as accepted at the chosen venue (the same rule as the venue digest: the
recorded decision, not where a paper is aimed), the roster, and the head professor on file
(`head_professor_member_id`). A paper with no decision recorded is not in any draft. If the lab has
heard back, the decision belongs on the paper first.

## Which papers go to which outlet

Routing follows the authors:

| Audience       | A paper is included when                  |
| -------------- | ----------------------------------------- |
| `pi`           | the head professor is an author           |
| `senior`       | one of the configured `senior_authors` is |
| `pi_or_senior` | either of the above                       |
| `lab`          | any author is a lab member on the roster  |

| Outlet key        | Stage              | Channel | Default audience | Draft                                                    |
| ----------------- | ------------------ | ------- | ---------------- | -------------------------------------------------------- |
| `mpi_record`      | On acceptance      | Email   | `senior`         | Numbered list: title, authors, link. Complete as drafted |
| `mpi_minerva`     | On acceptance      | Email   | `pi_or_senior`   | Short summary per paper                                  |
| `vector`          | On acceptance      | Email   | `pi`             | Faculty-newsletter spotlight item                        |
| `dcs`             | On acceptance      | Email   | `pi`             | One congratulation line per paper                        |
| `sri`             | On acceptance      | Email   | `pi`             | Round-up line: title, venue, name, one-sentence summary  |
| `ellis`           | On acceptance      | Email   | `pi_or_senior`   | Achievement item                                         |
| `cls`             | On acceptance      | Form    | `pi_or_senior`   | Papers grouped by kind, pasted into the form             |
| `caif`            | On acceptance      | Email   | `lab`            | Multi-agent papers only                                  |
| `cifar_insights`  | At camera-ready    | Form    | `lab`            | A pitch for a non-technical post                         |
| `social_managers` | Before the meeting | Email   | `lab`            | Post copy with links, for the institutes' social teams   |

The multi-agent filter is a match on the title, so the row says to review the selection. An
outlet's audience can be overridden in the configuration.

## Sent, or only copied

A row offers **Send** only when all of these hold: the outlet is an email outlet, recipients are
configured, at least one paper matches, every paper has a link, and the draft has nothing left for
a person to write. Form outlets link to their form.

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

The lab spreadsheet has an acceptance tab with the header
`year | paper title | conference | authors | paper_link`. Unlike the PaperList and PeopleList tabs,
which the [daily export](/operations/daily-sheet-export) rewrites whole, people keep this one. So
AdminBot only reads it and appends:

1. **Check the sheet** reads the tab and names the accepted papers it does not hold. A paper
   counts as present when its title, year and conference match a row, ignoring case and
   spacing, whatever has since been edited in the authors or link cells.
2. **Add N missing rows** appends exactly those rows after the last one. The tab is read again at
   write time, so a row somebody typed in between is not duplicated.

If the first row is not the expected header, nothing is written and the tab says so. Each write is
audited as `acceptance_sheet.rows_added`; a failed read or write as `acceptance_sheet.failed`.

```bash
ADMINBOT_ACCEPTANCE_SHEET_URL=https://docs.google.com/spreadsheets/d/<spreadsheet-id>/edit?gid=<tab-gid>
```

Paste the tab's URL from the address bar. The gid is required: a spreadsheet id alone would mean
the first tab, which is the member roster. The service account needs edit access to the
spreadsheet. Unset, **Copy rows** still puts the rows on the clipboard, tab-separated, for pasting
by hand.

## API and CLI

| Route                                    | Does                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| `GET /papers/outreach?venue=`            | Drafts for a venue, the acceptance rows, any config error     |
| `POST /papers/outreach/send`             | `{venue, outlet}`: mails one sendable draft                   |
| `POST /papers/outreach/summary`          | `{paper_id, summary}`: saves one paper's sentence (max 400)   |
| `POST /papers/outreach/acceptance-sheet` | `{dry_run}`: compares; appends only when `dry_run` is `false` |

All four are admin-only and appear in the generated OpenAPI spec and CLI.

## Not built yet

- Detecting acceptances on OpenReview. Today the decision is recorded on the paper by a person.
- Writing the one-sentence summaries and the featured articles for the top one or two papers.
- A separate notice on submission (the department record of submissions).
