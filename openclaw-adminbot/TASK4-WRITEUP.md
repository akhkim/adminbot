# Task 4 — Concurrent Request Resilience and Fallback

Task 4 asks for lightweight queuing/load shedding, request preservation, allowed fallback or
escalation, observability, and a load simulation. The pass condition is that bursts do not lose or
silently duplicate requests and users receive clear status. All validation uses synthetic data and
mocked integrations.

## On the word "lightweight"

The task asks for a lightweight prototype, and this is larger than that. The reason is worth
stating rather than leaving a reviewer to find it.

The task names two different units: "queuing and load-shedding for LLM actions", and a pass
condition about not losing or duplicating "requests". For a single-call workflow those are the
same thing. AdminBot's are not single-call -- a privacy turn classifies, routes, reasons and
finalizes -- so shedding at the model call preserves a stage, and a member's Wait resumes that
stage rather than their question.

An earlier version of this branch did queue at the model call, and it worked: each stage carried a
submission key derived from the caller's, so every stage had a retrievable row and no request was
lost. The load simulation still checks that property. What it could not do was return the member's
answer from a single Wait; the client had to drive the remaining stages itself.

Moving the unit to the request costs about 2,200 lines above what a minimal version would have
needed, and buys checkpoint reuse across retry and crash, cancellation, bounded retention, and one
behaviour across seven workflows instead of per-caller handling. That was a deliberate trade and
not a requirement of the task.

## Design

A shared task runner owns the original application operation and its final result. A separate
admission gate limits individual local-model HTTP calls. A task never holds a GPU permit across
multiple stages or while doing other work.

| Component                                    | Responsibility                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `tasks/runtime.ts`, `tasks/store.ts`         | Task identity, bounded backlog, checkpoints, retries, cancellation, results and recovery |
| `tasks/context.ts`                           | Per-task execution context and named checkpoint scopes                                   |
| `inference/gate.ts`                          | Shared model concurrency, admission-time timeout, health and model-call diagnostics      |
| `tasks/http-handlers.ts`, `tasks/cv-scan.ts` | Existing workflow adapters and consistent CV domain commits                              |
| `api/server.tasks.ts`, `tasks/visitors.ts`   | Task delivery, ownership and isolated anonymous reimbursement sessions                   |
| UI task request/history/status helpers       | Wait, cancellation, retry, reconnect, restored results and downloads                     |

Immediate successful responses retain their existing payload shape. Work that cannot finish within
the short HTTP response window returns a task handle. The task continues independently of that
connection. Under saturation, a task is saved as `shed` unless waiting was requested. Choosing Wait
executes the original operation through parsing and validation; a classifier response alone is not
reported as a completed application task.

Tasks that have chosen to wait may execute their workflow while waiting inside the GPU FIFO. This
prevents a matcher sweep from monopolizing the GPU merely because another task waits outside the
model queue. The matcher still submits a bounded number of model calls at once.

## Identity and persistence

The owner plus `Idempotency-Key` identifies a submission. Reusing a key with different input or a
different workflow conflicts. Reconnects reuse the same task and final result. Callers without a
key do not receive lost-submission deduplication guarantees. The UI generates and retains keys.

Persistence remains **off by default**, as requested. Tasks and model requests use connection-local
SQLite tables; audit events and member preferences remain in the service database. Enable durable
application tasks with `ADMINBOT_INFERENCE_PERSIST_ACROSS_RESTARTS=true`. Service-owned model-call
queues stay transient: task checkpoints own recovery, and legacy model rows are not dispatched
independently. Historical data is retained, not guessed into reconstructable workflows.

A durable task stores its workflow type/version, input, checkpoint results, attempts, progress and
validated final result. Completed checkpoints are reused. Non-replay-safe steps found running after
a crash become `needs_retry`; an explicit retry creates a fresh attempt while retaining completed
predecessors. Unsupported workflow versions are reported explicitly. No promise of exactly-once
remote or GPU execution is made: a client losing the response cannot know whether the server ran it.

Synchronous domain updates can commit with their checkpoint in one SQLite transaction. CV snapshot
and change-ledger updates use this boundary and refuse a stale comparison baseline. The matcher
retains its run/result interface, with live state projected from the task runner; historical preview
records remain available. Batch plans store stable IDs rather than repeated copies of profiles.

Durable mode rejects a second live runner for the same task database. Distributed execution is not
supported. The process-local mode does not coordinate separate service processes sharing a GPU.

## Workflow coverage

