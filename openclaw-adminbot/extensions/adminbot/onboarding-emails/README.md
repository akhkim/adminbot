# Onboarding guide emails

**The copy now lives in `../src/onboarding-emails.ts`.** These templates were reviewed as
markdown here and folded into that module so a string lives in exactly one place and ships
with the service instead of being read off disk at runtime. This file keeps the decisions
behind the copy, which the module itself cannot carry.

The surface is the `Onboarding` tab (admin only). It posts to `POST /onboarding/guide`,
which requires an admin member session and rejects the shared service principal, so nobody
can onboard anyone by talking to AdminBot in Slack.

## Files

Templates marked **lab text** are the lab's own supplied wording, used verbatim (or
verbatim plus the matrix items it did not cover -- see `enriched:` in front matter).
The four subgroups with no supplied wording keep their earlier drafts, which the lab
has approved for use.

### Candidate pipeline (pre-membership)

| File                            | Stage                                                 | Source       |
| ------------------------------- | ----------------------------------------------------- | ------------ |
| `candidate-interview-invite.md` | interview invite                                      | **lab text** |
| `candidate-trial-phase.md`      | interview passed -> trial (`privilege_level = trial`) | **lab text** |
| `candidate-rejection.md`        | interview declined                                    | **lab text** |

### Membership

| File                       | Group                                     | Source       |
| -------------------------- | ----------------------------------------- | ------------ |
| `member.md`                | `member` privilege ("Accept Full Member") | **lab text** |
| `member-what-to-expect.md` | direct mentees of Zhijing only            | **lab text** |
| `member-rejection.md`      | application declined                      | **lab text** |

`admin` has no template: appointment is manual, so the tab should not offer it.

"Accept as Guest" is not a template -- it is the Slack Connect invite action with no
accompanying email.

### External collaborators

The lab's wording groups collaborators by engagement level; the code groups them by
`collaborator_subgroup`. Mapping used:

| Lab name                                  | Subgroup                      | File                                      | Source                  |
| ----------------------------------------- | ----------------------------- | ----------------------------------------- | ----------------------- |
| External Senior Collaborator              | `external_prof`               | `external-prof.md`                        | **lab text**            |
| External Junior Collaborator              | `coauthor_minor`              | `external-coauthor-minor.md`              | **lab text**            |
| Single-Project Collaborator (Nikita-type) | `slightly_better_than_emails` | `external-slightly-better-than-emails.md` | **lab text**            |
| High-Commitment (Michael Regan-type)      | `coauthor_major`              | `external-coauthor-major.md`              | **lab text**            |
| --                                        | `interviewee`                 | `external-interviewee.md`                 | draft, approved for use |
| --                                        | `acquaintance`                | `external-acquaintance.md`                | draft, approved for use |
| --                                        | `alumni`                      | `external-alumni.md`                      | draft, approved for use |
| --                                        | `disappearing_coauthor`       | `external-disappearing-coauthor.md`       | draft, approved for use |

`collaboration-rhythm-reminder.md` is a mid-project note, not an onboarding email, and
is sent by hand rather than by the tab.

## Unresolved before any of this is sent

1. `member-what-to-expect.md` has Zhijing's real WhatsApp number in the source. Repo
   policy forbids committing real phone numbers, so it is `{zhijing_whatsapp}` and is
   resolved at send time -- see the next section.

Resolved: the two `XXX` contacts are Andrew Kim / andrewkihyun@gmail.com; the signup
link is the site root, since `/signup` is not a routed path; every template now carries a
subject line; `coauthor_major` is 20-40 h/week (the matrix was right); the thin lab text for
`coauthor_minor` and `external_prof` has been enriched with the matrix items it omitted;
the four subgroups without lab text keep their approved drafts.

## Slack Connect and the free workspace

Slack Connect only works if the invitee is already in _some_ Slack workspace. Anyone
without one -- which is most external collaborators, and the case the matrix's
`slack_guest_space_check` row exists for -- has to join the free Jinesis space first or
the invite cannot be accepted:

```
https://join.slack.com/t/jinesis/shared_invite/zt-3d5p5t0nl-dsxvIZW3DJuC0b5lMkk3Vg
```

Every template that offers Slack Connect carries that fallback line: all eight external
subgroups plus `candidate-trial-phase.md`. This is the _free_ space, distinct from the
main UofT workspace, which needs a `@cs.toronto.edu` address (see `member.md` step 2).

The link is an access-granting invite. It lives here because this repo is private; if it
is ever regenerated it must be updated in all nine files, which is one more reason to
fold these into a typed module with the URL declared once.

## Where the WhatsApp number lives

`{zhijing_whatsapp}` is resolved from **AdminBot settings**, not from this repo and not
from an env var.

