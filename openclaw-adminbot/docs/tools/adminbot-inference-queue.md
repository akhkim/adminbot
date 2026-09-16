# The inference queue and the task runner

One vLLM instance serves the whole lab. `deploy/aurora/setup-qwen35-vllm.sh` runs it with
`--max-num-seqs 2`, against a roster of over a hundred people. Everything here exists because those
two numbers do not move.

Before this, every caller that wanted the GPU opened its own `fetch` and, at best, kept its own
pool. Three well-behaved pools of two are six requests against a server admitting two, each with a
timeout already running while it waits inside the server for a slot — the incident recorded in the
header of `extensions/adminbot/src/workflows/papers/workshop-match-llm.ts`, where 24 of 37 calls
failed.

## Two units, deliberately

`src/inference/gate.ts` admits **one model call**. It counts what is in flight, starts a call's
timeout only after admission — so waiting never spends the call's time budget — and either runs it,
queues it, or sheds it with the body kept so a later Wait finds the row instead of re-sending.

`src/tasks/` owns **one member's request**. That is a different thing, because most AdminBot work is
not one model call: a privacy turn classifies, routes, reasons and finalizes. Queuing at the model
call would preserve a stage, and a member's Wait would resume that stage rather than their question.

The seam is `runGated`. Inside a task, a model call becomes a checkpoint of that task and carries
its owner, signal and attempt identity. Outside one — the CLI tools — it stays the plain gated call.

No task holds a permit across stages. A waiting task joins the model line rather than waiting
outside it, so a matcher sweep cannot hold the GPU while an interactive caller waits on nothing.

See [ADR-0008](../adr/0008-the-task-runner-owns-the-request.md) for why the smaller design lost.

## What a member sees

Work that finishes inside the short response window answers normally; nothing about those calls
changed. Work that does not returns a task handle, and the task keeps running whether or not the
member's connection survives.

When capacity is gone the task is **saved**, not refused:

```text
Reimbursement: waiting for your choice
Task saved. Choose Wait to run it.
[Wait]  [Cancel]
```

Wait asks to put the saved row in the line. If the queue or the owner's share is still full,
it remains saved and offers Wait again. It does not re-upload the input, and it is idempotent —
a client that polls cannot turn one request into two. When the task finishes, the member gets the
answer to what they asked, not the classification that preceded it.

A task that was interrupted mid-step and cannot safely be replayed becomes `needs_retry` and says
so. Retry creates a fresh attempt and keeps every checkpoint that already completed.

## Identity, and not duplicating work

The owner plus an `Idempotency-Key` identifies a submission. Reusing a key with the same input
returns the same task and the same result; reusing it with different input is a `409`. A caller
that supplies no key gets no lost-response guarantee, which is the honest answer rather than a
silent one.

Reimbursement is usable without an account — the form carries only the claimant's own details —
so an anonymous claimant needs an owner too. `POST /tasks/visitor` establishes an expiring
credential, stored only as a hash, **before** the first submission. Without that ordering, losing
the first response would create a second owner on retry. Visitors reach their own reimbursement
tasks and nothing else.

## Sharing the line

Bounding the backlog in total is not enough when a hundred people share it. Two rules:

- **A share.** `queue.maxPerOwner` (default 4) counts an owner's queued _and_ running tasks. Past
  it their next task is shed rather than refused, so they keep a row and a Wait. Counting only
  queued rows would let a burst that is already dispatched escape the share.
- **A rotation.** The dispatcher picks the next task by rotating across owners, resuming after the
  owner it served last, rather than following arrival order. Without this the share still leaves a
  member behind everything an earlier member already got dispatched.

The per-owner share applies even when the service is idle. Rotation matters only when multiple
owners have queued work.

Two consequences worth knowing. `service` is one owner for all OpenClaw agent traffic, so the share
bounds a fleet rather than a single agent. And the workshop matcher is untouched by it — it submits
one task and fans out to a hundred-odd model calls inside it, so its pressure is on the model line,
which the gate divides already.

## Operator controls

