# Onboarding guide email templates

One template per user group, for the Onboarding tab: an admin picks a tier, types a
name and email, and AdminBot sends that group's guide directly (admin session
required, audited — no propose/approve step, same reasoning as
`account-approved-email.ts`).

**Status: draft, for review. Nothing reads these yet.** Once the copy is signed off
they get folded into a typed module next to `onboarding.ts` and
`collaborator-subgroups.ts` so there is one source per string.

## Files

| File                                      | Group                         | Source of truth for content        |
| ----------------------------------------- | ----------------------------- | ---------------------------------- |
| `trial.md`                                | `trial` privilege             | subset of `onboarding.ts`          |
| `member.md`                               | `member` privilege            | points at the dashboard checklist  |
| `external-interviewee.md`                 | `interviewee`                 | `collaborator-subgroups.ts` matrix |
| `external-slightly-better-than-emails.md` | `slightly_better_than_emails` | matrix                             |
| `external-acquaintance.md`                | `acquaintance`                | matrix                             |
| `external-alumni.md`                      | `alumni`                      | matrix                             |
| `external-coauthor-minor.md`              | `coauthor_minor`              | matrix                             |
| `external-coauthor-major.md`              | `coauthor_major`              | matrix                             |
| `external-disappearing-coauthor.md`       | `disappearing_coauthor`       | matrix                             |
| `external-prof.md`                        | `external_prof`               | matrix                             |

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

| Token                  | Source                | Meaning                                                                           |
| ---------------------- | --------------------- | --------------------------------------------------------------------------------- |
| `{first_name}`         | form                  | recipient's first name (from the name field)                                      |
| `{sender_name}`        | session               | the signed-in admin                                                               |
| `{sponsor_name}`       | form                  | the lab member who brought them in                                                |
| `{project_or_context}` | form                  | the project or paper they are joining                                             |
| `{slack_connect_link}` | **generated at send** | `conversations.inviteShared` -> `url`; expires in 14 days, so it cannot be stored |
| `{drive_folder_link}`  | **generated at send** | copy of the prototype folder, renamed `Zhijing-<Name>`                            |
| `{discussion_channel}` | **Slack picker**      | one of `#discussion-*`                                                            |
| `{meeting_channel}`    | **Slack picker**      | one of `#meeting-*`                                                               |
| `{dashboard_url}`      | constant              | `https://jinesis-admin.vercel.app`                                                |

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

## Tier coverage

`admin` has no template: admin appointment is manual, so the tab should not offer it
as a sendable tier. A person promoted to admin has already had `member.md`.

`member.md` is deliberately thin. The dashboard checklist is the guide, so the email
only signs them in, points at it, and starts the one item with a real lead time
(Compute Canada needs a lab admin's approval). Everything else stays in
`onboarding.ts`, where it is already maintained.

## Open question for review

**`trial`** — the email-automation skill grants trial members Slack Connect to
`C09MANEUPPZ` and calendar `reader`, and nothing else. `trial.md` matches that and
deliberately omits Compute Canada and the Drive setup. Confirm that is right.

`trial.md` was left at its original length rather than trimmed like `member.md`: its
content is Slack, calendar and dashboard access, which is not a restatement of the
checklist. Say the word if you want it cut back too.