Settings already exist for exactly this shape of value -- lab-wide governance config an
admin owns (`head_professor_member_id`, `applicant_sheet_id`, ...). They are stored in
the `adminbot_settings` SQLite table, editable from the Control UI, and both `GET` and
`PUT /settings` are admin-gated (`requirePrivileged` / `requireMemberPrivileged`), so a
plain member never reads the number.

`head_professor_whatsapp` is wired through `AdminBotSettingsInput`/`AdminBotSettings`,
`updateSettings`, the AdminBot web UI form, and the Control UI settings form. Set it
once from either settings screen; `{zhijing_whatsapp}` reads it at send time.

Not publicly reachable: `/settings` requires `requirePrivileged` to read and
`requireMemberPrivileged` to write, and only the two `/reimbursements/*` POST routes are
anonymous. It is governance config, not encrypted secret storage -- admins and the agent
service principal can read it, plain members and anonymous callers cannot.

Why not the alternatives:

- **`.env`** works, but the repo bar for a new env var is explicitly high ("before
  adding a config option or env var, first prove existing product behavior cannot solve
  it"), and it would mean shell access to Aurora plus a service restart to change a
  phone number, with no audit trail.
- **The sensitive-info document** is the wrong store despite the name: it defines _what
  kinds_ of information are sensitive and feeds `listSensitiveTerms()` for redaction.
  Putting the number there risks the privacy broker redacting it out of the very email
  meant to carry it.

## Send-time rules

**Never send with an unfilled placeholder.** Each template's front matter carries
`required_placeholders`. The send path must refuse to send when any of them is empty
and ask the operator for the missing values instead. A blank `{contact_name}` or a
literal `{project_or_context}` reaching a collaborator is worse than not sending at all
-- three of the templates need six or more values, so this will fire often and is not
an edge case.

`{slack_connect_link}` and `{drive_folder_link}` are generated during the send, so
they are "provided" once generation succeeds. If either fails, the send fails; do not
fall back to sending the email without them.

**Subjects never name the tier.** `Collaborating with us on X`, not
`Single-Project Collaborator - Collaborating with us on X`. The recipient has no idea
which internal bucket they are in and should not learn it from a subject line. This
applies to anything the send path prepends, too.

**Bodies carry no hard wrapping.** Every paragraph and every bullet is a single line;
line breaks exist only between blocks. A wrap inside a paragraph becomes a literal
newline in the delivered mail and reads as broken text in most clients. Bullets are
used where a list genuinely helps; prose stays prose.

## Rules applied to the external templates

The matrix `detail` strings are written as instructions to a lab admin, not prose
for the recipient. These templates therefore do **not** derive from them mechanically.

**Never stated to the recipient** — internal bookkeeping, present in the matrix but
omitted from every template:

- `spreadsheet_full_details`, `spreadsheet_basic` — back-end spreadsheet profile
- `spreadsheet_whatsapp_personal_email` — WhatsApp / personal email kept on file
- `vector_roster_share` — the sponsor sheet that decides account renewal
- `slack_guest_space_check` — a precondition you check, not a thing they do
- `newcomer_drive_practice` — an admin action; the practices doc covers it for them

**Non-`yes` cells:**

- `yes_separate` → deliberately _not_ in the main body. Each template's front matter
  lists which separate follow-ups to send; use the skill's existing
  "Separate Practices Doc" template. Folding it into the invite is what the matrix
  is explicitly avoiding.
- `pending` → omitted. `interviewee` x `#proj-xxx` is unconfirmed policy; ask first.
- `case_by_case` (`coauthor_minor` rec letters) → silent. They come to us; the
  template must not imply a standing offer.
- `auto_decline` (`disappearing_coauthor` rec letters) → silent. Never hint at a
  letter. If they ask, the skill's decline template answers.

**Reworded rather than dropped:**

- `backend_email_triggers` → "we'll email you when a paper goes out"
- `time_plan_confirmation_emails` → "we'll email to confirm your time plan"

## Placeholders

| Token                          | Source                | Meaning                                                                           |
| ------------------------------ | --------------------- | --------------------------------------------------------------------------------- |
| `{first_name}`                 | form                  | recipient's first name (from the name field)                                      |
| `{sender_name}`                | session               | the signed-in admin                                                               |
| `{contact_name}`               | form                  | day-to-day point of contact for the collaboration                                 |
| `{discussion_channel}`         | **Slack picker**      | one of `#discussion-*`                                                            |
| `{next_steps}`                 | form                  | what happens immediately after this email                                         |
| `{update_cadence}`             | form                  | how often we send substantive updates (default: 2 to 4 weeks)                     |
| `{update_due_date}`            | form                  | when the next update will reach them                                              |
| `{meeting_cadence}`            | form                  | how often the project meets, and where                                            |
| `{meeting_names}`              | form                  | which meetings they join                                                          |
| `{core_meetings}`              | form                  | meetings attendance is expected at                                                |
| `{deliverable}`                | form                  | expected scope for a single-project collaboration                                 |
| `{timeline}`                   | form                  | rough timeline for that scope                                                     |
| `{project_channel_or_meeting}` | form                  | the one channel or meeting a single-project collaborator joins                    |
| `{zhijing_whatsapp}`           | config                | resolved at send time; never stored in this repo                                  |
| `{project_or_context}`         | form                  | the project or paper they are joining                                             |
| `{slack_connect_link}`         | **generated at send** | `conversations.inviteShared` -> `url`; expires in 14 days, so it cannot be stored |
| `{drive_folder_link}`          | **generated at send** | copy of the prototype folder, renamed `Zhijing-<Name>`                            |
| `{dashboard_url}`              | constant              | `https://jinesis-admin.vercel.app`                                                |

Fixed channels are written into the copy directly rather than parameterised, since
they never vary: `#jinesis-with-friends-and-collaborators` (C09MANEUPPZ),
`#jinesis-active` (C0A06H6K6DV), `#random-active` (C0ALDF1FGKT), and
`#discussion-gpu-canada` (C0A6Q5RCBHQ), all verified present in the workspace.

Note `#jinesis-with-friends-and-collaborators` is the same channel the
email-automation skill already uses for trial Slack Connect invites, so the trial
and external-collaborator paths land people in one place.

## Send-time generation

The three dynamic values are produced when Send is pressed, not stored:

1. **Slack Connect link** — `conversations.inviteShared` with the bot token, the
   call `scripts/adminbot-email-automation.ts:724` already makes. Omit the `emails`
   argument and use the returned `url`, otherwise Slack sends its own invite email
   and the person gets two.
2. **Channel picks** — `conversations.list` populates the pickers. Many `#proj-*`
   channels are private, so the bot only sees the ones it has been added to; the
   picker must say so rather than silently showing a short list.
3. **Drive folder** — a copy of the `Zhijing-StudentName` prototype
   (`1abl0CdA2Le3t2WxOy8Fb8UUMsmiQbAPs`, owned by the AdminBot account), renamed `Zhijing-<Name>` and made
   link-editable. Verified recipe below.

`#proj-*` is deliberately out of scope for now: those channels are usually private,
so the bot can neither see nor invite to them. Add project channels by hand.

## Drive copy: verified recipe

Drive cannot copy a folder — `files.copy` on the prototype returns
`403 cannotCopyFile`. The prototype is flat (6 items, no subfolders), so no
recursion is needed:

```bash
# 1. new folder
gog --json drive mkdir "Zhijing-<Name>"          # -> .folder.id  (note: .folder, not .file)

# 2. copy each child into it; shortcuts copy as shortcuts, which is what we want --
#    they keep pointing at the shared originals instead of duplicating them
gog --json drive copy <childId> "<childName>" --parent <newFolderId>

# 3. link-editable; --force is required for an `anyone` grant non-interactively
gog --json drive share <newFolderId> --to anyone --role writer --force
```

Prototype contents: 2 shortcuts (`Jinesis Share`, `Guidebook for Jinesis Research
Mentees (Internal Sharing Only)`) and 4 `.docx` files (`Meeting Log`,
`Time Availability_Student Name`, `yyyymmdd_literature_review`,
`yyyymmdd_task_title`). All six copy cleanly; verified end to end and cleaned up.

Naming: the first two whitespace-separated parts of the name, joined and prefixed --
`Andrew Kim` -> `Zhijing-AndrewKim`, `Maria Garcia Lopez` -> `Zhijing-MariaGarcia`.

Two flags for the implementation:

- `drive ls` rejects `--max 0` (`tree` accepts it). Getting that wrong left a created
  but empty folder behind, so the copier must clean up after itself on failure rather
  than leaving a half-built folder that looks provisioned.
- `Time Availability_Student Name.docx` keeps the placeholder name in every copy.
  Open question whether the copier should rename it per person.

## Placeholder conventions for the lab text

The supplied templates use `[Name]`, `[NAME]`, `______` and `XXX`. Those were
normalised to the `{token}` convention already used here so one substitution pass can
fill them. **Wording is otherwise verbatim** -- only the placeholder tokens changed.

One exception worth knowing: `member.md` contains
`{first_letter_of_first_name}{full_last_name}` _inside the body_. That is the lab's own
example text explaining the preferred DCS address format, not a placeholder for the
sender. It must survive substitution literally.
