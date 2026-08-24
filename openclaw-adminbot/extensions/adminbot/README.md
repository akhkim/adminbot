# AdminBot

AdminBot exposes optional OpenClaw tools for a separate local AdminBot service.
OpenClaw can propose, list, approve, and execute typed actions, but the service
owns policy, approvals, connector scopes, idempotency, execution, and audit
logging.

The package includes an in-memory development service core and HTTP harness.
Without an executor it supports dry-run policy and approval testing only. The
provided startup scripts inject gog, social, Overleaf, and OpenClaw message executors so approved Gmail, Calendar, paper post, Overleaf edit, and Slack/message-shaped actions can run through their authenticated connector paths. Unsupported live action types fail closed instead of being recorded as executed.

For zero-setup durability, `createAdminBotSqliteService({ databasePath })`
creates a local SQLite ledger file automatically. Set `auditRetentionDays` to
prune old audit events while keeping the proposal, approval, execution, and
idempotency records needed for safety checks.

The same ledger also stores lab members, privilege-derived access profiles, and
paper pipeline records. Paper records track Brainstorming Docs, Overleaf,
submission, Google Drive PDF, arXiv polish, social posts, slides, poster links,
and reminder state. `adminbot_list_papers` adds an estimated Gantt-style timeline for each paper based on the current progress step. `adminbot_list_paper_nudges` reports author nudges and head-professor escalation after three business days without an author reply; `adminbot_propose_paper_nudge` turns that context into an approval-gated Slack reminder for Zhijing or the configured head professor.
New lab members default to `external_collaborator`, the least-privileged tier,
unless a level is provided.

The mock HTTP service serves a local management console at `/adminbot`. The
console can edit service settings, manage privilege levels, inspect the member
list, track active papers, view due nudges, review pending actions, and inspect
the audit log without adding a separate frontend build step. Keep that console
and the full OpenClaw Control UI behind Gateway authentication.

The mock HTTP service can use the same durable ledger:

```ts
createAdminBotMockService({
  databasePath: "state/adminbot.sqlite",
  auditRetentionDays: 30,
  executor: createGogAdminBotExecutor(),
});
```

Markdown remains the right place for standing orders, workflow notes, and
human-readable proposal exports. The ledger is intentionally tiny structured
state so approvals, payload hashes, and idempotency survive restarts without any
database setup.

Most AdminBot capabilities should be skills on top of this code surface. Skills
own the reimbursement, candidate, recommendation-letter, social, calendar,
email, PaperPublish, Slack, and form-classification workflows; the typed code
tools own connector boundaries, approval policy, execution, and audit records.

This plugin ships a bundled AdminBot skill pack from `skills/`. The
`adminbot-workflows` skill chooses the right feature skill, then focused skills
cover candidate decisions, join-form triage, reimbursements, access invites,
Slack management, recommendation letters, social posts, calendar/email, and
PaperPublish. The skills teach the workflow while approval and execution checks
stay in the service.

Run `openclaw setup` in the manual/custom flow to enable AdminBot, create a
dedicated `adminbot` agent, and optionally route unmatched Slack conversations
to that agent through the normal OpenClaw Slack channel. Setup also points
`openclaw dashboard` at the hosted Jinesis Control UI:
`https://jinesis-admin.vercel.app/`.

Manual plugin config:

```json
{
  "plugins": {
    "entries": {
      "adminbot": {
        "enabled": true,
        "config": {
          "serviceBaseUrl": "http://127.0.0.1:8765",
          "serviceTokenEnv": "ADMINBOT_SERVICE_TOKEN",
          "defaultDryRun": true
        }
      }
    }
  }
}
```

AdminBot setup uses `tools.profile: "minimal"`, denies the profile's remaining
`session_status` tool, and explicitly allows only `message` plus the `adminbot`
plugin tools. Google mutations run through the service-side gog executor, so the
agent does not need filesystem, shell, browser, session, automation, media, or
other general OpenClaw tools in its model context.

Keep vendor write tokens in the AdminBot service, not in OpenClaw prompts,
workspace files, or model-visible memory. The plugin refuses non-loopback
service URLs unless `allowInsecureRemoteService` is explicitly enabled.

## Layout

The package is grouped by **lifecycle role**, not by integration, and it uses the
vocabulary of the AdminBot v2 design (`ADMINBOT_V2_DESIGN.md` §16) so the two
trees can be read side by side — see
[ADR-0007](../../docs/adr/0007-adminbot-adopts-the-v2-taxonomy.md). A workflow
module turns a request into a typed proposal; a connector is the outbound adapter
that runs a proposal the service has already approved. That seam is deliberate —
see [ADR-0002](../../docs/adr/0002-adminbot-executors-features-seam.md), whose
`features/` and `executors/` are this tree's `workflows/` and `connectors/`.

