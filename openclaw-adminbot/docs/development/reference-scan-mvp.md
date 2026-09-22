# OpenReview reference scan MVP

The TypeScript AdminBot service can propose a GPTZero bibliography scan of one **public**
OpenReview submission. It stores scan state in `adminbot_reference_scans` inside the service's
existing SQLite database. No separate database, Python process, gateway agent, or new scheduler
is required. The existing Pending Actions UI handles approval and execution.

## Setup and first run

### Ad hoc PDF uploads

Run `./dev.sh` from the outer repository directory with your personal OpenClaw gateway running.
Open the printed Frontend URL and click Alice in the local account picker. See `dev/README.md`
for gateway setup. The launcher reads the ignored `.env.gptzero` file when present; it must contain
`GPTZERO_API_KEY`. Submitting a PDF uses the real provider, including in development.

Admins can open **General Tools → PDF Reference Checker**, drop or choose one PDF (up to
20 MB), and click **Submit**. This explicitly approves sending that file to GPTZero. The page
shows citation counts, uncertain citations, and flagged references with explanations. It checks
bibliographic references, not all factual claims in the paper.

The upload endpoint, `POST /reference-check/pdf?consent=send-to-gptzero`, accepts a raw
`application/pdf` body and requires an admin member session. The service keeps the key server-side,
validates the upload, and uses a request-scoped in-memory proposal/approval/execution flow. It
writes no PDF, scan result, scan proposal, or scan audit to SQLite, and sends no email. Results live
only in the current page; switching away discards them. Every submission, including the same PDF,
is a fresh provider call and may incur a charge. GPTZero's own data handling still applies.

Only one upload check runs at a time per service process. Failed requests are not automatically
retried. A disconnected browser does not guarantee cancellation of an upload already sent to
GPTZero. The persistent OpenReview workflow below remains separate.

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

```bash
node scripts/run-vitest.mjs run \
  extensions/adminbot/src/connectors/reference-scan.test.ts \
  extensions/adminbot/src/api/server.reference-scans.test.ts
```

Tests use synthetic provider responses with real local HTTP and SQLite. They do not upload lab
papers, call a paid API, or send messages. A live GPTZero account check is still required before
deployment. This feature does not replace the existing OpenReview reference-check script.