- Privacy tasks checkpoint classification, routing inputs, local/remote reasoning and finalization.
  Observed error responses retain permitted local fallback; unknown interrupted attempts require
  explicit retry. A changed privacy policy prevents resuming under stale routing assumptions.
- Reimbursement turns retain prepared receipt inputs and complete derived fields and policy checks.
  They do not submit a reimbursement automatically.
- Guidebook questions retain the selected excerpts and sources, with index identity checks, rather
  than copying an entire vector index into each task. Member-facing corpus approval is rechecked.
- Blurb and column-mapping results pass through their original parsers and final response contracts.
- Workshop matching retains its batch plan, completed model results and reviewed preview. Sending
  recommendations remains a separate approval-governed action.
- CV scans retain per-member inputs/results and commit snapshots, change entries and checkpoints
  consistently. Publishing a digest remains a separate explicit operation.

Standalone CLI meeting-summary and index-building tools remain compatible but are not converted
into cross-process durable workers. Calendar event drafting still calls the broker directly and
retains legacy model-gate behavior; it is not a resumable task endpoint. Existing external-action approval and execution records remain
independent authorities; task recovery does not authorize resending external actions.

## API and UI

| Route                    | Purpose                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| `POST /tasks/visitor`    | Establish an isolated visitor credential before anonymous submission             |
| `GET /tasks`             | Recent tasks owned by the caller; authorized admins also see shared matcher work |
| `GET /tasks/:id`         | Task status and supported actions                                                |
| `GET /tasks/:id/result`  | Validated application result                                                     |
| `POST /tasks/:id/wait`   | Queue a saved task when backlog capacity allows                                  |
| `POST /tasks/:id/cancel` | Cancel the task; stop subsequent work                                            |
| `POST /tasks/:id/retry`  | Explicitly retry failed/uncertain work                                           |

Access is checked server-side. Task IDs grant no authority. Anonymous reimbursement visitors get
isolated, expiring credentials stored only as hashes on the server. Same-site clients use an
HttpOnly cookie; cross-site clients use a scoped visitor header retained in session storage. Anonymous clients establish the credential before submitting a task, so losing the first task
response does not create a different owner on retry. These
credentials grant only that visitor's reimbursement-task access, never member privileges.

Existing screens share task status controls. The task tray restores recent authorized work after
reload and can retrieve final results without overwriting current forms. Lost-response retries
reuse submission keys. Account changes discard visible results and reject late responses from the
previous account. No original request body is stored in browser task-handle history.

OpenClaw callers receive actionable task envelopes and can use `adminbot_task` for explicit
status/result/wait/cancel/retry operations. The legacy reimbursement console handles task responses
as well.

`/inference/*` remains for operator settings and individual model-call diagnostics. These IDs and
results are not the user-facing task contract.

## Operator controls and limits

- `ADMINBOT_INFERENCE_CAPACITY`: default 2, matching the checked-in vLLM sequence limit.
- `ADMINBOT_INFERENCE_QUEUE_MAX_DEPTH`: default 32; bounds task waiting backlog and model wait line.
- `ADMINBOT_INFERENCE_QUEUE_MAX_PER_OWNER`: default 4. One owner's share of that line, counting
  their queued and running tasks. Past it a task is shed rather than refused, so the member keeps a
  row and a Wait. The dispatcher also rotates across owners rather than following arrival order, so
  a member who arrives during someone else's burst is not placed behind all of it. An idle service
  ignores the share. `service` is one owner for all agent traffic, so this bounds a fleet rather
  than a single agent; the matcher is unaffected, because it submits one task and fans out inside
  it, where the model FIFO already divides the GPU.
- `ADMINBOT_INFERENCE_START_PAUSED=true`: start without dispatch; runtime pause/resume is available.
- `ADMINBOT_INFERENCE_SHUTDOWN_GRACE_MS`: default 360000. Privileged `PUT /inference/settings` with
  `{ "shutdown_grace_ms": 1000 }` changes it immediately, including during shutdown. The deadline
  remains relative to the initial shutdown time; runtime changes reset on restart.
- Existing payload/retained-byte limits bound task inputs/results and model storage. Runner retention
  also bounds task/checkpoint/attempt counts; expired content is removed. Audit retention is separate.

`POST /inference/pause` and `/resume` control task/model dispatch. Active model calls can finish.
Selected task cancellation uses `/tasks/:id/cancel`; legacy `/inference/cancel-pending` accepts
explicit model-request IDs. Operator events and task/checkpoint transitions enter the audit table
with identifiers and event codes, excluding raw task content from the event details.

