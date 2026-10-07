# Contributing to AdminBot

If you're joining AdminBot, start by using the part you want to improve. Try adding a paper, updating your profile, or finding a project. See where you get stuck. That gives us a much better starting point than adding a feature because it sounds useful.

I would rather we finish one useful change properly, including testing and review, before picking up five more things. Small fixes count. A confusing field or a button covering an error can stop someone from using the whole page.

## Get set up

The code is in [akhkim/adminbot](https://github.com/akhkim/adminbot). Ask for repository access if needed. Fork it if you don't have permission to push a branch, and open your PR against the lab repo's `main`.

Read the [root README](README.md), then the [app README](openclaw-adminbot/README.md) and the `AGENTS.md` files that apply to the area you're changing. The app README and `package.json` are the source of truth for setup commands and versions.

From a fresh checkout:

```bash
git clone https://github.com/akhkim/adminbot.git
cd adminbot
git switch -c fix/describe-your-change
cd openclaw-adminbot
corepack enable
pnpm install
pnpm build
```

The checked setup requires Node 22.19 or newer and pins pnpm 11.2.2. Run commands from `openclaw-adminbot/`, not the outer repository folder.

Install Git, Node and Corepack first if those commands are missing. Check `node --version` and `pnpm --version` before installing dependencies. GitHub CLI is optional; the GitHub website works for opening and reviewing PRs. If you cloned the lab repo but will push to your fork, add your fork as a separate remote and check `git remote -v` before pushing. Some inherited OpenClaw notes describe a different checkout's remotes.

For a fresh development environment without existing credentials:

```bash
node start-adminbot.mjs
```

Open `http://127.0.0.1:8765/adminbot`. The console and `/deadlines` should load. Protected routes returning `401` without a login is expected. This console is a different surface from the member-facing Control UI, which you can start in another terminal:

```bash
cd adminbot/openclaw-adminbot
pnpm ui:dev
```

Use the URL printed by the dev server. Authenticated member flows need a development session and suitable test data; ask for the approved setup for your feature.

One setup detail: the service launcher can load `~/.openclaw/.env`. If you already use OpenClaw, a local launch can pick up those credentials. Use a clean development environment before running jobs or testing integrations. Changing the port or state directory alone does not prevent that credential loading.

You don't need Aurora access or production tokens for a first code contribution. If a fix needs live verification, arrange that separately with the maintainer using your own access.

## Set up your coding agent

Use whichever coding assistant you already have access to. You don't need to install Harbor or Hermes to work on AdminBot. The contribution approach here borrows from that work: reproduce a real problem, make a focused fix and follow it through review.

For Codex, follow the [official CLI installation and sign-in instructions](https://learn.chatgpt.com/docs/codex/cli), then run `codex` from `adminbot/openclaw-adminbot`. In a desktop editor or agent app, open that same checkout. Your coding assistant's account is separate from AdminBot's model and integration credentials.

Before editing, have the agent read:

1. [Root instructions](AGENTS.md) and [app instructions](openclaw-adminbot/AGENTS.md).
2. [Code conventions](openclaw-adminbot/.ai-style-rules.md).
3. [Extension instructions](openclaw-adminbot/extensions/AGENTS.md) for backend work, or [UI instructions](openclaw-adminbot/ui/AGENTS.md) for frontend work, plus any nearer instructions.

Codex discovers instructions along the path to its working directory; see [AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md). Still ask it to read the instructions for deeper folders it will edit. Existing `CLAUDE.md` files in the app point to the corresponding `AGENTS.md` files. For other assistants, explicitly give them these paths. Keep shared instructions in the existing files instead of generating competing copies.

Start with this prompt, filling in the issue and expected behavior:

```text
Work on AdminBot issue <number or reproduction> in this checkout.
Read the applicable AGENTS.md files and .ai-style-rules.md first.
Check the current branch, uncommitted changes, and related issues/PRs.
Reproduce <actual behavior>. The expected behavior is <expected behavior>.
Trace the UI/API/service/store path and affected callers before editing.
Make the smallest complete fix using existing patterns.
Run focused regression tests and the required checks for this change.
For UI work, use the actual app in a browser and inspect desktop/mobile
screenshots with synthetic data. Report anything you cannot verify.
Keep credentials and live lab data out of the work. Do not send messages,
run live jobs or deploy as part of testing.
Finish with the diff summary, exact checks/results, and remaining limits.
```

Give the assistant access to the checkout, local commands and a browser when needed. Keep production credentials out of that development session. Browser tooling depends on your assistant; if it cannot operate the app, do the browser checks yourself and attach the evidence. A screenshot from an HTML mockup does not verify the real page.

## AdminBot's runtime agent and integrations

The coding assistant above edits the project. AdminBot's own agent runs inside the product and follows the service's proposal and approval flow.

For runtime work, start with the [environment example](openclaw-adminbot/.env.example), [sanitized configuration template](openclaw-setup/openclaw.example.json) and [AdminBot plugin documentation](openclaw-adminbot/extensions/adminbot/README.md). Configure only the feature you need in a clean development environment:

| What you're testing | Setup |
| --- | --- |
| Service routes and ordinary UI logic | No model key is required to boot; use synthetic fixtures for authenticated flows. |
| Agent replies | Configure a supported model provider, such as `NVIDIA_API_KEY`, or the local endpoint described in the app README. |
| Private reasoning or receipt extraction | Configure `ADMINBOT_LOCAL_BASE_URL`, `ADMINBOT_LOCAL_MODEL` and `VLLM_API_KEY` for the approved local model. |
| Slack, Google or other integrations | Use the relevant environment-example section and a maintainer-approved test account. These credentials are optional for unrelated development. |

The launcher reads `~/.openclaw/.env`; the CLI and batch scripts also have repo-local environment loading. Follow the entry point's documentation when setting variables. Do not assume copying `.env.example` configures a model or connects the Control UI to a working gateway.

AdminBot's existing workflow skills live in [extensions/adminbot/skills](openclaw-adminbot/extensions/adminbot/skills/). Read the [workflow router](openclaw-adminbot/extensions/adminbot/skills/adminbot-workflows/SKILL.md) and the relevant focused skill when changing agent behavior. Keep workflow guidance there, and authorization, validation and execution in code. These are product skills; they are not a required plugin pack for your coding assistant.

For an authenticated UI or agent session, use the approved development account and local service/gateway configuration. Missing access is a setup dependency to record, not a reason to copy production state or disable authentication. Use the [deployment runbook](openclaw-adminbot/AURORA-PUSH.md) only when deployment is part of the agreed task.

## Pick one problem

Search the [issues](https://github.com/akhkim/adminbot/issues) and [open and closed PRs](https://github.com/akhkim/adminbot/pulls?q=is%3Apr) before starting. Search the code too, since an issue can remain open after the behavior has changed.

Write down what you tried, what happened, and what should have happened. Include the page, input and error. Use made-up data when sharing a reproduction.

For example: “A long travel update runs outside its card on the Collaborate page. The full update should wrap inside the card on desktop and mobile.” That is enough to start investigating.

For a larger feature, agree on the user flow in the issue first. If someone already has a PR for it, help test or finish that work. Documentation fixes and reliable reproductions are useful contributions too.

## Find the right code

These paths are inside `openclaw-adminbot/`:

| Area | Start here |
| --- | --- |
| Member pages and interactions | `ui/src/ui/adminbot/` |
| Shared UI styles | `ui/src/styles/` |
| HTTP routes | `extensions/adminbot/src/api/` |
| Service rules and approvals | `extensions/adminbot/src/kernel/` |
| Saved data | `extensions/adminbot/src/persistence/` |
| Paper, member and other workflows | `extensions/adminbot/src/workflows/` |
| External integrations | `extensions/adminbot/src/connectors/` |
| Service startup | `extensions/adminbot/host/main.ts` |

Trace the actual flow before editing. If a paper doesn't appear after saving, check the request, response, stored record and refresh behavior. A success message by itself doesn't prove the paper was saved.

Reuse nearby components and helpers. Fix a shared cause in the shared code, and check its other callers. Keep unrelated cleanup out of the PR.

AdminBot is built on OpenClaw. Keep lab-specific changes in the AdminBot layer where possible. Read `docs/architecture.md` if the change crosses that boundary.

## Test the change as a user

For a logic fix, add a focused regression test that fails on the broken behavior. Run the relevant existing tests as well. For example, this runs an existing UI test file:

```bash
pnpm test ui/src/ui/adminbot/views/paper-overview.test.ts
```

Replace the path with the tests for your change. Run the repository's required checks, including a build when you change application code:

```bash
pnpm check:changed
pnpm build
```

Read the check output. Some checks report known baseline failures separately; an exit code alone is not enough to claim everything passed. If something also fails on unchanged `main`, say exactly what you compared. Don't dismiss a failure as pre-existing without checking.

For UI changes, open the real page and use it. Browser or computer-use testing is part of the work. Check the states your change affects:

- Normal use, empty results, loading and failed requests.
- Long titles, links and messages, plus narrow screens.
- Save, refresh and return to the page. Does the data stay?
- Repeated clicks or submissions. Do they create duplicates?
- Keyboard access, labels and visible validation errors.
- Member versus admin access when permissions are involved.

Compare the page with the rest of AdminBot. Match its spacing, alignment, colours and button styles. Use labels that explain the action. If a page can collect lots of requests or papers, check how someone finds the relevant item.

Take screenshots from the actual app with synthetic data. Show enough of the page to judge the layout, and inspect the images after adding them to the PR. Nothing should be clipped or covered. Label a component preview or mocked backend honestly, and list any live flow you couldn't test.

## If you use an AI coding agent

Use it to investigate, implement and test, but read the diff yourself. You should be able to explain why the fix works and what it doesn't cover.

Give the agent one bounded task, the relevant repo instructions and a way to reproduce the problem. Check its test claims against actual output. Look for unnecessary abstractions, unrelated edits, invented API behavior and tests that only repeat the implementation.

Keep real member data, receipts, credentials and private messages out of committed fixtures and screenshots. Preserve the service's authorization and approval checks. Hiding a button does not secure an API, and testing a feature is not permission to send real Slack messages or emails.

## Open the PR and follow through

Use a title that describes the result, such as “Wrap long travel updates in the Collaborate status card.” Keep the description short:

```text
Problem: What was broken, and how can someone reproduce it?
Change: What happens now?
Validation: Commands and results, plus browser flows checked.
Screenshots: Before/after for visible changes.
Limits: Anything untested, blocked or requiring deployment.
```

Link the issue. Check CI on the latest commit, address review comments and update the screenshots if the UI changes again. Reproduce automated review findings before accepting or rejecting them.

A draft PR is fine while work is incomplete or you need design input. Mark it ready when your implementation and verification are complete, and keep any external blockers visible.

After merge, say whether the change has been deployed and verified. The Control UI and Aurora service deploy separately, so a merged PR alone doesn't establish that the live workflow works.

If you're stuck, share the smallest reproduction, the exact error and what you've already checked. “The save request returns 200, but the item disappears after refresh” gives someone enough to help.

## Your first contribution

Get the app running, reproduce one issue and leave a clear note with the relevant code path. Then make the smallest complete fix and take it through testing and review. If setup itself is broken, documenting or fixing that is a useful first contribution.
