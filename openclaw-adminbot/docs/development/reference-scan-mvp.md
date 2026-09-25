# OpenReview reference scan MVP

The TypeScript AdminBot service can propose a GPTZero bibliography scan of one **public**
OpenReview submission. It stores scan state in `adminbot_reference_scans` inside the service's
existing SQLite database. No separate database, Python process, gateway agent, or new scheduler
is required. The existing Pending Actions UI handles approval and execution.

## Setup and first run

### Ad hoc PDF uploads

Run `./dev.sh` from the outer repository directory with your personal OpenClaw gateway running.
Open the printed Frontend URL and click Alice in the local account picker. See `dev/README.md`
for gateway setup. The default CheckIfExist checker needs no API key. The checker selector also offers GPTZero, which requires GPTZERO_API_KEY and bibliography API access.

Admins can open **General Tools → PDF Reference Checker**, drop or choose one PDF, and click
**Submit**. With CheckIfExist selected, the backend extracts its bibliography locally using PDFium and checks the citations
with the MIT-licensed [CheckIfExist](https://github.com/zabbonat/References-Validation)
engine. Only extracted citation text goes to Crossref, Semantic Scholar, OpenAlex, DBLP and arXiv;
the complete PDF is not uploaded to those services. Database queries are public API reads.

The page shows every extracted citation, its best matching record, and issues requiring review.
A missing record is **not proof of fabrication**. Unavailable databases are skipped; a reference with no match in the available databases is
reported as not found. Only a total database outage is reported as unable to check. Text extraction and matching are heuristic: check
the extracted bibliography against the original PDF. This does not verify the paper's claims.

The endpoint, `POST /reference-check/pdf?checker=references-validation&consent=query-reference-databases`, accepts a raw
`application/pdf` body and requires an admin member session. Submit approves the exact upload
through a request-scoped in-memory proposal/approval/execution flow. Nothing about this scan is
written to SQLite; no PDF, result, scan history, proposal or scan audit is persisted. No email is
sent. Results disappear when leaving the page. Repeating the same PDF performs another check.

CheckIfExist limits: one check per service process, 20 MB, 200 pages, 100 extracted references, a 30-second
upload timeout and a ten-minute overall deadline. Encrypted/unreadable PDFs and missing
bibliography headings fail clearly; image-only scans require OCR elsewhere. Requests go directly
to fixed database hosts, without browser CORS proxies. Per-database spacing and timeouts bound
lookups; no extra API accounts are required, but unauthenticated public APIs can limit access.
Disconnecting the browser aborts pending requests; requests already received cannot be recalled.

The imported engine is pinned and attributed in
`extensions/adminbot/src/third-party/references-validation/NOTICE.md`. The existing persistent
OpenReview/GPTZero workflow below is unchanged and still needs its own GPTZero entitlement.

### OpenReview submissions

Set `GPTZERO_API_KEY` in the **service's** environment and restart the service. On Aurora, the
deployment loads `~/.config/jinesis-adminbot/adminbot.env`. The GPTZero account must have access
to the Bibliography Scan API; an AI-detection-only entitlement may not be sufficient.

With the usual `ADMINBOT_SERVICE_TOKEN` exported in your terminal, propose a scan:

```bash
curl --fail-with-body http://127.0.0.1:8765/reference-scans \
  -H "Authorization: Bearer $ADMINBOT_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"submission_id":"YOUR_OPENREVIEW_ID","notify_email":"reviewer@example.org"}'
```

Use the ID from `https://openreview.net/forum?id=...`, not the full URL. Replace the example
notification address with the intended reviewer. This request downloads a public PDF and
creates a `reference.scan` proposal; it does **not** upload the PDF to GPTZero yet.

1. Review and approve the proposal in Pending Actions, then execute it. It is T3/admin-only.
2. Execution downloads the public PDF again and checks its SHA-256 against the approved payload.
   If it changed, execution refuses; propose the new version instead.
3. GPTZero's result is saved in the service database. A `fake` or `exist_with_issues` citation
   creates an `email.send` proposal addressed to the reviewer. Inspect the evidence before
   separately approving and executing that notification. Nothing is automatically mailed.

Read the saved record using `submission_id` and `pdf_sha256` from the scan proposal's payload:

```bash
curl --fail-with-body --get http://127.0.0.1:8765/reference-scans \
  -H "Authorization: Bearer $ADMINBOT_SERVICE_TOKEN" \
  --data-urlencode 'submission_id=YOUR_OPENREVIEW_ID' \
  --data-urlencode 'pdf_sha256=HASH_FROM_PROPOSAL'
```

Both routes require a service token or an admin member session. Ordinary members cannot read
scan results or submit scan proposals. Authentication and browser-origin checks remain active.

### Automatic checks of the account's own submissions

With `ADMINBOT_OPENREVIEW_CITATION_CHECKS=1`, `OPENREVIEW_USERNAME` and `OPENREVIEW_PASSWORD` in
the service environment (on Aurora, `~/.config/jinesis-adminbot/adminbot.env`), AdminBot checks
the citations of every submission that account is an author of — including restricted
submissions under blind review — once per uploaded PDF version, to catch fabricated or garbled
references before a desk rejection.

- **Discovery.** The sweep logs in, reads the account's profile ID, and lists API2 notes with
  `content.authorids=<profile>`. Replies, withdrawn and desk-rejected submissions, and
  submissions without a PDF yet are skipped.
- **One check per version.** API2 stores each upload under a content-addressed path
  (`content.pdf`, e.g. `/pdf/<hash>.pdf`). A path that has never been checked is downloaded,
  checked once and recorded in `adminbot_openreview_citation_checks`, keyed by submission and
  path. A new upload is a new path and gets a new check. Identical bytes under a new path reuse
  the earlier result and raise no second email.
- **The check.** The PDF is downloaded with the account's token from the fixed
  `https://api2.openreview.net/pdf?id=` endpoint and parsed on the host with the CheckIfExist
  engine above. Only the extracted citation strings leave the host. GPTZero is never used for
  these papers, because it would upload a restricted manuscript. Bibliographies of up to 300
  references are accepted, against 100 on the interactive page.
- **Outcomes.**
  - `completed` stores every finding.
  - `unreadable` is final for that version: no bibliography heading, encrypted, over 300
    references, or more than 20% of the bibliography in chunks that could not be split into single
    entries. What the clean entries showed is still stored, but no email is raised.
  - `failed` (download error, 60-minute timeout, more than 20% of entries unchecked because
    Crossref, OpenAlex or DBLP did not answer) is retried by later sweeps, up to three attempts.
  - "Not found" is only claimed when Crossref and DBLP both answered. OpenAlex, Semantic Scholar
    and arXiv are consulted but not required: OpenAlex gives an IP without an API key only a small
    shared daily budget (set `OPENALEX_API_KEY` to use one), and the other two throttle anonymous
    clients constantly.
  - Review-mode line numbers, ACL/ICML/NeurIPS/ICLR bibliography styles, alphabetic labels and
    hundred-author team reports are handled. Measured on this account's 328 submissions
    (2026-09-23), 272 split cleanly enough to check.
- **Pacing and back-off.** A database that answers 429 or 503, or refuses connections, is left
  alone for its `Retry-After` (15 minutes if it gives none, at most 6 hours), shared by every check
  in the process. While Crossref or DBLP is backing off, the sweep does not start or stops before
  the next paper, and a paper interrupted by it does not spend a retry. Papers are a minute apart.
  A placeholder upload with no text is recorded as such and checked when the paper is uploaded.
- **Notification.** A completed check with any `not_found` citation creates an
  `email.send` proposal (listing its `review` items too; those alone do not) to `ADMINBOT_CITATION_CHECK_NOTIFY` (default: the first
  `ADMINBOT_CONTACT_EMAILS` address). It is sent only after an admin approves it in Pending
  Actions. Without a recipient, results are only stored.
- **Scheduling.** The `adminbot-citation-checks` cron job (`25,55 * * * *`) calls
  `POST /openreview/citation-checks/run`. That call lists the submissions, which surfaces a bad
  login as an HTTP 5xx error, then starts a background sweep and returns 202. A running sweep is never
  restarted. The sweep re-reads the submission list after every paper and always takes the most
  recently modified unchecked version next, so a new upload is checked ahead of any first-run
  backlog. The first run backfills the account's whole history, which takes hours of rate-limited
  public lookups.
- **Results.** `GET /openreview/citation-checks` (service token or admin session) returns every
  recorded version plus the current/last sweep summary. The PDF Reference Checker page shows the
  same list to admins.

Register the job on the host after deploying with
`scripts/adminbot-cron-sync.sh --dry-run --only adminbot-citation-checks`, then the same command
without `--dry-run`.

### ICLR pre-deadline integrity check

`workflows/papers/iclr-integrity-watch.ts`, opt-in with `ADMINBOT_ICLR_INTEGRITY_CHECKS=1` and
`PANGRAM_API_KEY`, on top of the OpenReview credentials.

- **Scope.** Only ICLR main-conference papers still under review
  (`ICLR.cc/<year>/Conference/Submission`). Accepted and rejected ICLR papers have moved venue, so
  the account's history is never scored.
- **AI-text score.** The whole document's text — bibliography and appendix included, extracted
  on the host with review-mode line numbers stripped (including the ICLR template's column of
  number-only lines) — goes to Pangram's `/task` API with `model: "pangram-4"` and
  `public_dashboard_link: false`. The PDF itself never leaves the host. This is what matches
  Pangram's website, which runs Pangram 4 over the whole upload: on one ICLR submission the website
  read 82% and this text under Pangram 4 read 82%. Two earlier pipelines did not, and their scores
  (`scored_from` of `text`, `pdf` or unset) are re-scored once, keeping any alert already raised; a
  failed re-score leaves the old number in place. They were the main body only (0% on that paper),
  and Pangram's file endpoint, which ignores `model` and always runs the retiring Pangram 3.3.2
  (also 0%). The API's default model is still 3.3.2 until 30 September 2026, which is why the model
  is pinned. Each uploaded version is scored once, and identical bytes under a new path reuse the
  earlier score. Pangram 4 bills per started 100 words, so an unchanged paper costs nothing per
  hourly run. A placeholder or a text under 300 words is recorded as `unreadable` and not sent. A
  whole-document score counts prompt templates, code listings and model transcripts in an
  appendix. A Pangram failure (bad key, out of credits, rate limit, timeout) is `failed` and
  retried by the next three sweeps.
- **Alert.** A Slack group DM, as the auto-approved `paper_integrity.alert` action, goes to the
  head professor (the `head_professor_member_id` setting) and the first two lab members, in author
  order, whose Member Type includes `full` or `coauthor-major`. Authors are matched on the roster's
  `openreview_id`, `email` or `calendar_email`. It is raised when Pangram's `fraction_ai` exceeds
  `ADMINBOT_ICLR_AI_THRESHOLD` (default 0.5), or when this version's citation check found a
  `not_found` reference. Each reason alerts at most once per version, and a citation result that
  lands after the score still alerts on the next hourly run. If nobody on the paper has a linked
  Slack account, the alert waits and the reason is stored as `alert_error`.
- **Hourly digest.** After every sweep, the Slack user ids in
  `ADMINBOT_ICLR_INTEGRITY_REPORT_SLACK_USERS` (comma-separated; unset means none) get a DM, as the
  auto-approved `paper_integrity.report` action, listing each ICLR submission with a PDF: its
  current Pangram score and its citation status. It goes out on quiet hours too. It is for
  operators, not authors, and a send that fails is stored on the sweep as `report_error` without
  failing the sweep.
- **Lab sheet.** With `ADMINBOT_ICLR_INTEGRITY_SHEET_ID` set (tab
  `ADMINBOT_ICLR_INTEGRITY_SHEET_TAB`, default `Papers-iclr-feedback`), every sweep writes each
  submission's score into the `Pangram Score` column (H by default) and, for a completed citation
  check, the exact references no database has into column I, one per line — as the auto-approved
  `paper_integrity.sheet_scores` action, whose executor refuses anything but single cells in those
  two columns. Rows are matched by title first (exact, the part before a colon, or most words
  shared), then — for submissions a title cannot settle — by distinctive authors: at least two in
  common, ignoring anyone on a quarter or more of the rows (the PI, a lead), with one row clearly
  ahead. Anything else is left unwritten and named in the digest. Only changed cells are written.
  ICLR 2027 notes carry authors as `{ fullname, username }` objects with an empty `authorids`; the
  reader takes names and ids from those.
- **Confirmed hallucinated citations.** The Slack ids in
  `ADMINBOT_ICLR_CITATION_REPORT_SLACK_USERS` get a DM with the exact references, once per version,
  when a completed citation check (Crossref and DBLP both answered) has `not_found` findings. A
  `failed` check, an `unavailable` lookup or a `review` finding sends nothing.
- **Cutoff.** The check stops for good at `ADMINBOT_ICLR_INTEGRITY_UNTIL`, which defaults to
  2026-09-26 08:00 Toronto time (the end of the ICLR 2027 run). After that time a run starts
  nothing and answers `ended_at`, and a sweep that crosses the cutoff stops before its next paper.
  Set the variable to a later date to reopen it for another cycle.
- **Scheduling and results.** The `adminbot-iclr-integrity` cron job (`12 * * * *`) calls
  `POST /openreview/integrity-checks/run`. `GET /openreview/integrity-checks` (service token or
  admin session) lists every scored version.

## What is saved and how repeats work

The table has four columns: `submission_id`, `pdf_sha256`, `status`, and nullable `result_json`.
The first two form its composite primary key. Results hold the provider's scan ID/response version,
citation counts, and findings. Title, timing, errors, and notification tracking stay in the existing
proposal/audit records rather than being duplicated in the scan table. The entire PDF and
provider-extracted manuscript text are not stored.

Startup automatically migrates the initial MVP's `id`/`payload_json` schema to this layout in a
transaction, preserving scan status and results. Existing notification proposals remain unchanged.

An unchanged completed PDF returns `cached: true` and causes no GPTZero call. An existing pending
proposal is reused. A changed PDF creates a separate proposal. A failed scan is recorded as failed,
never clean, and the same approved action can be executed again. Such a retry may incur another
GPTZero charge if the original request reached the provider before the connection failed.

A `running` record after a process crash blocks automatic re-upload. There is deliberately no
automatic timeout-based retry of an upload with an unknown billing/result outcome. Operator
recovery for interrupted scans is a later milestone. If a notification proposal could not be
created after a successful scan, re-executing the scan action uses the saved result and retries
proposal creation without calling GPTZero again.

`unsure`, `unknown`, and null existence assessments count as uncertainty, not hallucinations.
Zero detected citations is not proof that a paper has no citation problems. No AI-authorship
score is used to label a citation. Findings are requests for human review, not accusations.

## Provider contract and limits

The connector uses the documented
[Bibliography scan on files](https://gptzero.stoplight.io/docs/gptzero-api/4yq7vni3lg51b-bibliography-scan-on-files)
endpoint: `POST https://api.gptzero.me/v2/bibliography-scan/files`, `x-api-key`, multipart field
`files`. It expects a one-element result array and interprets `bibliographic_citations[].citation_exists.status`.
Unexpected responses fail instead of producing a clean verdict.

The GPTZero workflow accepts only anonymously downloadable OpenReview API2 PDFs, with a 20 MiB download cap,
bounded responses, and timeouts. It sends no OpenReview credentials and follows no redirects or
arbitrary metadata URLs. Private submissions are covered only by the local CheckIfExist sweep
described above, never by GPTZero.

## Validation

Manual PDF checker (real PDF extraction, synthetic database responses, HTTP/SQLite and UI):

```bash
node scripts/run-vitest.mjs run \
  extensions/adminbot/src/connectors/reference-check.test.ts \
  extensions/adminbot/src/api/server.pdf-reference-check.test.ts \
  ui/src/ui/adminbot/views/reference-checker.test.ts
```

Persistent OpenReview/GPTZero workflow:

```bash
node scripts/run-vitest.mjs run \
  extensions/adminbot/src/connectors/reference-scan.test.ts \
  extensions/adminbot/src/api/server.reference-scans.test.ts
```

Tests use synthetic provider responses with real local HTTP and SQLite. They do not upload lab
papers, call a paid API, or send messages. The persistent workflow still requires a live GPTZero
account check before deployment; the default manual checker does not use GPTZero. This feature does not
replace the existing OpenReview reference-check script.

### Selecting a manual checker

The PDF Reference Checker offers CheckIfExist (default) and GPTZero. Changing
the selection keeps the PDF but clears the previous result; only Submit starts a check.
CheckIfExist sends extracted citations to scholarly databases. GPTZero uploads
the full PDF and may charge on each submission, including retries. It is currently marked
as not working with our account because the API returned HTTP 403; choosing it still makes
a real request if the service is configured. There is no automatic fallback.

GPTZero uses `POST /reference-check/pdf?checker=gptzero&consent=upload-to-gptzero`.
The service requires provider-specific consent and an authenticated admin session.
Missing GPTZero configuration returns 503. Both manual options use transient approvals
and keep PDFs, results, proposals and scan audits out of SQLite; the persistent OpenReview
workflow is separate. GPTZero results show total citations, flagged findings and uncertain
counts; CheckIfExist shows every extracted citation and its lookup status.

The UI requests newline-delimited JSON with `Accept: application/x-ndjson`.
CheckIfExist emits `progress` events after extraction and after each citation finishes,
followed by a `complete` event containing the final report. GPTZero returns a single
completion event because its API supplies the finished report. Clients without that
Accept header retain the ordinary JSON response. Once streaming starts, failures are
sent as `error` events. The UI keeps already received findings and reports interrupted
checks. Changing the selected file/account clears the results; disconnecting cancels
CheckIfExist lookups. No stream data is persisted.

Not-found citations offer a **Search Google Scholar** link. Existing matches offer a database link when the provider supplies one. Clicking it opens
Scholar with that citation as the search query; AdminBot does not query Scholar automatically.
