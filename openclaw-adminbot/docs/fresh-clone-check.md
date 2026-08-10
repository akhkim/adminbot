# Fresh-clone check

Proof that the "Run locally" section of [README.md](../README.md) is complete: a clone of this
repo, following only those commands, reaches a service answering requests **with no credentials
and no private files**. Re-run this whenever the boot path, `.env.example` or the README section
changes.

Last run: **2026-08-08**, at the commit that carries this line —
`chore: move workspace identifiers and infra endpoints out of the tracked tree` — on Linux 6.18
(WSL2), Node v22.22.1, pnpm 11.2.2. (The hash is not quoted because recording it would change it;
the tree that was cloned and booted differs from this commit by this paragraph alone.)

Re-verified **2026-08-08** at `refactor(adminbot): adopt the v2 taxonomy for the product tree`,
which renamed the product tree onto the v2 vocabulary
([ADR-0007](adr/0007-adminbot-adopts-the-v2-taxonomy.md)). Not a re-clone — a `pnpm build` plus a
boot of the working tree with `.env.example` unedited, on `ADMINBOT_PORT=8799`. `pnpm build`
exited 0 in 74 s and produced `dist/extensions/adminbot/api.js`; the five status codes below are
unchanged (`/adminbot` 200, `/deadlines` 200, `/lab/members` 401, `/settings` 401, `/audit` 401).
The rename touched no boot path: `host/main.ts` is still the composition root and still resolves
its modules from `dist/`, only under the new directory names.

That change moved the workspace identifiers and infra endpoints out of the tracked tree into
environment variables. Every status code below is unchanged, as expected: none of the scrubbed
values is read on the boot path — each one gates a single feature and is resolved at its use site,
so a `.env.example` with all of them commented out boots exactly as before.

## What was run

Exactly the README sequence, into a scratch directory outside the repo:

```bash
git clone <repo> clone-test && cd clone-test
git checkout refactor/navigable-structure
pnpm install
pnpm build
cp .env.example .env        # shipped as-is, zero edits
ADMINBOT_PORT=8803 node start-adminbot.mjs
```

`ADMINBOT_PORT` is the one deviation, and it is documented: the box already runs the live service
on 8765. The state overrides below are belt-and-braces isolation, not a requirement.

## Result

| Step                              | Result                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm install`                    | exit 0, 2.2 s warm (800 packages, lockfile up to date, no prompts)                       |
| `pnpm build`                      | exit 0 in 48.3 s; `dist/extensions/adminbot/api.js` present                              |
| `cp .env.example .env`            | 0 populated assignments — the only uncommented line is a blank `OPENCLAW_GATEWAY_TOKEN=` |
| `node start-adminbot.mjs`         | listening within ~1 s; no error, no warning beyond node's SQLite experimental notice     |
| `state/adminbot.sqlite`           | created by the service on first boot; `state/` is not in the clone                       |
| `/adminbot`                       | 200                                                                                      |
| `/deadlines`                      | 200                                                                                      |
| `/lab/members`                    | 401                                                                                      |
| `/settings`                       | 401                                                                                      |
| `/audit`                          | 401                                                                                      |
| still alive and serving at t+65 s | yes, identical status codes, no new log output                                           |

Startup log, in full:

```
AdminBot NVIDIA NIM configured: no
(node:…) ExperimentalWarning: SQLite is an experimental feature and might change at any time
AdminBot service with live gog/social/overleaf/message/openreview execution running on http://127.0.0.1:8803
```

## Why the run was environment-isolated

`startAdminBotHost` calls `loadOpenClawEnv()`, which loads `~/.openclaw/.env` when one exists. On
the operator's own box that file is populated, so a naive clone test inherits real credentials and
proves nothing about a fresh machine — the first attempt logged `NVIDIA NIM configured: yes` for
exactly that reason. The recorded run therefore starts from an empty environment and a scratch
home:

```bash
env -i PATH=/usr/bin:/bin HOME=<scratch>/fakehome \
  OPENCLAW_STATE_DIR=<scratch>/state \
  OPENCLAW_CONFIG_PATH=<scratch>/state/openclaw.json \
  ADMINBOT_PORT=8803 node start-adminbot.mjs
```

Both runs produced the same five status codes. The only difference is the NIM line, which is the
intended report of a missing optional credential, not a failure.

## What this does not prove

- **Nothing about the agent.** With no model key and no local vLLM the service serves and audits;
  it cannot generate a reply. That is degradation, not breakage, and it is what the README's
  credential table describes.
- **Nothing about outbound effects.** Every executor that reaches Slack, Gmail, Calendar,
  Overleaf, OpenReview or a social network needs its own credential and fails at execution time
  without one. Actions still propose, approve and audit correctly.
- **Nothing about a cold pnpm store.** The 2.2 s install reused this box's warm store. A genuinely
  cold machine downloads ~800 packages; budget minutes, not seconds.
