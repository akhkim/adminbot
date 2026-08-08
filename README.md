# AdminBot v2

AdminBot v2 is a contract-first rebuild of the lab administration system. It coordinates member
onboarding, communications, projects, papers, reimbursements, availability, reviewing, deadlines,
organization knowledge, public tools, and media publishing through one approval-gated control
plane.

The repository now contains the first working vertical slice: SQLite/Prisma persistence, anonymous
claim and signup submission, a loopback HTTP API, a static Lit registration UI, and a guarded
read-only-first legacy identity importer. Governance, login/session issuance, administrator review,
and the remaining workflow packs are not yet implemented.

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
- `packages/identity/`: registration validation, password hashing, and submission use cases.
- `apps/api/`: loopback HTTP composition and transport protections.
- `apps/web/`: static registration client and UI.
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

Generated OpenAPI and JSON Schema files are written under ignored `.generated/`; generated
TypeScript DTOs are written under ignored `packages/api-contracts/src/generated/`. The committed
TypeSpec files are authoritative.

## Local registration slice

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
