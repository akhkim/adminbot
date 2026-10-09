# PeopleList and PaperList exports

Branch: `codex/adminbot-daily-sheet-export`. The snapshot generator and operator refresh script are synthetic-tested and installed in Ayush's Aurora home. A daily Aurora cron job runs at 00:00 UTC (05:30 IST), independently of the Mac.

The existing [Contact Spreadsheet](https://docs.google.com/spreadsheets/d/1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68/edit#gid=1516467851) now ends with `PeopleList` and `PaperList`. Both whole tabs are protected: the AdminBot account may update the exports, and the workbook owner retains Google's inherent editing rights. Other users may view/export these tabs but cannot edit their cells. Existing workbook sharing remains unchanged, including link access; protection is not a confidentiality boundary. The existing tabs and importer are unchanged. Neither export tab is an import source. The initially created separate workbook was moved to trash after the two native copies were verified in this workbook.

Verified database refresh on October 1, 2026 (September 30, 21:18:22 UTC): PeopleList contains all 189 database members and 131 columns. PaperList contains 187 database papers with 42 columns: review status, recorded missing/invalid artifacts, acceptance details, review-ready and project-start dates, stage, venue, recorded owner/deadline/action details, links, review checks, feedback givers, all recorded artifact statuses and authors. Both exports come directly from one read-only snapshot of `/w/406/adminbot/state/adminbot.sqlite`; neither depends on the Members tab. Missing fields remain blank. Activity counts come from recorded database rows, and paper associations use explicit member IDs. Embedded profile images that exceed Google's 50,000-character cell limit are replaced with an explicit omission marker; other oversized cells stop publication. Auth secrets are never selected or exported.

The first 19 PeopleList columns follow `PEOPLE_PRIORITY`, with the remainder retaining their order. Both tabs freeze exactly one row and one column. PeopleList's frozen ID column remains 200 pixels wide with wrapping. PaperList uses a native slate-blue table header, subtle alternating rows, Arial text and bold progress stages. Titles are 460 pixels wide, artifact summaries 320, authors 400 and other review columns 180 (IDs 160), with 36-pixel headers and 72-pixel data rows. IDs are muted and clipped; titles/authors wrap. Long author lists remain intact in their cells even when the overview row cannot display every line. Columns with no nonblank paper values are hidden on every refresh and automatically shown once populated; recorded zero/false values count as data. This layout is applied on each refresh. Protection and values remain intact.

Both exports are native Google Sheets tables named `PeopleList` and `PaperList`, with visible table-name bars, column menus, native Views controls and status/stage dropdown chips. Legacy basic filters and standalone banding were removed during conversion, without deleting data. Each daily refresh resizes the same table IDs and preserves table headers, rather than recreating tables. Text fields remain text; dropdown options reflect recorded nonempty values. The existing named `PeopleList sort and filter` / `PaperList sort and filter` views are preserved. PaperList also has table-backed `By stage` and `By venue` views visible in its native Views menu; range-backed versions are replaced once because Sheets does not convert their table association in place. Use a personal/temporary view for sorting protected data without changing the shared export.

PaperList begins with ID, title and PI review status, immediately followed by accepted year, accepted venue, acceptance notification date, review-ready date and explicit project start date; all remaining fields follow. Completely empty columns remain hidden. PaperList's default rows sort by recorded accepted year descending, acceptance notification date descending, review-ready timestamp ascending, then explicit project start date ascending. Unknown dates sort last at each level. The user restored this order after trying review-first grouping. Recorded acceptance years remain unverified as actual acceptance versus conference years; no source records were changed. `started_on` is never replaced with database creation time. Notification dates are currently absent from the database and remain blank; no actual acceptance date is inferred. No venue/year/decision is inferred from affiliation, titles or conference targets.

PI review readiness follows the existing PaperFlow gate: authors' acknowledgment and the arXiv Drive PDF must be provided/waived, with PI approval still unsettled. Its date comes from the acknowledgment evidence. Missing and invalid summaries describe **recorded slot statuses only**, not a claim that every unrecorded task is complete. Unknown statuses show `not recorded`; supplied/waived statuses remain distinct. Slot payloads, passwords and sharing credentials are never selected. The link columns cover drafts, Overleaf projects, PDFs, submission pages, arXiv, project folders, brainstorming documents, GitHub, slides, posters, talk videos, legacy rebuttal documents and recorded social drafts/posts. Supplied slot URLs take precedence over legacy artifact fields; invalid slots suppress their link fallback. Missing source URLs remain blank and their columns stay hidden. Link-slot URL reads are allowlisted and exclude sharing/credential slots. All exported links are HTTPS, exclude credential-bearing URLs, and use native clickable link formatting. Overleaf token-sharing URLs are omitted. The same daily job preserves these review columns, default row order, views and formatting.

Run `scripts/adminbot-sheet-export.py --full-people` on Aurora against the configured database for a full prepared snapshot. The generator performs no Google writes. The legacy `--people-export` option can reorder an existing export, and the default mode provides a small allowlist; neither is used by the daily job. `scripts/adminbot-sheet-refresh.py` is the separately authorized operator delivery entry point. It checks the exact Google writer, destination tab IDs and whole-tab protection before publishing. Never copy live rows to a personal machine.

Delivery uses one Sheets `spreadsheets.batchUpdate` request to clear old **values** and write both snapshots with literal `stringValue` cells atomically, preserving formatting and protection. Deleted rows cannot linger, and formula-looking text cannot execute. Empty datasets, duplicate IDs, unexpected headers and oversized cells are rejected before writing. Exact readback is compared with the database snapshot before recording a success timestamp. A rejected atomic update leaves the previous export intact; a readback failure records no new success timestamp.

The `# adminbot-protected-sheet-export` cron job runs as `nangia`, uses the authorized AdminBot Google identity, a nonblocking `flock`, and a 300-second timeout. Existing cron lines were preserved and the new line read back exactly once. Code, destination metadata, success metadata and count/error-only logs live under `/h/405/nangia/` with private permissions. Google credentials remain in the private on-host keyring; the job reads only Google account/keyring settings from the approved AdminBot environment file. It requires these existing permissions and Google's APIs to remain available. There is no spreadsheet-to-database path and no Mac runtime dependency.

Destination ID: `1ZqdaRzev6fFHxGbaAn_NDAPgv-Wi-hklHrT5jB68m68`. Sheet IDs: PeopleList `1516467851`, PaperList `451795742`. Both snapshots were compared against database values, whole-tab protection and one-row/one-column freezing were checked, and their position as the final two tabs was verified. Next scheduled run after installation: October 1, 2026, 00:00 UTC (05:30 IST). No sharing invitation emails were sent.

Regression check:

```sh
python3 scripts/adminbot-sheet-export-test.py
```

## Going attendees (October 3, 2026)

PaperList now appends column AQ, `going_attendees`. It lists the recorded `attending=yes`
people for each paper alphabetically, deduplicated by member/attendee identity. It does
not infer attendance from authors, acceptance, unknown answers or an absent row.
This column participates in the same daily atomic snapshot, formatting and readback
verification. The existing authors column remains unchanged. Deduplicate people across
papers when planning a conference, and confirm lodging requests and stay dates separately;
a Going name is not a confirmed Airbnb bed request.

The manual refresh on October 3 at 08:44:49 UTC succeeded with 220 people and 192 papers.
Native readback confirmed AQ and the recorded EMNLP/NeurIPS Going names. No member,
paper or attendance records were changed.

Going attendees is immediately after started_on (column I), and this order is regenerated by the daily export.

## People and paper review views (October 9, 2026)

PeopleList now defaults to oldest recorded join date/month first, with missing or invalid
dates last; database creation is never substituted for joining. Membership type remains
the recorded value. Native views offer joined-date sorting, membership type, Slack active
channel, and inactive-member review. The inactive view uses explicit inactive/alumni/removed
status or alumni membership; it never infers inactivity from login or message frequency.

`slack_active` means membership in `jinesis-active`, from the member's recorded channel
list: `Recorded yes`, `Recorded no`, or `Unknown` when channel evidence or Slack identity
is missing. This is not live presence and does not assert that stored channel evidence is
fresh. The export does not add or remove Slack members.

PaperList has a recorded `review_category` column and view for ARR/arXiv/camera-ready
feedback and the recorded venue (including NeurIPS when explicitly stored). Empty category
remains blank. The early draft/Overleaf project link remains clickable without requiring PI
readiness. These protected exports remain one-way; category or link changes are made in
AdminBot, not through export cells. No paper type, acceptance or approval is invented.

Join dates use YYYY-MM-DD, YYYY-MM or YYYY according to recorded precision. Clear English month formats are normalized. Ambiguous or implausible values remain blank in join_date, with their original value in join_date_basis for review; no live member records are changed.
