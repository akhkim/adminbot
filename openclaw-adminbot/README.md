# AdminBot

AdminBot runs the lab's administrative work — members, papers, reimbursements,
recommendation letters, calendar and email, Slack, and social posts — behind a human
approval gate.

It is a fork of [OpenClaw](https://github.com/openclaw/openclaw), an extensible multi-channel
AI gateway. The gateway, agent runtime and Control UI are inherited; everything AdminBot-specific
lives in `extensions/adminbot/`, `ui/src/ui/adminbot/`, `scripts/adminbot-*` and `deploy/aurora/`.

## How it works

The agent **proposes; it never acts.** A separate loopback HTTP service on `127.0.0.1:8765`
(override with `ADMINBOT_PORT`) owns
policy, approval, connector scopes, idempotency, execution and audit. Every external effect is one
of 33 typed action types that goes through the same pipeline:

```
agent proposes  ->  human approves (by payload hash)  ->  service executes  ->  audit
```

An action type with no executor **fails closed** — it is never recorded as executed. The model
itself runs with `tools.profile: "minimal"`: no shell, no filesystem, no browser.

## Layout

```
extensions/adminbot/          the product
  host/main.ts                service composition root (both launchers use it)
  src/contracts/              the 33 action types and their tool schemas
  src/kernel/                 propose -> approve -> execute -> audit
  src/persistence/            the in-memory store and the SQLite ledger (state/adminbot.sqlite)
  src/privacy/                the redaction broker every payload crosses
  src/api/                    the loopback service and its typed client
  src/workflows/              identity, members, reimbursements, papers, onboarding,
                              deadlines, calendar -- proposals only, never a vendor call
  src/connectors/             gog (Gmail/Calendar), message (Slack), social,
                              overleaf, openreview, and the composite that fans out
  src/adapters/openclaw/      the tool handlers the agent sees
  src/web/console/            the server-rendered admin console at /adminbot
  content/                    reviewed datasets and templates (deadlines, onboarding emails)
  skills/                     12 skill packs; adminbot-workflows is the router

ui/src/ui/adminbot/           the member-facing Control UI surfaces
scripts/adminbot-*            cron and batch jobs (deadlines, OpenReview, email, references)
deploy/aurora/                the Aurora host bootstrap
src/, packages/, ui/          inherited OpenClaw gateway, agent runtime and Control UI
```

The product tree uses the AdminBot v2 design's vocabulary — `workflows/`, `connectors/`,
`adapters/`, `kernel/`, `persistence/`, `privacy/`, `api/`, `content/` — so the two trees read
the same way ([ADR-0007](docs/adr/0007-adminbot-adopts-the-v2-taxonomy.md)).

[docs/architecture.md](docs/architecture.md) maps the inherited `src/` tree, the request
lifecycle and the check lanes, and answers "where do I put this?" for the common changes.

## Surfaces

| Surface                 | Who sees it                                                   | Where                            |
| ----------------------- | ------------------------------------------------------------- | -------------------------------- |
| Control UI              | anonymous, member, admin — see `ui/src/ui/adminbot/access.ts` | https://jinesis-admin.vercel.app |
| `/adminbot` console     | operators, behind the service                                 | `src/web/console/`               |
| Slack                   | the lab                                                       | `src/connectors/message.ts`      |
| Email (Gmail via `gog`) | applicants, members, external                                 | `src/connectors/gog.ts`          |

The Control UI's access table is a **visibility contract, not a security boundary**: the service
re-checks every privileged route against the authenticated session, and the gateway enforces device
scopes derived from the member's privilege level.

## Run locally

From a fresh clone to a service answering requests, with **no credentials at all**. Requires
**Node 22.19+** and **pnpm 11.2.2** (the version pinned in `packageManager`; `corepack enable`
picks it up automatically).

```bash
git clone <this repo> openclaw-adminbot && cd openclaw-adminbot
pnpm install               # ~2.5 min cold. CI=true makes it lockfile-strict; not otherwise needed
pnpm build                 # ~45 s; must produce dist/extensions/adminbot/api.js
cp .env.example .env       # ship it unedited — nothing in it is required to boot
node start-adminbot.mjs    # service on http://127.0.0.1:8765
```

**Minimum edits to `.env`: none.** Every variable is commented out or blank, and the service
starts, creates `state/adminbot.sqlite` itself, and serves. If port 8765 is already taken (an
existing deployment, a second checkout), set `ADMINBOT_PORT` in `.env` or pass it inline:

```bash
ADMINBOT_PORT=8801 node start-adminbot.mjs
```

To keep a test run away from an existing OpenClaw install, point its state elsewhere:

```bash
OPENCLAW_STATE_DIR=/tmp/adminbot-state \
OPENCLAW_CONFIG_PATH=/tmp/adminbot-state/openclaw.json \
ADMINBOT_PORT=8801 node start-adminbot.mjs
```

### What you get with zero credentials

Open **http://127.0.0.1:8765/adminbot** — the server-rendered operator console. It renders, and
the deadline board at `/deadlines` serves the bundled conference dataset. Every privileged route
(`/lab/members`, `/settings`, `/audit`, …) answers **401**, because no one is signed in yet. The
propose → approve → execute → audit pipeline is fully live against the local SQLite ledger; what a
credential buys is the ability to _execute_ an approved action against the outside world.

| To get                                   | Set                                                               | `.env.example` group  |
| ---------------------------------------- | ----------------------------------------------------------------- | --------------------- |
| Agent replies at all                     | `NVIDIA_API_KEY`, or a local endpoint                             | Models / Local tunnel |
| Private tasks + receipt extraction       | `ADMINBOT_LOCAL_BASE_URL`, `ADMINBOT_LOCAL_MODEL`, `VLLM_API_KEY` | Local model tunnel    |
| Slack sends and Slack Connect invites    | `SLACK_BOT_TOKEN` (+ `SLACK_APP_TOKEN` to receive)                | Slack                 |
| Outbound email and calendar writes       | `GOG_ACCOUNT`, `GOG_KEYRING_PASSWORD` + the `gog`/`gws` CLIs      | Google                |
| Member browsers issued a gateway token   | `OPENCLAW_GATEWAY_TOKEN`                                          | OpenClaw gateway      |
| The cron/batch jobs to reach the service | `ADMINBOT_SERVICE_TOKEN`                                          | Service               |
| Overleaf / LinkedIn / X / OpenReview     | the matching `*_ACCESS_TOKEN` / `OPENREVIEW_*`                    | Optional integrations |

[.env.example](.env.example) carries all of them, grouped, with a one-line note on what breaks
without each.

### Other entry points

```bash
pnpm adminbot              # same as `node start-adminbot.mjs`
pnpm adminbot:dev          # from source, no build step (no Slack Connect invite in this mode)
pnpm ui:dev                # the member-facing Control UI
```

The agent needs a model. A box with no local vLLM can forward `127.0.0.1:8000` to a remote vLLM
host with `pnpm adminbot:tunnel`.

Operations have their own scripts: `adminbot:email`, `adminbot:openreview`,
`adminbot:deadlines:collect`, `adminbot:references`, `adminbot:roster-sync`. Each needs the
credentials for the system it touches, and most need `ADMINBOT_SERVICE_TOKEN`.

### Running the real deployment

A cred-less clone is a working service, not the lab's service. Reproducing the live deployment
additionally needs private files that are deliberately **not** in this repo — the populated `.env`,
the Google OAuth `client_secret*.json` behind the `gog`/`gws` CLIs, the `~/.openclaw` state and
credential store, and the operator's `openclaw.json`. Ask the operator for that handoff list; none
of it is required for anything above.

[docs/fresh-clone-check.md](docs/fresh-clone-check.md) records the last verified run of exactly the
commands in this section.

## Deploying

The Control UI deploys to Vercel from the lab repo. The service deploys to Aurora with
`pnpm aurora:deploy`, which needs the CS VPN and a password for the deploy host named by
`AURORA_HOST`. See
[AURORA-PUSH.md](AURORA-PUSH.md) for the full runbook and
[docs/deploy/](docs/deploy/) for host setup.

## Docs

- [docs/tools/adminbot.md](docs/tools/adminbot.md) — service endpoint contract and the privacy gate
- [docs/tools/adminbot-deadlines.md](docs/tools/adminbot-deadlines.md) — the venue/CFP tracker
- [docs/tools/adminbot-openreview.md](docs/tools/adminbot-openreview.md) — reviewing-cycle reminders
- [docs/tools/adminbot-reference-check.md](docs/tools/adminbot-reference-check.md) — citation verification
- [docs/tools/adminbot-meetings.md](docs/tools/adminbot-meetings.md) — recorded meetings: links, attendance, summaries
- [extensions/adminbot/README.md](extensions/adminbot/README.md) — the propose/approve/execute contract in detail

## Licence

MIT, inherited from OpenClaw. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
