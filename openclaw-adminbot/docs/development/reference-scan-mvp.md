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

The MVP accepts only anonymously downloadable OpenReview API2 PDFs, with a 20 MiB download cap,
bounded responses, and timeouts. It sends no OpenReview credentials and follows no redirects or
arbitrary metadata URLs. Private submissions, commitment-venue links to another submission,
venue-wide discovery, scheduling, and a dedicated results UI are not included in this version.

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
