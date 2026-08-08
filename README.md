# AdminBot v2

AdminBot v2 is a contract-first rebuild of the lab administration system. It coordinates member
onboarding, communications, projects, papers, reimbursements, availability, reviewing, deadlines,
organization knowledge, public tools, and media publishing through one approval-gated control
plane.

The repository now contains the first working identity slice: SQLite/Prisma persistence, anonymous
claim and signup submission, password login and secure session lifecycle, administrator
registration review, a loopback HTTP API, a standalone dark-mode Lit application shell, and a
guarded read-only-first legacy identity importer. The public deadline board, authenticated paper
workspace, authenticated member roster/profile editor, member-owned availability planner, and
local-only reimbursement assistant are also connected; unfinished legacy surfaces remain visibly
marked, inert previews.

## Current contents

- `ADMINBOT_V2_DESIGN.md`: complete product, security, architecture, migration, and workflow design.
- `spec/common/`: shared language-neutral identifiers and error envelopes.
- `spec/platform/`: identity, authorization, policy, governance, privacy, connector, automation,
  supporting-service, and HTTP interfaces.
- `spec/workflows/`: domain records, commands, action payloads, and projections for each workflow
  family.
- `tspconfig.yaml`: generates OpenAPI 3.1 and JSON Schema from TypeSpec.
- `packages/api-contracts/`: generated TypeScript DTO facade plus centralized `/v0alpha` routes.
- `packages/ports/`: shared repository and transaction contracts.
- `packages/persistence/`: the sole Prisma schema/client/migration and repository implementation.
- `packages/identity/`: registration, password login, session, and administrator-review use cases.
- `packages/members/`: authenticated roster projections, self-owned profile updates, and
  recently-authenticated administrator governance updates.
- `packages/reimbursements/`: bounded receipt validation, local-model intake, and versioned form
  generation with institution templates.
- `packages/availability/`: privacy-aware capacity projections and version-checked plan replacement.
- `apps/api/`: loopback HTTP composition and transport protections.
- `apps/web/`: standalone shell, theme, access, sign-in/session, and registration-review clients.
- `apps/migrate/`: exact-fingerprint v1 SQLite reader and transactional identity importer.
- `.legacy-reference/`: ignored local reference copy of the pre-v2 implementation. It is not part
  of commits and may be absent in a fresh clone; the previous implementation remains in Git
  history.

TypeSpec is the source of truth for data that crosses an API, queue, workflow, connector, or client
boundary. The current contracts are `v0alpha` design hypotheses: owners may add missing contracts,
change shapes when implementation evidence demands it, and remove superfluous definitions. Shared
changes must be coordinated, but no current field is frozen merely because it appears in TypeSpec.
Generated artifacts are disposable and must not be edited manually. Behavioral code remains
implementation-language-specific and consumes generated contract types.

## Contract development

Requirements: Node 22.19+ and Corepack.

```bash
corepack pnpm install
corepack pnpm check
corepack pnpm test
corepack pnpm web:build
```

For terminal-friendly build output, run `corepack pnpm build:interactive`. The regular
`corepack pnpm build` command keeps plain output suitable for CI logs.

Generated OpenAPI and JSON Schema files are written under ignored `.generated/`; generated
TypeScript DTOs are written under ignored `packages/api-contracts/src/generated/`. The committed
TypeSpec files are authoritative.

## Local identity slice

Copy `.env.example` to ignored `.env`, choose a durable organization UUID, and replace the identity
key placeholder. Apply committed migrations before starting the API:

```bash
corepack pnpm build
corepack pnpm db:migrate:deploy
node --env-file=.env apps/api/dist/main.js
corepack pnpm --filter @adminbot/web dev
```

The web development server proxies the centralized `/v0alpha` base to the loopback API. Configure
`ADMINBOT_WEB_ORIGINS` with the exact browser origin; origin checks and server-side authorization
remain authoritative.

Reimbursement extraction and form generation use a small Python helper. Install its isolated
dependencies before enabling that public surface, and keep the configured model endpoint on
loopback:

```bash
python3 -m venv .venv-reimbursements
. .venv-reimbursements/bin/activate
python -m pip install -r packages/reimbursements/requirements.txt
```

Set `ADMINBOT_REIMBURSEMENT_PYTHON` to that environment's Python executable when the API itself is
not launched from the activated environment. Receipt bytes and conversation drafts are transient;
only a keyed, address-scoped abuse-control counter is persisted. Packet generation downloads two
files and never submits them to an institution.

The legacy identity importer is dry-run by default and requires absolute paths. Apply additionally
requires `--apply --invalidate-legacy-sessions`; it never turns v1 sessions into live v2 sessions.
See section 18 of `ADMINBOT_V2_DESIGN.md` before running it.

## Architectural boundary

OpenClaw, web clients, and automation may query data and propose typed actions. Only the AdminBot
governance path may authorize and queue an external mutation, and only an operation-scoped worker
may obtain vendor credentials and execute it. Approvals are bound to the exact immutable payload
and hash. Privacy routing, permissions, and policy are server-side controls rather than prompt or UI
conventions.

See `ADMINBOT_V2_DESIGN.md` before implementing any service or workflow.
