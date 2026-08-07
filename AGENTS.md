# AGENTS.md

This is the private lab-sharing repository for AdminBot. It combines a vendored/synchronized
OpenClaw tree with the lab-specific AdminBot plugin, service composition, Control UI additions,
deployment scripts, and a sanitized setup template.

## Read instructions in scope

- This file applies to the whole repository.
- Before changing anything under `openclaw-adminbot/`, read
  `openclaw-adminbot/AGENTS.md` in full and then the nearest more-specific `AGENTS.md` files.
- In particular, `openclaw-adminbot/extensions/AGENTS.md` governs the AdminBot plugin and
  `openclaw-adminbot/ui/AGENTS.md` governs Control UI changes.
- The nested OpenClaw guides contain detailed upstream architecture, style, testing, docs, and
  review rules. Do not duplicate or bypass them here.
- If instructions conflict, preserve the security and privacy invariants in this file and follow
  the most specific guide for implementation details.

## Repository map

- `README.md`: lab-repository overview, setup, and upstream-sync policy.
- `openclaw-adminbot/`: Node/TypeScript pnpm workspace containing OpenClaw plus the AdminBot
  layer.
- `openclaw-adminbot/extensions/adminbot/`: typed AdminBot plugin, local HTTP service, SQLite
  ledger, connector executors, workflows, tests, and bundled AdminBot skills.
- `openclaw-adminbot/start-adminbot.ts`: composition root for the loopback service and live
  executors. `start-adminbot.mjs` is the runnable built entry point.
- `openclaw-adminbot/ui/`: Lit Control UI, including admin/member views and auth flows.
- `openclaw-adminbot/docs/tools/adminbot.md`: operator-facing AdminBot documentation.
- `openclaw-adminbot/deploy/aurora/`: Aurora user-service and model/runtime provisioning.
- `openclaw-setup/`: sanitized, shareable examples only. It is not a live OpenClaw home.

## Development

Run project commands from `openclaw-adminbot/`. The supported runtime is Node 22.19+ and the
package manager is the pinned pnpm version in `package.json`.

```bash
cd openclaw-adminbot
pnpm install
pnpm build
pnpm ui:build
node start-adminbot.mjs
```

- Use `pnpm ui:dev` for Control UI iteration.
- `pnpm gateway:watch` does not rebuild `dist/control-ui`; rerun `pnpm ui:build` after UI changes.
- Prefer targeted validation while iterating; the full workspace is large.
- Never edit `node_modules`, generated build output, runtime databases, or generated plugin
  registries by hand.

## AdminBot architecture and hard boundaries

- OpenClaw and the model may observe, reason, draft, and create typed proposals. The AdminBot
  service owns authorization, policy, approvals, connector scopes, idempotency, execution, and
  audit logging.
- Every external mutation must use the proposal -> approval -> execution path. Do not add direct
  model/tool access to Gmail, Calendar, Slack, Overleaf, social posting, reimbursements, member
  management, or other live lab systems.
- Approval is bound to the exact immutable payload and its hash. Preserve risk tiers, required
  approver roles/counts, idempotency checks, and audit records when adding or changing actions.
- Unsupported actions and unavailable/misconfigured connectors must fail closed. Do not mark an
  action executed until its connector succeeds. Dry runs must not perform live side effects.
- Keep the agent least-privileged. Member/admin behavior is enforced server-side through member
  sessions and privilege-capped gateway device scopes; UI hiding is not an authorization control.
- New members default to the least-privileged `external_collaborator` tier unless an explicit,
  authorized choice says otherwise.
- Keep the AdminBot service loopback-only by default. Do not weaken the non-loopback refusal,
  gateway authentication, browser-origin checks, or device-pairing scope checks for convenience.
- Privacy classification and sanitization must fail closed. Raw sensitive content must remain on
  the local VM; remote reasoning may receive only content proven safe or placeholder-sanitized.
- Vercel hosts static Control UI assets only. Do not proxy prompts, credentials, or private lab
  data through Vercel functions, analytics, or other hosted middleware.
- Keep business workflow guidance in the focused AdminBot skills. Keep typed action contracts,
  security checks, and connector boundaries in code.

## Secrets and state

- Never commit credentials, API keys, service tokens, gateway tokens, keyrings, cookies, device
  identities, pairing state, member sessions, logs, memory, browser data, personal workspaces, or
  live lab records.
- Vendor write credentials belong in the service environment or host secret manager, never in
  prompts, skill text, source code, model-visible memory, or `openclaw-setup/`.
- `openclaw-setup/openclaw.example.json` and `installs.json.example` must remain sanitized.
  Preserve placeholders and remove machine-specific paths, identities, endpoints, and secrets
  before committing changes there.
- Runtime SQLite files belong under ignored `openclaw-adminbot/state/`. Do not commit `*.sqlite`,
  WAL/SHM files, `.env` files, or generated runtime state.
- Tests must use synthetic identities and data. Redact secrets and personal/lab-sensitive content
  from fixtures, logs, screenshots, and failure output.

## Change placement

- AdminBot plugin production code imports through `openclaw/plugin-sdk/*` and local barrels; it
  must not reach into OpenClaw core internals or another extension's internals.
- Put reusable AdminBot service behavior in `extensions/adminbot/src/`; keep process wiring and
  host-specific composition in `start-adminbot.ts` or deployment scripts.
- Update action types, policy, schemas, persistence, executor behavior, API/UI handling, tests,
  and docs together when changing an AdminBot action or workflow contract.
- When changing access levels, auth, device pairing, approvals, privacy routing, or execution,
  trace the complete server-side path and add regression tests for both allowed and denied cases.
- Control UI uses Lit legacy decorators. Preserve the style documented in
  `openclaw-adminbot/CONTRIBUTING.md` and `openclaw-adminbot/ui/AGENTS.md`.

## Validation

Choose the narrowest meaningful checks first, then widen according to risk:

```bash
cd openclaw-adminbot

# AdminBot plugin and its shared plugin contracts
pnpm test:extension adminbot
pnpm test:contracts:plugins

# Control UI changes
pnpm test:ui
pnpm ui:build

# Changed files / broader TypeScript work
pnpm check:changed
pnpm test:changed
pnpm format:check

# Full pre-PR lane when feasible
pnpm build
pnpm check
pnpm test
```

- Add or update colocated `*.test.ts` tests for behavioral changes.
- For connector or deployment changes, supplement unit tests with a safe dry run or documented
  real-behavior check. Never perform a live external mutation merely to validate a change without
  explicit authorization.
- For security-sensitive changes, test negative paths: missing approval, wrong role, altered
  payload, replay/idempotency, expired/revoked session, excessive scopes, unavailable connector,
  and unsafe privacy classification as applicable.
- UI changes should include relevant view/controller tests and a production UI build; visually
  inspect meaningful rendering changes when possible.

## Upstream synchronization and commits

- This repository has no shared Git history with `openclaw/openclaw`. OpenClaw base updates arrive
  as squashed sync commits.
- Do not merge upstream history into this repository. Diff or rebase the AdminBot layer against an
  upstream checkout, preserve lab-local files, and keep AdminBot changes easy to identify.
- Keep changes focused. Do not mix an upstream sync, generated churn, unrelated cleanup, and an
  AdminBot feature in one change.
- Do not edit `openclaw-adminbot/CHANGELOG.md` for ordinary contributor changes unless explicitly
  requested by a maintainer.