### This directory ↔ the v2 design

`privacy/`, `kernel/`, `persistence/`, `api/`, `adapters/` and `connectors/`
mirror the v2 platform packages of the same name; the product-specific work lives
under `workflows/`, one directory per domain feature.

| Here                     | v2 §16                  | What lives here                                                                                          |
| ------------------------ | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/kernel/`            | `packages/kernel/`      | `service.ts` — propose → approve → execute → audit, policy, idempotency. Connector-agnostic.             |
| `src/persistence/`       | `packages/persistence/` | The two `AdminBotServiceStore` implementations: `memory.ts` and `sqlite.ts` (the durable ledger).        |
| `src/privacy/`           | `packages/privacy/`     | The redaction broker (`broker.ts`) and sensitive-term definitions (`sensitive-info-doc.ts`).             |
| `src/api/`               | `apps/api/`             | `server.ts` — the loopback service, routes and auth gates. `client.ts` — the plugin-side client.         |
| `src/adapters/openclaw/` | `adapters/openclaw/`    | The `adminbot_*` tool definitions the agent sees; thin wrappers over `api/client.ts`.                    |
| `src/connectors/`        | `connectors/`           | Outbound vendor adapters; `composite.ts` dispatches an approved proposal, unhandled types fail closed.   |
| `src/workflows/`         | `workflows/`            | One directory per domain feature. Proposals and read models only — never a connector call.               |
| `src/contracts/`         | (v1's own)              | The typed vocabulary both sides share: `actions.ts`, `tool-schemas.ts`. v2 generates this from TypeSpec. |
| `src/web/console/`       | (v1's own)              | The `/adminbot` admin console, one self-contained HTML string, no build step.                            |
| `content/`               | `content/`              | Reviewed org data and templates read at build/ops time, not service source.                              |
| `host/`                  | `apps/`                 | `main.ts`, the composition root — the store, connectors and injected cross-plugin deps, wired once.      |
| `skills/`                | —                       | 12 bundled agent skill packs declared by `openclaw.plugin.json`.                                         |

`index.ts` registers the plugin tools; `api.ts` is the package's public type and
factory surface.

### Where each workflow lives

| Workflow       | Directory                       | Executed by                        |
| -------------- | ------------------------------- | ---------------------------------- |
| Identity       | `src/workflows/identity/`       | `gog` (account-approved mail)      |
| Members        | `src/workflows/members/`        | `gog`, `message`                   |
| Papers         | `src/workflows/papers/`         | `openreview`, `overleaf`, `social` |
| Reimbursements | `src/workflows/reimbursements/` | `gog`, `message`                   |
| Calendar       | `src/workflows/calendar/`       | `gog`                              |
| Deadlines      | `src/workflows/deadlines/`      | `message` (reminder DMs)           |
| Onboarding     | `src/workflows/onboarding/`     | `gog`, `message`                   |

- **`identity/`** — member sessions, device-pairing scopes, account-approved mail.
  v2 splits this into a platform `identity` package; here it is still a workflow
  pack because it also owns the approval-mail proposal.
- **`members/`** — lab roster, applicant sheet, availability, collaborator subgroups.
- **`papers/`** — the paper pipeline: OpenReview cadence/matching/workflow,
  Overleaf edits, social posts.
- **`reimbursements/`** — reimbursement intake and workflow.
- **`calendar/`** — the calendar source and read model behind holds and invites.
- **`deadlines/`** — the deadline board and venue read model. `board.ts` and
  `generated/dataset.ts` are **generated from `content/deadlines/`** — do not
  hand-edit them; regenerate with `scripts/adminbot-deadline-*.py`.
- **`onboarding/`** — guide/invite/workspace sends and the tier email copy
  (`emails.ts`).

An integration appearing under both `workflows/papers/` and `connectors/`
(`openreview`, `overleaf`, `social`) is the seam working as intended:
proposal-generation on one side, execution on the other, the approval gate in
between.

### `content/` (reviewed assets, not service source)

| Directory                    | Role                                                                                                                                                                                                                                  | Pairs with                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `content/deadlines/`         | The canonical deadline dataset and board assets (`venues.json`, `dm-templates.json`, `deadlines-board.html`), refreshed by `scripts/adminbot-deadline-*.py`. Read by Python and shell as well as by TypeScript. | `src/workflows/deadlines/`  |
| `content/onboarding-emails/` | Review notes only. The copy itself was folded into `src/workflows/onboarding/emails.ts` so a string ships with the service instead of being read off disk; the README keeps the decisions behind the copy.                            | `src/workflows/onboarding/` |
