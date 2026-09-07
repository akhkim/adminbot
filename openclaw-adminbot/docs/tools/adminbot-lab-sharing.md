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
section. Direct invitations, announcements, director status and automatic
notifications remain follow-up work.


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
