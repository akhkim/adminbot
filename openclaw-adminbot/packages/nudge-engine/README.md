# nudge-engine

A stateless frontier resolver over the PaperFlow DAG. Give it the workflow graph and a
status snapshot; it tells you **who to nudge, about what, and why** — and stays silent when
silence is correct.

Zero runtime dependencies. No I/O, no stored state, no framework.

## The five rules it implements

1. The workflow is a **DAG** of actionable nodes and predecessor–successor dependencies.
2. The nudger is **stateless and read-only** — the backend is the single source of truth.
3. Nudge only **frontier** nodes: incomplete nodes whose predecessors are all complete.
4. For a blocked task, **traverse upstream** to the real dependency — never nudge the blocked task.
5. **Route by dependency type**: missing predecessors, approval gates, newly unblocked successors.

## Quick start

```ts
import { paperflow, tick, nudgeText } from "@openclaw/nudge-engine";

const state = {
  paperId: "p-2026-14",
  attempt: 1,
  version: "preprint",
  status: { BR: "complete", OV: "complete", PM: "complete", FX: "complete", PDF: "complete" },
  decisions: {},
};

const result = tick(paperflow, state);

for (const batch of result.batches) {
  console.log(batch.recipient, batch.nudges.map((n) => nudgeText(paperflow, n)));
}
```

`result.outcome` is one of `nudges` · `done` · `quiet` · `stall` · `config_error`. Those last
two mean a human should look — see *Silence is never ambiguous* below.

### "Why is this stuck?"

```ts
import { whyBlocked } from "@openclaw/nudge-engine";

whyBlocked(paperflow, state, "PS");
// → { blocked: true, actionable: ["CP", "GT"],
//     actionableLabels: ["Coauthor feedback", "Zhijing explicit yes"] }
```

Nobody nudges `PS`, and nobody nudges the first author, who has nothing to do.

## Local demo

```bash
node demo/serve.mjs   # → http://localhost:5174
```

No build step and no install — Node strips the TypeScript types on the fly. Tick boxes as if
you were the backend and watch the nudge feed recompute.

## Tests

```bash
node --test test/*.test.ts
```

24 tests, **one per numbered cliff** in [`docs/nudge_logic.md`](docs/nudge_logic.md). That
file is the design register; this suite is its enforcement. Edit the graph in a way that
reintroduces a hole and the test named after it fails.

## Layout

```
src/
  types.ts            the shared vocabulary
  nudge.ts            tick() and whyBlocked() — the composition root
  messages.ts         copy, separate from logic
  core/
    graph-ops.ts      traversal primitives — Rule 0 lives here, in one place
    prune.ts          decision pruning by reachability
    frontier.ts       the actionable frontier
    resolve.ts        upstream resolution
    route.ts          who hears about it
  graph/
    paperflow.ts      the PaperFlow DAG as data
    validate.ts       load-time checks
  adapters/backend.ts the backend seam
```

Dependency direction is strictly `types ← core ← graph ← nudge`. `core/` never imports a
specific graph, so the engine runs on **any** DAG — swap `graph/paperflow.ts` for a
reimbursement or onboarding flow and nothing else changes.

## Three things worth knowing before you edit

**Rule 0 — cycles.** PaperFlow has two back-edges: `RJ → OV` ("Revise, new venue, same
record") and `GT → PK` ("Not yet"). They are typed `reset` and `retry`, and traversal never
follows them upstream. That exclusion is what makes the graph acyclic and the frontier
well-defined. `validateGraph` fails loudly if a new edge breaks it.

**Pruning is reachability, not "everything downstream".** When a paper is rejected, `CM` is
unreachable — but `PK` is still reachable through `AK` (the preprint path), so the arXiv
branch stays live. A naive downstream sweep would prune `PK GT JN PS` and deadlock branch 3
silently. Pruning is also recomputed every tick and never persisted, or attempt 2 inherits
attempt 1's dead branches.

**Silence is never ambiguous.** An empty frontier is three different things, and collapsing
them is what makes a nudger untrustworthy:

| Outcome | Meaning |
|---|---|
| `done` | a terminal is complete — finished |
| `quiet` | waiting on someone outside the lab, deliberately no nudge |
| `stall` | nothing actionable **and** nothing finished — the graph or the status feed is wrong |
| `config_error` | an unowned or unreachable node — **zero** nudges emitted, not a partial set |

## Design docs

- [`docs/nudge_logic.md`](docs/nudge_logic.md) — the spec, the cliff register, the invariants
- [`docs/paperflow.md`](docs/paperflow.md) — the workflow chart

## Not in scope

The engine **emits proposals, it never sends**. Delivery goes through AdminBot's existing
`propose → approve → execute → audit` gate (`paper_publish.nudge_author`,
`escalate_to_pi`, `member_nudge.send`). The cadence ledger — who was nudged about what, when
— is suppression bookkeeping owned by the host, not workflow state. Losing it causes a
duplicate nudge, never a missed step.
