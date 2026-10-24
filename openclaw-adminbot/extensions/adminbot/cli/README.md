# AdminBot CLI and generated SDK

The CLI discovers operations, parameters, flags, and validation schemas from the
packaged OpenAPI document. There is no handwritten endpoint or input-schema table.
A small alias file provides readable work/task commands; aliases contain only
operation IDs and alternate flag names.

## Install and use

Requires Node 22.19+. From `openclaw-adminbot/`:

```bash
pnpm install --frozen-lockfile
npm install --global ./extensions/adminbot/cli
adminbot --help
adminbot operations
adminbot papers list
```

Or use `pnpm adminbot:cli --help` without installation. The package is private and
unpublished. `npm pack ./extensions/adminbot/cli` creates an internal distribution
containing the runtime, spec, and generated SDK declarations.

The default API origin is `https://admin.safe.eu`. Use `--url ORIGIN` or
`ADMINBOT_URL` for another deployment; the flag wins. Local services can use
`http://127.0.0.1:8765`. Remote services require HTTPS. Redirects are refused.
The deployed server must match the packaged contract: the new paper-progress PATCH
and `/openapi.json` require deploying the backend changes in this repository.

## Authenticate

```bash
# Pipe the password from your password manager; never put it in process arguments.
password-manager-command | adminbot auth login --email member@example.test --password-stdin
adminbot auth whoami
adminbot auth logout
```

`password-manager-command` is a placeholder for your own password retrieval tool.
Login needs an approved account. Sessions are saved atomically with mode `0600` at
`~/.config/adminbot/credentials.json`, or `ADMINBOT_CREDENTIALS_FILE`. A saved session
is bound to the exact service origin and port. Expired sessions require login again.
`ADMINBOT_TOKEN` overrides the saved session. Service tokens retain the service
principal's existing restrictions, including the inability to approve or execute.
Login output omits the password/session token. Logout revokes the active member
session and removes its matching saved credentials after a successful response.

## Work and paper progress

```bash
adminbot work list
adminbot tasks list PAPER_ID
adminbot work update PAPER_ID --note "Finished experiments"
adminbot work history PAPER_ID
adminbot tasks update PAPER_ID fixes_merged --done
adminbot tasks update PAPER_ID fixes_merged --pending
adminbot tasks update PAPER_ID slides --link https://example.test/slides
adminbot tasks update PAPER_ID submission_id --value submission-123
adminbot papers progress PAPER_ID --step overleaf_writing
```

Work uses the existing project/paper checklist and weekly-note model. Notes replace
your entry for that paper and week; `--week YYYY-MM-DD` selects a week explicitly.
Task IDs and their expected values come from the checklist read. Boolean tasks use
`--done`/`--pending`; artifact tasks need links or values. Checklist evidence lets the
service recompute the stage. Explicit stage edits use a narrow PATCH on the server,
so the CLI never fetches and resends author identities or titles.

Progress writes save immediately. They use existing server ownership and permission
checks; they do not send messages or modify vendor documents.

## All API operations, without writing wrappers

```bash
adminbot operations
adminbot call get-badges
adminbot call get-proposals-pending --limit 10
adminbot schema patch-papers-by-papers-id-progress
adminbot tasks update --help
```

`operations` lists every documented operation ID and its generated command name.
Generated names come from the HTTP method and path; `call OPERATION_ID` is always
available even if two routes have ambiguous readable names. `--help` is generated
from each operation's path/query/header parameters and JSON request properties.

Properties become kebab-case flags. Arrays accept repeated flags. Booleans support
`--field` and `--no-field`. Nested or dynamic input uses `--set FIELD.PATH=VALUE`;
values are parsed as JSON when possible, otherwise as strings. Dynamic query filters
can use `--query NAME=VALUE` when an existing handler forwards them to its service. JSON files remain
optional: `--file PATH` or `--file -`. Do not mix files and body flags. Password/token
fields are supplied through stdin/files rather than process arguments.

```bash
adminbot proposals create --type email.send --summary "Draft reminder" \
  --set proposed_payload.to=recipient@example.test \
  --set proposed_payload.subject=Reminder \
  --set 'proposed_payload.body=Our meeting starts at 10:00.'
adminbot proposals approve ACTION_ID --hash REVIEWED_PAYLOAD_HASH
adminbot proposals execute ACTION_ID
adminbot proposals execute ACTION_ID --live --idempotency-key UNIQUE_EXECUTION_KEY
```

For operations exposing `dry_run`, the CLI forces it true unless `--live` is explicit,
even when a file requests false. Creation and execution have independent flags.
Approval identities, exact-hash checks, quorum, policy, execution, connector failure,
and idempotency stay in the service. No retries occur automatically; inspect state
after a timeout before repeating a mutation. The CLI never chains approval/execution.

JSON responses go to stdout; structured errors go to stderr. `--json` is accepted
for agent consistency. Text responses remain text. Binary responses require
`--output PATH`, which writes with private permissions when creating a file.
`--timeout MS` accepts 1–300000 milliseconds (default 30000).

| Exit | Meaning                                     |
| ---- | ------------------------------------------- |
| 0    | Success                                     |
| 1    | Service, policy, network, or response error |
| 2    | Invalid input or local CLI error            |
| 3    | Authentication or permission failure        |
| 4    | HTTP conflict                               |

## Contract and generation

```text
Route table (src/api/routes) + remaining dispatchers + TypeScript contracts
  → tooling/generate-openapi.ts
  → cli/openapi.generated.json          (the one contract file)
      → GET /openapi.json (authenticated)
      → generic CLI (openapi-fetch + Ajv)
      → openapi-typescript → openapi.generated.d.ts → typed SDK
```

From the workspace root:

```bash
pnpm adminbot:api:generate
pnpm adminbot:api:check
pnpm adminbot:api:test
pnpm --filter @adminbot/cli test
pnpm --filter @adminbot/cli check:types
pnpm test extensions/adminbot/src/api/server.openapi.test.ts
```

`adminbot:api:check` fails when the committed contract or SDK types are stale. It runs in
the **AdminBot API** workflow (`.github/workflows/adminbot-api.yaml`), only for changes under
`src/api`, `src/contracts`, `cli` or `tooling` -- never in `pnpm build`, so a stale contract
cannot stop a deploy. Regenerate after changing a route or a contract type, and commit the
result; do not edit generated files.

The output depends on the API alone: no source line numbers and no hash of the source tree,
so a comment or an unrelated refactor leaves it byte-identical. The generator reads route-table
entries directly (seeing through guard decorators to the handler) and walks the remaining
if-chains -- the public and auth dispatchers, and the sub-routers a `"*"`, `under()` or
`startingWith()` entry delegates to. A selector it does not understand fails generation.

Legacy handlers accepting dynamic records are marked with `x-schema-coverage`;
their semantic validators remain authoritative. A downstream cast or normalized
parser result is not treated as proof of required input fields. The service does not
validate requests against the contract -- its handlers validate their own input and say
what was wrong; the CLI validates against the contract before sending. OpenAPI documents
the current implementation; it does not replace approval or privacy policy with client checks.

SDK consumers use the same document and generated types:

```ts
import { createAdminBotClient } from "@adminbot/cli/client";
const api = createAdminBotClient({
  baseUrl: "https://admin.safe.eu",
  headers: { Authorization: `Bearer ${process.env.ADMINBOT_TOKEN}` },
});
await api.GET("/papers");
```

Tests cover automatic route/type discovery, input serialization, auth storage,
redirect refusal, error propagation, and real local-service login/progress updates.
No live external mutation is performed by the test suite.
