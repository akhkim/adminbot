# ADR-0001: Targeted sub-grouping over full hexagonal reshape

## Status

Accepted

## Context

The inherited OpenClaw core (`src/`, ~8,400 files) is flat to the point of
being unnavigable: nine directories hold 139–492 non-test files each with no
subdirectory structure, 5,401 files sit at depth `src/x/y.ts`, and
`src/agents/` imports from 41 of the 51 top-level domains. The repo is a fork
that has diverged permanently (49% deleted in `chore/deep-clean`, 140
local-only commits, no upstream merges expected), so upstream merge
compatibility is not a constraint — but blast radius, review-ability, and an
OOM-prone dev box are.

At the macro level the repo is _already_ hexagonal: `src/plugin-sdk/` is the
port surface, `extensions/` are the adapters,
`extensions/adminbot/src/{contracts,core,executors,features,http,store}` is
textbook ports-and-adapters, `host/main.ts` is the composition root, and
`extensions/tsconfig.package-boundary.*` enforces the plugin surface
mechanically. Imports are explicit relative paths with `.js` extensions and
almost no barrels, so every file move rewrites every importer.

## Decision

We will not impose a `domain/application/adapters` tree on `src/`. Instead:

1. **Sub-group inside existing domain directories** (`src/agents/transport/`,
   `src/gateway/server/`, …) so top-level names, boundary tsconfigs, and check
   script scan roots stay valid. Target: no directory over ~80 non-test files.
2. **Apply hexagonal vocabulary as rules, not folders**: dependency direction
   is enforced by a layering check over the import graph (agents =
   application layer; plugin-sdk = port surface that must not import
   gateway/cli/commands; shared = leaf).
3. **Moves are manifest-driven** (`scripts/moves/*.json` + a deterministic
   codemod) so each step is one reviewable, invertible commit.

## Alternatives considered

- **Full ports-and-adapters reshape of `src/`** — a repo-wide rewrite of
  thousands of explicit import paths for a fork nobody merges into; weeks of
  churn, unreviewable diffs, and the macro-level architecture is already
  hexagonal. Rejected for blast radius without benefit.
- **Do nothing** — navigation stays grep-only, monster directories keep
  growing, cycles keep deepening. Rejected: navigation cost is the point of
  this effort.

## Consequences

- Easier: finding code by `ls`, reviewing structural changes, keeping
  boundary enforcement intact.
- Harder: the layering rules live in a check script + ADRs rather than being
  visible in the tree; readers must learn the vocabulary from
  `docs/architecture.md`.
- Commits us to: the codemod-move tooling, a frozen-edge layering ratchet,
  and per-directory size ratchets so the pancake does not re-form.
