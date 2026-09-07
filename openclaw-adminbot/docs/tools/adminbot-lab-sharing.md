# Lab Sharing help requests

Signed-in members can browse explicitly opened project help requests, search their
text or tags, and see tasks, staffing needs, weekly hours and an optional timeline.
Project authors and administrators can save, edit, close or reopen a request.
Saving updates the one request associated with that project; repeated saves do not
create duplicate listings. Closed requests remain available to project authors and
administrators. Deleting a project removes its request from the visible directory.

The service checks authorship using the same rule as project edits. It derives the
actor from a member session; anonymous and shared service-token callers cannot use
these endpoints. Responses contain recruitment fields, title and posting member's
name, without the full paper or member record. Only explicitly opened requests are
listed, never all papers automatically. Saving records an audit event and changes
only the local lab ledger; it does not send Slack messages or email.

- `GET /lab-sharing`: editable project choices and visible requests.
- `PUT /lab-sharing/requests/:paperId`: open/update a request with `description`,
  `tags`, `members_needed`, `hours_per_week`, and optional `timeline`.
- `POST /lab-sharing/requests/:paperId/close`: close an existing request.

SQLite adds `adminbot_help_requests` without altering existing tables. The paper ID
is its primary key. Deployment does not require manually modifying the database.

Other Lab Sharing features are still clearly labeled sample previews in a collapsed
section. Announcements and automatic notifications remain follow-up work.


## Offers to help

Members who do not manage a project can offer help on its open request with weekly
availability and an optional note. The service accepts finite hours greater than
zero and at most 168, and notes up to 1000 trimmed characters. The browser uses
half-hour increments. Identity, status and timestamps come from the service.

- `PUT /lab-sharing/requests/:paperId/interest`: save/update the caller's offer with
  `hours_per_week` and optional `note`; JSON body limited to 4096 bytes.
- `POST /lab-sharing/requests/:paperId/interest/withdraw`: withdraw the caller's offer.
- `GET /lab-sharing`: includes only caller-visible `interests`, with `is_own` supplied
  by the service. Respondents see their own active/withdrawn offers; current project
  authors and admins see active offers on projects they manage. Other members see
  no respondent names, notes, hours or response counts.

Closing a request rejects new/updated offers but preserves existing responses.
Respondents can still withdraw after closure. Reopening preserves active offers
with their original update time. Removing an author revokes their manager view.
Offering help does not add paper authors, accept membership or send notifications.

SQLite adds `adminbot_help_interests` with a composite project/member primary key;
repeat saves update one row. Save/withdraw audits record the actor and project ID,
not free-text notes. Withdrawal changes status; it does not erase the stored record.

## Member search

The Collaborate page searches saved member names, research branches, research topics,
and titles of projects with an open help request. Matching is case-insensitive
substring matching. Project associations use the existing project authorship rule;
closed requests and other paper titles are excluded.

`GET /lab-sharing/members?q=...` requires a member session. Anonymous callers receive
401 and shared service-token callers receive 403. Trimmed queries under two
characters return no matches; queries over 100 characters receive 400. Results sort
by name and ID and return at most 20 members, with `truncated` indicating more matches.

The response contains `members` and `truncated`. Each member has only `id`, `name`,
`research_branch`, `research_topics`, `matched_fields`, and `projects`. Each project
contains only `id` and `title`, and appears only when its title matches the query.
Admins receive the same narrow projection. Email addresses, private offer notes,
schedules, and non-recruiting paper details are neither searched nor returned.

The UI waits 250 milliseconds after typing, supports retry after a failed request,
and discards responses from earlier queries or sessions. Signing out clears the
results. Selecting a project clears the directory filter and scrolls to and focuses
its card. Search is read-only and requires no new database migration or connector.

## Collaboration resources

Signed-in members can use the resource cards on Collaborate to open meeting
recordings, their profile and research topics, time availability, or project records.
These are ordinary links to existing portal pages and respect the configured base
path. They do not copy records, submit forms, or expose the internal guidebook.

## Director status

The Collaborate page displays a manually shared status to signed-in lab members.
Administrators can publish or clear it. It does not infer availability from calendars,
Slack, or private schedules. The editor explicitly identifies the lab-member audience.

- `GET /lab-sharing/status`: current `status` or null, plus `can_manage`.
- `PUT /lab-sharing/status`: administrator-only publication with `availability`
  (`available`, `busy`, `away`, or `unknown`), a trimmed 1–500 character `message`,
  and future timezone-qualified `expires_at`. JSON is limited to 4096 bytes.
