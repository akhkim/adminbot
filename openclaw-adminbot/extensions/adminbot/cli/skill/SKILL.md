---
name: adminbot-cli
description: Use when the user asks to do anything in AdminBot (admin.safe.eu) — members, sign-ups, onboarding, papers, weekly notes, checklist tasks, badges, calendar, meetings, deadlines, nudges, mailing list, logistics, approvals — or mentions the adminbot CLI, an AdminBot page, or acting with their AdminBot access.
---

# AdminBot CLI

## Overview

The `adminbot` CLI calls every route the website uses (324 operations, generated from the
server's route table), signed in as the user with a personal API token. Same rights as the
user on the website, same server checks. **The CLI acts on the live lab with real people:
reads are free, every change needs the user's yes.**

## Setup

`command -v adminbot` must succeed. If it doesn't, stop and point the user to the CLI's
README to install it; don't improvise another client. `operations` and `schema` are offline. Everything else contacts the server. Start with
`adminbot auth whoami`; exit 3 means you're not signed in.

API tokens are for admins by default. If the user isn't an admin, sign-in approval
is refused; tell them to use the website.

Not signed in → run `adminbot auth login --no-browser`, show the user the printed link and
code, and wait. **The user approves in their browser with their password. Never ask for,
type, pipe or store their password, and never print, copy or echo the token.** Do not use
`--email --password-stdin`. Never call `auth tokens revoke-all` or `auth logout` unless asked.

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

## Rules for changes (anything that is not GET)

| Kind                                                                                                                        | What to do                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET, plus `post-guidebook-ask` and `*-preview` operations (they only read)                                                  | Run freely. Summarise; don't dump private member data into chat beyond what's needed.                                                                                              |
| Edits to the user's own work (weekly note, own checklist task, own paper stage) when the user asked for exactly that        | Run it, then report what changed.                                                                                                                                                  |
| Anything else that writes: approve/reject, onboard, create/edit/delete/merge members, badges, settings, calendar, proposals | Show the exact command and the record it affects (name, ID). Run only after the user says yes **to that action**.                                                                  |
| Anything that messages people: `/run`, `/send`, `nudge`, `invite`, `chase`, `reminder`, `mailing-list`, onboard             | Same, plus say who receives what. **Most of these have no dry run and send immediately.** If it lists `(dry-run)` in pages.md, run it without `--live` first and show the preview. |

- "Be quick" / "just do it" in the request covers the reads, not the writes. A request to
  "approve X and onboard Y" is permission to _prepare_ both; still confirm each write once,
  together in one message, before running any of them.
- Proposals: `proposals approve` needs the reviewed hash and `proposals execute` is
  separate. Never approve and execute in one go, and never approve something the user has
  not read.
- No retries on a failed write. Exit 1 after a timeout may have succeeded: re-read state first.
- Exit 3 = permission. Don't route around it (no impersonation, no other credentials).
  Sign-up approve/reject is head-professor-only. If the user is not the head professor,
  don't try it: tell them it needs the professor (`auth whoami` shows who they are).
- Exit 4 = conflict: someone else changed it; re-read and ask.

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

Create/approve tokens or CLI sign-ins, change password or email, impersonate, pair devices.

## Common mistakes

| Mistake                             | Fix                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| Assuming `--live` is the only guard | Few operations have dry runs (marked in pages.md). Ask first for every write. |
| Guessing the command name           | `adminbot operations \| grep WORD`, or pages.md, then `call OPERATION_ID`     |
| Approving a sign-up by name match   | List registrations, show the matching record(s), let the user confirm the ID  |
| pages.md seems out of date          | Update the CLI, then `adminbot skill install` again                           |
