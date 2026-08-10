# ADR-0004: src/agents is the application layer

## Status

Accepted

## Context

`src/agents/` is the largest and most connected directory in the core: ~196 root
files, 1,744 files in tree, and imports reaching 41 of the 51 other top-level
`src/` directories (measured pre-refactor). Every other domain directory looks
like a peer next to it in the `src/` listing, which invites the reading that
`agents` is one domain among many that has simply grown too many dependencies —
a mess to be cleaned up by cutting edges.

That reading does not survive contact with the code. The edges are not
incidental coupling; they are what an agent run _is_. Executing a turn means
reading config, resolving a model, opening a transport, minting auth, mounting
MCP servers, dispatching tools, writing sessions, touching the workspace and the
sandbox, and reporting back through the gateway. A directory that orchestrates
all of that necessarily depends on all of that.

Two observations pin this down:

- The cycles the restructure found at domain granularity — `agents` ↔
  `auto-reply` being the visible pair — are cycles between an orchestrator and a
  thing it orchestrates, which called back into it. They are artifacts of both
  sides being drawn as peers, not evidence that either half is misplaced.
- Nothing else in `src/` has this shape. The next most connected directories are
  an order of magnitude less central, and each has an obvious subject matter.
  `agents` has no subject matter of its own; its subject is _the run_.

Left unnamed, this ambiguity has a cost in both directions. Reviewers keep
relitigating whether a new `agents` → peer import is a layering violation (it is
not), and nothing stops a peer from reaching into `agents` internals (which is
the violation that actually matters, and it had no rule against it).

## Decision

We will treat `src/agents` as the **application layer** of the core, not as a
peer domain, and say so in the layering rules:

1. **`agents` may import widely.** A dependency from `agents` onto a domain
   directory is in-direction by definition and needs no justification. The
   breadth of its import set is a property of the layer, not a defect to be
   ratcheted down.
2. **Peers must not deep-import `agents` internals.** Dependencies point _up_
   into `agents` only through whatever `agents` deliberately exposes. The
   layering check freezes today's edge set as the allowed baseline, so existing
   inward edges are grandfathered but no new one can appear without an explicit
   decision. The goal is to stop growth, not to force an immediate cleanup.
3. **Navigation is solved inside the directory, not by splitting it.** The
   phase-3 sub-grouping gives `agents` its own internal map — `transport/`,
   `models/`, `auth/`, `mcp/`, `subagents/`, `tools/`, `embedded/`, `prompt/`,
   `sessions/`, `workspace/`, `sandbox/`, `acp/`, `cli-runner/` — which is what
   the ≤80-files-per-directory target was really asking for.

## Alternatives considered

- **Split `agents` into several top-level domains.** Rejected: the hub edges are
  real. Distributing them across `agent-transport/`, `agent-models/`,
  `agent-tools/` and so on renames the hub without removing a single dependency,
  and it multiplies the `agents` ↔ `auto-reply` class of cycle across every new
  top-level name instead of containing it in one. The `src/` listing would look
  flatter while the import graph got strictly harder to reason about.
- **Reshape into explicit ports/adapters (`application/`, `domain/`,
  `adapters/`).** Rejected per ADR-0001: the repo is already hexagonal at the
  macro level (`plugin-sdk` is the port surface, `extensions/` the adapters), and
  imports are explicit relative paths with almost no barrels, so a tree-level
  reshape rewrites every importer for vocabulary the layering check can express
  as a rule instead.
- **Leave it unnamed and keep cutting edges case by case.** Rejected: this is
  the status quo that produced the recurring argument. Without a stated layer
  there is no principled answer to "may `agents` import this?", and the rule that
  matters — peers not reaching inward — stays unwritten and unenforced.

## Consequences

- **Easier:** new `agents` → peer imports stop being review findings; the
  layering check has a direction to enforce rather than a size to police; and the
  one rule that protects the boundary (no inward deep imports) is now written
  down and mechanical.
- **Harder:** `src/agents` is a permanent exception to the per-directory size
  target and must be grandfathered with a pointer to this ADR, alongside
  `src/plugin-sdk` (ADR-0003). Its internal structure is now the only defense
  against it becoming unnavigable, so sub-group discipline matters more here than
  anywhere else in the core.
- **Commits us to:** giving `agents` a deliberate inward surface. The frozen edge
  set is a baseline, not an endorsement — each grandfathered inward edge is
  either promoted to an intentional entry point or removed over time, and the
  `agents` ↔ `auto-reply` cycle is the first candidate.
