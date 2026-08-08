# AGENTS.md

This repository is the contract-first AdminBot v2 rebuild. The active tree contains the design and
language-neutral interfaces; production service code has not been implemented yet.

## Read instructions in scope

- This file applies to the whole repository.
- Read `ADMINBOT_V2_DESIGN.md` before changing contracts or adding implementation code.
- `.legacy-reference/` is a local, ignored, read-only reference copy of v1. Never import it from v2,
  edit it as part of v2 work, or commit its generated/runtime files.
- The previous implementation remains recoverable from Git history if the local reference directory
  is unavailable.

## Repository map

- `spec/common/`: identifiers, shared values, paging, and stable errors.
- `spec/platform/`: cross-cutting service, governance, privacy, connector, automation, and API
  contracts.
- `spec/workflows/`: workflow-owned domain, command, action, and projection contracts.
- `.generated/`: ignored OpenAPI and JSON Schema output; never edit or commit it.
- `ADMINBOT_V2_DESIGN.md`: canonical product and architecture specification.
- `.legacy-reference/openclaw-adminbot/`: local v1 code for migration evidence only.

## Contract rules

- TypeSpec is authoritative for data crossing process, API, queue, client, workflow, or connector
  boundaries.
- All current contracts are `v0alpha`. They are starting hypotheses, not promises of completeness or
  stability. Add what implementation requires, remove definitions proven superfluous, and prefer
  evidence from vertical slices and legacy tests over preserving an early shape.
- Define a concept once. The API, UI, OpenClaw adapter, worker, and tests must consume generated
  schemas/types rather than copying contracts.
- Shared changes under `spec/common/` or governance/policy contracts require coordination with every
  affected workstream. Workflow-local additions belong in that workflow's file.
- Contract responsibility follows section 16.7 of `ADMINBOT_V2_DESIGN.md`. An owner may evolve its
  files; non-owners propose or coordinate changes instead of editing a shared contract concurrently.
- Do not put secrets, credential values, raw private fixtures, prompts, policy implementation, or
  executable business logic in contract files.
- TypeSpec describes valid shapes and operations. Authorization, separation of duty, state-machine
  invariants, idempotency, and privacy decisions still require implementation and negative tests.
- Generated output is disposable. Change TypeSpec and regenerate it.
- Every breaking contract change must be explicit and reviewed; do not silently reuse a schema name
  for incompatible semantics.

## Architecture and hard boundaries

- OpenClaw and models may observe, reason, draft, and create typed proposals. AdminBot owns
  authorization, policy, approvals, connector scopes, idempotency, execution, and audit logging.
- Every external mutation follows proposal -> policy -> approval -> execution. No workflow,
  scheduler, adapter, UI, or model may call a live connector directly.
- Approval is bound to the exact immutable payload, definition version, policy decision, and hash.
- Unsupported actions and unavailable/misconfigured connectors fail closed. Dry runs have no live
  side effects, and an action is not successful until its connector result is verified.
- Connector workers receive a short-lived capability for one effect and operation. Long-lived vendor
  credentials remain in a host secret manager and never enter schemas, queues, prompts, or audit
  details.
- Human permissions, field ownership, and approver eligibility are enforced server-side. UI hiding
  is not authorization. New members default to `external_collaborator` unless an authorized decision
  states otherwise.
- Privacy classification and sanitization fail closed. Secret material is never model input; raw
  sensitive content stays local unless a destination policy and deterministic sanitization proof
  allow otherwise.
- Static hosting serves Control UI assets only. It must not proxy prompts, credentials, sessions, or
  private lab data through hosted functions or analytics.

## Secrets and state

- Never commit credentials, API keys, tokens, cookies, device identities, pairing state, member
  sessions, runtime databases, logs, memory, browser data, personal workspaces, or live lab records.
- Tests and examples use synthetic identities and data.
- `.env`, `.legacy-reference/`, `.generated/`, `node_modules/`, and runtime state remain ignored.

## Validation

Run from the repository root:

```bash
corepack pnpm contracts:check
corepack pnpm contracts:generate
```

Contract changes must compile with warnings treated as errors and generate both OpenAPI 3.1 and JSON
Schema. When implementation begins, add the narrowest relevant tests plus negative tests for
security-sensitive paths.

## Change discipline

- Keep contract, implementation, tests, generated-client updates, and documentation aligned.
- Do not mix unrelated cleanup or legacy changes into feature work.
- Cross-workflow coordination uses public commands and events, never sibling-private imports.
- Keep services modular but avoid turning logical components into independent deployments without a
  measured security, scaling, or reliability reason.