| Variable                                     | Default                 | What it does                                                  |
| -------------------------------------------- | ----------------------- | ------------------------------------------------------------- |
| `ADMINBOT_INFERENCE_CAPACITY`                | 2                       | Calls in flight to the local model. Matches `--max-num-seqs`. |
| `ADMINBOT_INFERENCE_QUEUE_MAX_DEPTH`         | 32                      | The whole waiting line, tasks and model calls.                |
| `ADMINBOT_INFERENCE_QUEUE_MAX_PER_OWNER`     | 4                       | One owner's share of it.                                      |
| `ADMINBOT_INFERENCE_DEFAULT_TIMEOUT_MS`      | 120000                  | Budget once admitted, for callers that name none.             |
| `ADMINBOT_INFERENCE_SHUTDOWN_GRACE_MS`       | 360000                  | How long admitted work may settle during shutdown.            |
| `ADMINBOT_INFERENCE_START_PAUSED`            | off                     | Boot without dispatching.                                     |
| `ADMINBOT_INFERENCE_PERSIST_ACROSS_RESTARTS` | off                     | Durable task checkpoints. See below.                          |
| `ADMINBOT_DATABASE_PATH`                     | `state/adminbot.sqlite` | Where the service reads its database.                         |

`POST /inference/pause` and `/resume` control dispatch; calls already admitted finish.
`PUT /inference/settings` with `{ "shutdown_grace_ms": 1000 }` takes effect immediately, including
_during_ a shutdown that is already draining — the deadline stays measured from when shutdown
started. Control routes stay answerable while draining.

`POST /tasks/:id/cancel` cancels one task. `/inference/cancel-pending` takes explicit model-request
ids and is the older, lower-level control.

Every task and checkpoint transition writes an audit row with identifiers and an event code, and
without the task's content.

## Persistence is off by default

Tasks and model queues use SQLite `TEMP` tables on the service connection. Audit rows and member
preferences are durable regardless.

`ADMINBOT_INFERENCE_PERSIST_ACROSS_RESTARTS=true` opts into durable task checkpoints. Then a task
that survives a restart reuses the steps that completed, and a step that was running and is not
replay-safe becomes `needs_retry` rather than being replayed — because a process that died mid-call
cannot know whether the GPU ran it. Durable mode admits **one** live runtime per task database and
refuses a second.

No exactly-once claim is made for GPU or remote execution, and the interface says so rather than
implying otherwise. Retention is logical deletion: it does not erase SQLite free pages, WAL history
or backups.

## Not covered

The standalone CLI meeting-summary and index-building tools, direct calendar event drafting, and CV
digest publication keep their existing model-gate behaviour. They are not resumable tasks and
should not be described as such. There is no distributed execution: this coordinates one service
process, not several sharing a GPU.

## Running it

An isolated harness, real service and runner and SQLite against a loopback mock model that starts
held, so the saved-task sequence can be watched by hand:

```bash
node --import tsx scripts/adminbot-task4-demo.ts            # prints curl commands
node --import tsx scripts/adminbot-task4-demo.ts --smoke    # asserts it, writes a JSON artifact
```

The load simulation, eight scenarios and 66 checks — burst, retry, refusal, hang, restart, the real
matcher, the privacy broker, and the task runner under 120 requests from 24 members:

```bash
node --import tsx scripts/adminbot-load-sim.ts --scenario all
node --import tsx scripts/adminbot-load-sim.ts --scenario runner
```

`scripts/adminbot-mock-local-model.mjs` is the vLLM stand-in both use: controllable concurrency,
latency and failure modes (`503`, hang, `econnreset`, refuse), with a control plane on `port + 1`
so the weather can change mid-run. `scripts/adminbot-fixture-db.ts` generates a throwaway database
at production scale — 160 members by default, every address on an RFC-reserved domain, refusing to
write anywhere near `state/` or a runtime bundle.

To drive the real Control UI over that fixture rather than the harness, point the service at it
with `ADMINBOT_DATABASE_PATH` and run `pnpm ui:dev` alongside. Four processes, in this order:

```bash
node scripts/adminbot-mock-local-model.mjs --concurrency 2 --latency-ms 900

# Member sign-in needs the Gateway. The service mints a browser device token only when a shared
# secret is configured, and the browser then opens a WebSocket to the Gateway. Without the secret
# you get "This browser could not obtain its device credential"; with the secret but no Gateway
# running, "Could not connect". The guest reimbursement path needs neither.
OPENCLAW_GATEWAY_TOKEN=local-demo-secret \
  node openclaw.mjs gateway run --allow-unconfigured --auth token --bind loopback --port 18789

ADMINBOT_DATABASE_PATH=.artifacts/ui-demo.sqlite OPENCLAW_GATEWAY_TOKEN=local-demo-secret \
  node --import tsx start-adminbot.ts

pnpm ui:dev    # http://localhost:5173, already in the service's default allowed origins
```

`scripts/adminbot-seed-member-passwords.ts` gives every fixture member a login to sign in with.
A task only defers when capacity is gone, so force it rather than waiting for luck: `POST
/inference/pause` as an admin, submit, then `POST /inference/resume`. `ADMINBOT_INFERENCE_START_PAUSED=true`
does the same from boot.
