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
