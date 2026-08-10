# ADR-0007: The AdminBot product tree adopts the v2 taxonomy

## Status

Accepted

## Context

AdminBot v2 is a separate clean-room design, drafted in `ADMINBOT_V2_DESIGN.md`
on the lab repo's `feat/adminbot-v2-interfaces` branch. Its §16 ("Suggested code
organization") fixes a vocabulary for the whole system: `workflows/` (one pack
per domain feature), `connectors/` (one vendor family's operation
implementations), `adapters/` (translation from an inbound protocol or client
into AdminBot contracts), `kernel` (actions, approvals, executions — the
governance core), `persistence`, `identity`, `privacy` as a first-class platform
boundary, `api`, `content/` (reviewed templates and organization data), and
`apps` for composition. §16.1 states what each may and may not own; §16.2 fixes
the dependency direction.

v1 — this fork — named the same concepts after their lifecycle role at the time
they were written: `core/`, `store/`, `http/`, `tools/`, `executors/`,
`features/`, plus asset directories (`deadlines/`, `onboarding-emails/`) hanging
off the package root. Nothing about those names is wrong, but none of them is
guessable. `tools/` is the OpenClaw tool surface, not a grab-bag of helpers;
`core/` is the approval engine, not shared utilities; `executors/` are vendor
adapters; `features/privacy/` is not a feature at all but the redaction boundary
every payload crosses. Reading the tree required tribal knowledge, and the
`extensions/adminbot/README.md` Layout tables existed precisely to supply it.

The forcing event is that contributors are about to read both trees. v2's design
document is the reference for where the product is going; v1 is the code that
runs the lab today. If the two use different words for the same seam, every
conversation, review comment and migration note needs a translation step, and
the translation drifts.

## Decision

We will rename the AdminBot product tree onto the v2 §16 vocabulary.

| v1 (before)                                                                        | v2-aligned (after)        | v2 §16 counterpart         |
| ---------------------------------------------------------------------------------- | ------------------------- | -------------------------- |
| `src/core/`                                                                        | `src/kernel/`             | `packages/kernel/`         |
| `src/store/`                                                                       | `src/persistence/`        | `packages/persistence/`    |
| `src/http/`                                                                        | `src/api/`                | `apps/api/`                |
| `src/tools/`                                                                       | `src/adapters/openclaw/`  | `adapters/openclaw/`       |
| `src/executors/`                                                                   | `src/connectors/`         | `connectors/`              |
| `src/features/auth/`                                                               | `src/workflows/identity/` | `packages/identity/`       |
| `src/features/privacy/`                                                            | `src/privacy/`            | `packages/privacy/`        |
| `src/features/<calendar\|deadlines\|members\|onboarding\|papers\|reimbursements>/` | `src/workflows/<same>/`   | `workflows/<name>/`        |
| `deadlines/`, `onboarding-emails/`                                                 | `content/<same>/`         | `content/`                 |
| `src/contracts/`, `src/web/`                                                       | unchanged                 | v1's own spec and console  |
| `host/`, `skills/`, `api.ts`                                                       | unchanged                 | `apps/`, pack registration |

Three properties of the change are deliberate and load-bearing:

- **Directory renames only.** Every file keeps its full name and its contents;
  the moves went through `scripts/lib/codemod-move.ts` manifests
  (`scripts/moves/adminbot-v2-taxonomy-src.json`,
  `scripts/moves/adminbot-v2-taxonomy-content.json`) so the import rewriting is
  mechanical and auditable rather than hand-edited.
- **[ADR-0002](0002-adminbot-executors-features-seam.md)'s seam is intact under
  the new names.** `workflows/*` produce typed proposals and never call an
  external system; `connectors/*` only ever see a proposal the service has
  already approved; `kernel/service.ts` sits between them and stays
  connector-agnostic. An integration appearing on both sides is still the seam
  working as designed. ADR-0002 explicitly rejected renaming
  (`use-cases/`/`adapters/`) as churn on the grounds that a README table
  communicated the same thing at zero blast radius; that calculus changed when
  a second, differently-named tree entered the picture, and the names it
  rejected are not the names adopted here.
- **`privacy/` is promoted out of `features/`.** v2 treats the privacy broker as
  a platform boundary a payload crosses, not a use-case a user invokes, and the
  v1 module was already shaped that way — `broker.ts` gates payloads and
  executes nothing.

## Alternatives considered

- **Reshape the whole fork into the v2 monorepo layout** (`spec/`, `apps/`,
  `packages/`, `tooling/`, boundary checks in CI). Rejected: the fork's `src/`
  is inherited upstream core, and its shape is already governed by
  [ADR-0001](0001-targeted-subgrouping-over-full-hexagonal-reshape.md),
  [ADR-0003](0003-plugin-sdk-stays-flat.md) and
  [ADR-0004](0004-agents-is-the-application-layer.md). v2 is a clean-room effort
  with no upstream to keep merging against; applying its whole-repo shape here
  would relitigate three accepted decisions to make a fork look like a codebase
  it is not going to become.
- **Leave the v1 names alone and translate in documentation.** Rejected: this is
  what the README Layout tables already did, and it works only while one tree
  exists. With two, v1 and v2 diverge in vocabulary at exactly the moment
  contributors start reading both — and a translation table is the first thing
  to go stale.
- **Rename only the most confusing directories** (`tools/`, `core/`). Rejected:
  a half-adopted vocabulary is worse than either whole. A reader who learns that
  `connectors/` means what v2 says would still have to discover that `features/`
  is v2's `workflows/`.

## Consequences

- A reader of `ADMINBOT_V2_DESIGN.md` §16 can navigate v1 directly: the
  directory they look for exists, holds what §16.1 says it holds, and the
  README's Layout section carries the dir ↔ §16 mapping explicitly.
- Future moves inside the product tree follow v2 vocabulary. A new domain
  feature is `src/workflows/<name>/`; a new vendor is `src/connectors/<name>.ts`
  registered in `composite.ts`; a new inbound protocol is
  `src/adapters/<protocol>/`; reviewed org data is `content/`.
- Git history for the moved files needs `--follow`. The manifests name every
  move, so the mapping is recoverable.
- References outside the product tree had to be repaired by hand where the
  codemod does not sweep: the deadline dataset is read by Python and shell
  (`scripts/adminbot-deadline-*.py`, `scripts/adminbot_deadlines.py`,
  `scripts/adminbot-deadline-cron.sh`) as well as by TypeScript, and generated
  files carry the source asset's path in their header comment.
- The v1 tree is still not v2. `src/contracts/` is v1's hand-written vocabulary
  where v2 generates from TypeSpec; there is no `spec/`, no `queue/`, no
  per-workflow `manifest.ts`. The taxonomy is shared; the architecture is not
  yet, and this ADR does not claim it is.