- `POST /lab-sharing/status/clear`: administrator-only removal.

Anonymous callers receive 401; shared service-token callers and member writes receive
403. The service supplies `updated_by` and `updated_at`, ignoring caller metadata.
Audit events record the actor without copying status text. SQLite adds a singleton
`adminbot_director_status` table; publishing replaces its row and clearing deletes it.

The service returns null after expiry; the browser also removes expired status without
a refresh. Expiry hides the stored text rather than deleting it. Explicit clear removes
the row. Browser inputs use the editor's device timezone and convert to ISO for the API.
Session changes clear status and drafts; denied authorization removes editing controls.
Ordinary network failures retain an administrator's draft for retry.

## Member how-to guidebook

The Lab how-to panel answers one question at a time using the existing loopback-only
retrieval and synthesis service and shows source section headings. Answers may quote
source passages. Local generation does not sanitize them or authorize forwarding to
hosted models. Questions and answers are not added to the audit log.

`POST /lab-sharing/ask` requires a member session (anonymous 401, shared service token
403). It accepts a question of 1–1000 trimmed characters in a 4096-byte JSON body.
Retrieval uses at most four sections and a 30-second request timeout. Browser requests
also time out and are cancelled on logout; stale answers never enter a new session.
Model output is rendered as plain text, including any HTML it contains. Failures show
resource-link guidance without exposing host paths, credentials or model errors.

An operator must first review a dedicated index and confirm every section is suitable
for all signed-in members. Configure `ADMINBOT_MEMBER_GUIDEBOOK_INDEX` to its absolute
path and `ADMINBOT_MEMBER_GUIDEBOOK_SHA256` to the SHA-256 of
`JSON.stringify(JSON.parse(indexFileText))`. For example, compute the digest locally:

```sh
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {createHash} from "node:crypto"; console.log(createHash("sha256").update(JSON.stringify(JSON.parse(readFileSync(process.argv[1], "utf8")))).digest("hex"))' /path/to/reviewed-member-index.json
```

Do not point this at the unreviewed internal index. Missing configuration, a changed
index (including a resync), or a digest mismatch disables member answers before any
model call. Review new content before updating the approved digest; no automatic
approval or fallback to the internal index exists. Keep the index outside the repo
with owner-only permissions. The same parsed object is checked and used for retrieval.

By default embeddings and answers use the existing local guidebook model configuration.
`ADMINBOT_MEMBER_GUIDEBOOK_EMBEDDING_URL` and `ADMINBOT_MEMBER_GUIDEBOOK_ANSWER_URL` can
override their endpoints, but both must remain loopback. The existing internal
`/guidebook/ask` caller contract is unchanged. This panel is a focused guidebook lookup,
not a general-purpose agent or an external-action interface.

## Collaboration and call invitations

Use Find lab members, select Prepare invitation, choose a project you manage and
enter a note. Collaboration requests propose an email with reply-to set to your
saved address. Call requests propose a calendar event with both members as attendees;
local input times are converted to UTC. Calls must start in the future and last at
most eight hours. Open the project's help request before submitting.

- `POST /lab-sharing/invites`: accepts `paper_id`, `recipient_id`, `kind`
  (`collaboration` or `call`), and a 1–1000 character `note`; calls also require UTC
  `start` and `end`. JSON bodies are limited to 4096 bytes.
- `GET /lab-sharing/invites`: only the caller's request IDs, statuses, kinds, project
  titles, recipient names and creation times. No contact addresses or proposal bodies.

The server verifies current project authorship/admin privilege, an open request,
other-member recipient and saved contact addresses. Caller-supplied addresses and
actor IDs are ignored. Anonymous/service-token callers cannot use these routes.
Identical actor/project/recipient/content requests reuse the same proposal and
execution idempotency key, including after reload. Changing the content creates a
new request requiring separate review.

Requests create existing T3 `email.send` or `calendar.send_invite` proposals. They do
not approve or execute them. Administrators review the exact recipient and payload
in Pending Actions; the existing connector and approval rules apply. A request is
not sent merely because it was submitted or approved. The member list shows the
stored proposal status; only successful execution is `executed`. The call proposes
an event on the connector's default calendar and does not create a video-call link.
No new persistence table or direct connector entry point is introduced.
