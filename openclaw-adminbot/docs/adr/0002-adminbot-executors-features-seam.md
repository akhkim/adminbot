# ADR-0002: The AdminBot `executors/` — `features/` seam

## Status

Accepted

## Context

AdminBot's central safety rule, stated in [AGENTS.md](../../AGENTS.md), is that
**the agent proposes and the service executes**: anything with an external effect
is a typed action in `extensions/adminbot/src/contracts/actions.ts` that goes
through propose → approve → execute → audit, and unsupported action types fail
closed rather than being recorded as executed. The approval gate is the whole
point of the design — it is what stops a model turn from reaching Slack, Gmail,
Calendar, Overleaf, OpenReview or a social network on its own.

That rule is expressed structurally by two sibling directories:
`src/features/*` produce typed action proposals, `src/executors/*` consume
approved ones. Read as a file tree, the split looks like duplication: OpenReview,
Overleaf and social posting each appear twice — once under `src/features/papers/`
(`openreview-workflow.ts`, `overleaf-editing.ts`, `social-posting.ts`) and once
under `src/executors/` (`openreview.ts`, `overleaf.ts`, `social.ts`). Anyone
navigating by integration name reasonably reads that as drift left over from the
deep clean, and the obvious "tidy-up" is to collapse each pair into one
per-integration module. It is not drift, and the collapse would be a safety
regression, so the intent needs recording before someone acts on the appearance.

## Decision

We will keep the `executors/` — `features/` seam and continue to **group by
lifecycle role, not by integration**.

- `features/*` are use-cases. They read state and emit typed proposals or read
  models. They never call an external system.
- `executors/*` are outbound adapters. They only ever see a proposal the service
  has already approved, and `executors/composite.ts` dispatches to the first
  executor that handles the action type — an unhandled type fails closed.
- `core/service.ts` sits between them and owns policy, approval and audit; it
  knows the executor interface and nothing about any particular integration.

An integration that appears on both sides is the seam working as designed.

## Alternatives considered

- **Per-integration directories** (`src/openreview/`, `src/overleaf/`,
  `src/social/`, each holding both its proposal logic and its execution code).
  Rejected: it puts proposal-generation and execution in one module, so the
  approval gate the hard rules mandate becomes an internal convention of that
  module rather than a structural boundary. A future edit could call the
  connector directly from the proposal path with nothing in the layout to make
  that look wrong, and reviewers would lose the "does this file import a
  connector?" test that currently answers the question by directory.
- **Merging `executors/` into `core/`.** Rejected: `core/service.ts` is
  deliberately executor-agnostic — it is the piece that must stay testable
  against the in-memory store with no connector present at all.
- **Renaming the directories** (`use-cases/` / `adapters/`) to make the seam
  self-describing. Rejected for now as churn: the names are load-bearing in
  `host/main.ts`, the boundary tsconfigs and the move manifests, and a README
  table communicates the same thing at zero blast radius.

## Consequences

- Following one integration end to end means reading two directories. This is
  the real cost, and it is mitigated by the Layout tables in
  [`extensions/adminbot/README.md`](../../extensions/adminbot/README.md), which
  map each `features/` directory to the executors that run its proposals.
- The approval gate stays visible in the file tree: a `features/` module that
  imports a connector is obviously wrong, and a new external effect has an
  obvious home (a new action type in `contracts/actions.ts`, a proposer in
  `features/`, an executor registered in `composite.ts`).
- New integrations commit to the same two-sided shape; adding one to only one
  side leaves a proposal that fails closed, which is the intended failure mode.
