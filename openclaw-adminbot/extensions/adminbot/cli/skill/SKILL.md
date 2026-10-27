---
name: adminbot-cli
description: Use when the user asks to do anything in AdminBot (admin.safe.eu) — members, sign-ups, onboarding, papers, weekly notes, checklist tasks, badges, calendar, meetings, deadlines, nudges, mailing list, logistics, approvals — or mentions the adminbot CLI, an AdminBot page, or acting with their AdminBot access.
---

# AdminBot CLI

## Overview

The `adminbot` CLI calls every route the website uses (generated from the server's route
table), signed in as the user with a personal API token. Same rights as the user on the
website, same server checks. **Do what the user asks without making them approve each
step; stop only for the risky actions listed below.**

## Setup

`command -v adminbot` must succeed. If it doesn't, point the user to the CLI's README; don't
improvise another client. `operations` and `schema` are offline. Start with
`adminbot whoami`; exit 3 means you're not signed in.

Not signed in → run `adminbot login --no-browser` in the background, show the user the
printed link and code, and tell them it is one click to approve. The login then lasts until
revoked or unused for 90 days, so this happens once per machine.

Every error is one JSON line on stderr: `{"error":{code, message, exit_code, retryable,
hint, operation, status, details}}`. Read `message`, then run `hint`. `details.suggestions`
and `details.problems[].allowed` give the right flag, operation or value. Repeat the
command only if `retryable` is true (wait `details.retry_after_seconds` if given).

- Keychain unreadable (sandboxed agent, exit 3 `CREDENTIALS_ERROR`): ask the user to run
  `adminbot login --insecure-storage` once outside the sandbox, or to give you
  `ADMINBOT_TOKEN` in the environment.
- Never print, copy or echo the token. Don't run `adminbot auth token` into a transcript.
  Don't ask for, type or pipe the user's password.
- API tokens are for admins by default; a non-admin's approval is refused. Tell them to use
  the website.

## Finding the operation

1. Find the page in [pages.md](pages.md) (every operation, grouped by website page).
2. `adminbot schema OPERATION_ID` or `adminbot call OPERATION_ID --help` for its flags.
3. `adminbot call OPERATION_ID [PATH_IDS] [--flags]`. Body fields are `--kebab-case`;
   arrays are repeated flags (`--sheet-rows 14 --sheet-rows 15`); nested ones
   `--set a.b=VALUE`; or `--file body.json`. Every operation ID goes through `call`
   (`adminbot call get-deadlines`, not `adminbot get-deadlines`).
4. Get IDs from a GET first (e.g. `get-auth-registrations`, `get-lab-members`). Never guess
   an ID or pick between two similar records yourself — ask.

Readable shortcuts: `work list`, `work update PAPER_ID --note ...`, `tasks list PAPER_ID`,
`tasks update PAPER_ID TASK_ID --done|--link URL|--value V`, `papers progress PAPER_ID --step S`.
`tasks list` gives each task's ID and kind (tick, link or value). `get-my-projects` lists
the user's own papers, which is how you tell "own work" from someone else's.

## When to ask first

Run reads and ordinary edits straight away, then report what changed: weekly notes, checklist
tasks, paper stages, member fields, badges, settings, calendar entries, onboarding a person
the user named, creating tokens. Ask once, showing the exact command and the records (name,
ID) it affects, only before these:

| Risky action                                                                                           | Why                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Anything that messages people: `/run`, `/send`, `nudge`, `invite`, `chase`, `reminder`, `mailing-list` | Can't be unsent. Say who receives what. If pages.md marks it `(dry-run)`, show the preview first (it runs without `--live`). |
| Bulk changes (more than a handful of records in one go)                                                | Hard to undo.                                                                                                                |
| Deletes, merges, `auth tokens revoke-all`                                                              | Destructive.                                                                                                                 |
| Approving papers, allocating compute, rejecting projects                                               | The user decides these, always.                                                                                              |
| `proposals approve` / `proposals execute`                                                              | Approve needs the reviewed hash; never approve and execute together, never approve something the user hasn't read.           |

- "Just do it" covers everything except this table. For several risky actions, ask once
  for all of them together.
- Don't retry a failed write. If `details.may_have_applied` is true it may have succeeded:
  re-read state first.
- Exit 3 = not signed in (`hint: adminbot login`) or no permission. Don't route around a
  permission refusal: no impersonation, no other credentials. Sign-up approve/reject is
  head-professor-only (`adminbot whoami` shows who the user is).
- Exit 4 = conflict: someone else changed it; re-read, and ask only if the intent is unclear.
- Never guess an ID or pick between two similar records: ask.

## Workflow facts the routes don't tell you

- Approving a registration already enrolls the person and queues their onboarding guide.
  Don't also run a sheet onboard or onboarding invite for them; check
  `get-lab-members-by-members-id-onboarding-guide MEMBER_ID` first.
- Before a sheet onboard, run `post-membership-sheet-onboard-preview` with the same rows and
  show the result.
- "Nudge everyone missing weekly notes": read `get-papers-weekly-updates-pending`, show the
  names, and after a yes run `post-papers-weekly-updates-run`. It creates and executes a
  Slack nudge per person straight away (not a proposal waiting for approval), for exactly
  those not already asked this week. Report its `deliveries`: `unknown` means it may have
  sent, so don't rerun. For a custom message to chosen people,
  use `post-nudges-send` instead.
- Some checklist tasks are artifacts, not ticks (e.g. `slides`): `tasks update ... --link URL`
  completes them; there's no separate `--done`.
- The server is `https://admin.safe.eu`. Ignore older URLs in docs.

## Lab context (read before acting on people or policy)

- **Lab guidebook** (internal Google Doc; ask the user for the link if they want to read it).
  For policy questions (membership tiers, travel perks, meeting rules, who manages what), ask
  AdminBot's guidebook gate instead of guessing:
  `adminbot call post-guidebook-ask --question "..."`. It answers from Aurora's synced copy on
  a local model and returns prose, never the doc's text. Quote its answer, and if it says
  `answered: false` tell the user rather than inventing policy. Never paste guidebook text
  into a repo, issue, PR or message.
- **Live state, before a batch of work:**
  - `get-admin-queue-counts`: what's waiting
  - `get-proposals-pending`: pending approvals
  - `get-activity-updates`: recent changes
  - `get-papers-weekly-updates-pending`: missing weekly notes
  - `get-deadlines`: deadlines
  - `get-slack-channels`: Slack channels
  - `get-audit`: who changed what
- **Before messaging anyone,** read their member record and current onboarding or paper state, so
  you're not nudging someone who already did it.

## Things the token cannot do (tell the user to use the website)

Change the password or email, or impersonate. Everything else the user can do on the
website, the token can do, including creating tokens and approving another CLI login.

## Common mistakes

| Mistake                             | Fix                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| Assuming `--live` is the only guard | Few operations have dry runs (marked in pages.md). Messages send immediately. |
| Guessing the command name           | `adminbot operations \| grep WORD`, or pages.md, then `call OPERATION_ID`     |
| Approving a sign-up by name match   | List registrations, show the matching record(s), let the user confirm the ID  |
| pages.md seems out of date          | Update the CLI, then `adminbot skill install` again                           |