Shutdown stops new steps, lets admitted work settle within the grace budget, and commits completed
checkpoints. Durable tasks suspend or expose uncertainty; transient tasks report resubmission.
Operator HTTP controls stay available while draining, followed by bounded HTTP connection closure.
Aborting a client request does not prove the model server stopped computing.

## Run locally

```sh
node --import tsx scripts/adminbot-task4-demo.ts
node --import tsx scripts/adminbot-task4-demo.ts --smoke --output .artifacts/task4-smoke.json
```

The demo uses real service/runner/broker/SQLite paths with an isolated loopback model. It prints
synthetic credentials and curl commands, and removes temporary state after graceful shutdown.
The smoke run reconciles task results, model calls and peak concurrency, including live grace edits.

```sh
corepack pnpm test extensions/adminbot/src/tasks extensions/adminbot/src/api/server.tasks.test.ts
corepack pnpm test extensions/adminbot/src/inference
node --import tsx scripts/adminbot-load-sim.ts --scenario all
corepack pnpm build
```

The load simulation runs eight scenarios and 66 checks. Seven drive the model gate directly --
burst, retry, refusal, hang, restart, the real workshop matcher, and the privacy broker -- and the
`restart` scenario kills a child process mid-flight to prove interrupted calls are not replayed.
The eighth, `runner`, drives the task runtime: 120 two-stage requests from 24 members arriving at
once against two model slots. Runner tests separately kill child processes at checkpoint and
domain-commit boundaries.

To see the member-facing side rather than the HTTP side, the real service and the real Control UI
run over a generated 160-member roster and a mock GPU:

```sh
node --import tsx scripts/adminbot-fixture-db.ts .artifacts/adminbot-task4/ui-demo.sqlite --write
node --import tsx scripts/adminbot-seed-member-passwords.ts .artifacts/adminbot-task4/ui-demo.sqlite --write --password "task4-demo"
node scripts/adminbot-mock-local-model.mjs --concurrency 2 --latency-ms 600
ADMINBOT_DATABASE_PATH=.artifacts/adminbot-task4/ui-demo.sqlite node --import tsx start-adminbot.ts
corepack pnpm ui:dev
```

Pausing dispatch (`POST /inference/pause`) makes the deferred state deterministic: a guest
reimbursement turn is saved, offers Wait and Cancel, joins the line on Wait without re-sending,
and delivers the completed rules check once an operator resumes. No credential, runtime bundle or
`state/` file is read; the fixture generator refuses to write under `state/`.

## Limits

- Persistence is opt-in and does not provide distributed execution or universal workflow replay.
- Interrupted calls require explicit decisions; automatic retry could repeat already executed work.
- Compatibility paths outside the service runner do not acquire durable task semantics implicitly.
- Live runner state is process-local; pause and grace overrides are not persistent configuration.
- Retention is logical deletion, not erasure from SQLite free pages, WAL history, or backups.

## What the repository's checks actually report

Measured on 2026-09-15 on this branch, so a reviewer can tell this work's state from the tree's.

| Lane                                                                      | Result                             |
| ------------------------------------------------------------------------- | ---------------------------------- |
| `pnpm test extensions/adminbot`                                           | 2,435 passed, 3 failed             |
| `node --import tsx scripts/adminbot-load-sim.ts --scenario all`           | 66 checks, 8 scenarios, all passed |
| `scripts/adminbot-task4-demo.ts --smoke`                                  | 3 of 3 passed                      |
| `pnpm tsgo:extensions`                                                    | 4 errors                           |
| `pnpm lint`                                                               | 1,152 errors                       |
| `pnpm format:check`                                                       | 205 files                          |
| `pnpm deadcode:unused-files`                                              | 4 files                            |
| `check:layering`, `check:dir-size`, `deadcode:dependencies`, `pnpm build` | clean                              |

The failures above are not this work's. The three test failures are in
`workflows/deadlines/board*.test.ts`, which this branch never touches and whose last commit is an
ancestor of `main`. Of the 1,152 lint errors, 760 are in files this branch never opened; `packages/`
alone carries 49 and was never touched. The four `tsgo:extensions` errors are at lines this diff
does not modify. `docs/refactor-baseline.md` records smaller numbers for several of these lanes and
is out of date independently of Task 4; correcting the repository's own health record seemed like a
separate conversation rather than something to fold into this branch.

Process-kill tests cover checkpoints, domain commits and the integrated privacy broker. The build,
the compiled service and a Chromium cross-origin check all pass. None of this implies a clean
whole-repository typecheck, and it is not claimed as one.
