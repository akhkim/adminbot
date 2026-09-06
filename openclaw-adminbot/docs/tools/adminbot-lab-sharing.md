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
section. Expressing interest, direct invitations, announcements, director status
and automatic notifications are not implemented by this change.
