# ADR-0008: The task runner owns the request; the gate owns the model call

## Status

Accepted

## Context

One vLLM instance serves the whole lab. `deploy/aurora/setup-qwen35-vllm.sh` runs it with
`--max-num-seqs 2`, against a roster of over a hundred people. Before this work every GPU caller in
the tree opened its own `fetch` and, at best, kept its own pool, so three well-behaved pools of two
reproduced the incident recorded in the header of `workflows/papers/workshop-match-llm.ts`: six
requests in flight against a server admitting two, each with a timeout already running while it
waited inside the server for a slot.

`src/inference/` answered that. One gate counts admissions, starts each call's timeout only after
admission, and either runs a call, queues it, or sheds it with the body kept so a later Wait finds
the row instead of re-sending.

That left a second problem, and it is the one this ADR is about. The gate's unit is a model call.
Most AdminBot work is not one model call. A privacy turn classifies, then routes, then reasons, then
finalizes. A reimbursement turn, a CV scan and a workshop sweep are the same shape. Shedding at the
model call therefore preserves a _stage_, and the member's Wait resumes that stage rather than the
question they asked.

This was workable and shipped: each stage derived its submission key from the caller's, so every
stage had a retrievable row and nothing was lost. What it could not do was answer a member from one
Wait. The client had to drive the remaining stages itself, and every caller needed its own handling
for a deferral arriving mid-workflow.

Holding one permit for a whole workflow would have been the small fix. It was rejected: the permit
would be held across the remote call and across work that needs no GPU, which is the scarcest
resource in the deployment spent on waiting.

## Decision

We will make the member's request the unit that is queued, shed, resumed and delivered, and leave
the gate responsible only for admitting individual model calls.

`src/tasks/` owns a task: its submitting identity, an immutable snapshot of its input, named and
versioned checkpoints, its progress, its cancellation, and the one validated result the member
receives. `runGated` is the seam — inside a task context a model call becomes a checkpoint of that
task and carries its owner, signal and attempt identity; outside one it stays the plain gated call
the CLI paths use.

No task holds a permit across stages. Waiting tasks join the model FIFO rather than waiting outside
it, so a sweep cannot hold the GPU while an interactive caller waits on nothing.

Durability is opt-in and off by default (`ADMINBOT_INFERENCE_PERSIST_ACROSS_RESTARTS`). A step that
is interrupted and is not replay-safe becomes `needs_retry`; only an explicit retry re-enters it,
because a client that lost its response cannot know whether the GPU already ran the work. We make
no exactly-once claim for GPU or remote execution and the interface says so.

The backlog is bounded per owner as well as in total (`queue.maxPerOwner`), and the dispatcher
rotates across owners rather than following arrival order, so one member's burst neither takes the
whole line nor decides when the next member is served.

## Alternatives considered

**Keep queuing at the model call.** It worked, it was smaller, and it satisfied the pass condition.
It lost because a member's Wait returned a classification rather than an answer, and because every
caller had to carry its own deferral handling. This is the alternative closest to what the task
asked for, and choosing against it is the reason this subsystem is larger than "lightweight".

**One permit per workflow.** Simplest of all, and it makes Wait return the answer. Rejected because
it holds the scarcest resource in the deployment across remote calls and across work that needs no
GPU.

**A general workflow engine, or an external scheduler and queue.** Rejected as far outside the
problem. No Redis, no separate database, no second deployment unit: Node and the SQLite file the
service already opens.

**A per-owner refusal rather than a shed.** Rejected because the task's own wording is to preserve
the request. Past their share a member's task is saved and offers Wait, which is the status they
already understand from a full queue.

## Consequences

Easier: a deferred request is one row with one identity, so status, result, Wait, cancel and retry
are one set of routes and one set of UI controls rather than per-workflow handling. A retry after a
crash reuses completed checkpoints instead of re-spending GPU time. Ownership is checked in one
place, which is what let anonymous reimbursement visitors keep working without member privileges.

Harder: there are now two bounded queues to reason about — the task backlog and the model line —
and an operator has to know which one is full. Durable mode admits only one live runtime per task
database, so it does not survive being run twice.

Committed to: `extensions/adminbot/src/tasks/` as a directory with its own lifecycle contract, the
`/tasks` route family as a public surface, and the checkpoint key format as something that cannot
change without a workflow version bump.

Not covered, deliberately: the standalone CLI meeting-summary and index tools, direct calendar
event drafting, and CV digest publication keep their existing model-gate behaviour and are not
resumable tasks. There is no distributed execution. `service` is a single owner for all agent
traffic, so the per-owner share bounds a fleet rather than one agent.
