# Paper Submissions link backfill

The existing backfill tool can fill missing paper artifacts from columns E and F
of the **Paper submissions** tab. It matches normalized full titles only and skips
ambiguous titles in either source or database. It does not create papers, rename
papers, overwrite artifacts, fetch pasted URLs, grant sharing permissions or send
messages. Different paper titles still require a person to identify the right paper.

Use a Sheets API grid-data response for `Paper submissions!A1:F`, including
`formattedValue`, `hyperlink`, `textFormatRuns` and `chipRuns`. Keep the response on
the approved host; do not copy private rows or sharing tokens to a personal machine.
Google Doc smart chips and labelled hyperlinks lose their URLs in ordinary CSV
exports. `--csv <file> --paper-submissions` supports visible URL text only.

Run a dry run first on the host where the approved input and database are stored:

```sh
pnpm exec tsx scripts/adminbot-backfill-paper-links.ts \
  --sheet-json /approved/path/paper-submissions-grid.json \
  --database /approved/path/adminbot.sqlite
```

After separately approving the planned production changes, add `--write`. A
SQLite backup is created before updates, including committed WAL data. Updates
run in one transaction and fail if a paper changed after planning. Repeating the
same import fills no additional artifacts.

The importer accepts HTTPS links on recognized Overleaf hosts and `docs.google.com`.
It keeps Overleaf project, read-only and share-edit links in their separate fields;
Docs become brainstorming documents and Slides become presentation documents.
This validates URL shape only. It does not establish anonymous sharing access or
prove that a document is the intended paper.

This command is not scheduled automatically and does not enable production writes.
The production source retrieval and scheduling require separate operational setup.
