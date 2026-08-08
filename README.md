# AdminBot v2

AdminBot v2 is a contract-first rebuild of the lab administration system. It coordinates member
onboarding, communications, projects, papers, reimbursements, availability, reviewing, deadlines,
organization knowledge, public tools, and media publishing through one approval-gated control
plane.

The repository is currently in the interface-definition phase. It contains no production service
implementation yet.

## Current contents

- `ADMINBOT_V2_DESIGN.md`: complete product, security, architecture, migration, and workflow design.
- `spec/common/`: shared language-neutral identifiers and error envelopes.
- `spec/platform/`: identity, authorization, policy, governance, privacy, connector, automation,
  supporting-service, and HTTP interfaces.
- `spec/workflows/`: domain records, commands, action payloads, and projections for each workflow
  family.
- `tspconfig.yaml`: generates OpenAPI 3.1 and JSON Schema from TypeSpec.
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
corepack pnpm contracts:check
corepack pnpm contracts:generate
```

Generated OpenAPI and JSON Schema files are written under ignored `.generated/`. The committed
TypeSpec files are authoritative.

## Architectural boundary

OpenClaw, web clients, and automation may query data and propose typed actions. Only the AdminBot
governance path may authorize and queue an external mutation, and only an operation-scoped worker
may obtain vendor credentials and execute it. Approvals are bound to the exact immutable payload
and hash. Privacy routing, permissions, and policy are server-side controls rather than prompt or UI
conventions.

See `ADMINBOT_V2_DESIGN.md` before implementing any service or workflow.
