# Task 4 — Concurrent Request Resilience and Fallback

> Add lightweight queuing and load-shedding for LLM actions. When capacity is exceeded or a local
> server is unavailable, preserve the request and use an allowed fallback, queue, or human
> escalation. Deliverable: queue or fallback prototype, observability events, and a load simulation.
> Pass condition: burst traffic does not lose or silently duplicate requests, and users receive a
> clear status.

Branch `task4-setup`, on top of the setup commits (fixture generator + mock server, see
`TASK4-SETUP.md`). Nothing here reads, copies or connects to the runtime bundle. Every test and
every load-simulation run uses the synthetic fixture and the mock server.

## The problem, in the code

`extensions/adminbot/src/workflows/papers/workshop-match-llm.ts:36-46` records the incident: Aurora's
vLLM admits two sequences (`deploy/aurora/setup-qwen35-vllm.sh`, `--max-num-seqs 2`), the matcher
ran six requests at once, and each request's timeout started at send — so a request that waited 90
seconds inside vLLM for a slot had 30 seconds of its 120-second budget left when the model saw it.
24 of the first 37 calls of a pass failed. The matcher fixed its own pool to two, but four other
callers reach the GPU with their own `fetch` and no pool at all (`privacy/broker.ts`, `cv-scan.ts`
twice, `workflows/reimbursements/workflow.ts`) and a fifth path (`guidebook/local-client.ts`, used
by the guidebook, meeting summaries and paper-import column mapping) has none either. Three
well-behaved pools of two is exactly the recorded incident.

## What was built

### One shared admission gate — `extensions/adminbot/src/inference/`

| File | What it is |
| --- | --- |
| `gate.ts` | The gate. One counter of requests in flight to the GPU for the whole process. Admission, queueing, shedding, dispatch, recovery, sweep, health, escalation triggers. |
| `queue-store.ts` | The durable half: `adminbot_inference_queue` and `adminbot_member_preferences`, and every state transition as one SQLite transaction that writes the row and its audit event together. |
| `config.ts` | The knobs, from `ADMINBOT_INFERENCE_*` env vars with defaults. |
| `gate.test.ts` | 20 tests: admission bound, shed, wait, always-wait preference, depth cap, FIFO, timeout-at-admission, cancel-while-queued, submission-key dedupe and conflict, expiry, restart recovery, retention purge, payload cap, wrong-owner, `runGated` boundary, escalation dedupe, health. |
| `gate.test-support.ts` | A saturated gate for the per-caller boundary tests. |

**Every GPU caller goes through it.** `guidebook/local-client.ts` (`embedLocally`, `completeLocally`),
`privacy/broker.ts` (`callLocalModel`), `cv-scan.ts` (`extractCvEntries`, `draftMemberBlurb`),
`workflows/reimbursements/workflow.ts` (`callLocalReimbursementModel`), and the workshop matcher,
whose `runWithConcurrency` runners are kept but now hand jobs to the gate one at a time rather than
to their own counter. Each caller's request body and error wording are unchanged; their existing
tests pass without modification.

**The decision at the gate.** A request arrives with an owner (the session), a caller label, a
body, a timeout *duration*, an optional cancellation signal, an optional `wait` flag, and an
optional submission key.

- Slot free and nobody ahead in line → runs now. The row is born `running` with this process's
  claim on it.
- No slot, and (`wait: true` OR the member's stored `inference_always_wait` preference) → `queued`,
  durably, in arrival order. A fresh arrival never takes a slot ahead of somebody already waiting.
- No slot, otherwise → `shed`. The body is stored anyway. The status handed back says
  `GPU busy, N ahead of you. Wait or try later.` with `can_wait`, an estimate (or `null` when the
  server is unhealthy), and a `request_id`. `POST /inference/requests/:id/wait` converts it to
  `queued` without re-sending. That conversion is one transaction that checks state, expiry and
  line capacity together; a second click returns the current state and enqueues nothing.
- Past `queue.max_depth` → shed even for always-wait members, with `can_wait: false` and a message
  saying the line is full.

**The timeout clock starts at admission.** Callers pass a number; the gate creates the
`AbortSignal.timeout` after the slot is taken. The matcher's `AbortSignal.timeout(...)`, which used
to be created before the call, is gone; its cancellation signal travels separately and is honored
while queued. The hang scenario in the load sim measures this: six 800 ms timeouts against a server
that never answers land in three rounds at ~2.4 s, not all at 0.8 s.

**Decisions are typed outcomes, not errors.** `gate.run()` returns
`completed | failed | shed | queued | expired | conflict | refused`. Where an existing caller's
contract has no room for that (the broker returns `{route, output}`; the matcher's `WorkshopMatcher`
returns matches), `runGated()` wraps a queue decision in `InferenceDeferredError` at that boundary.
Every catch that could see it rethrows it *first*, before any fallback or retry: the broker's
classify catch and both remote `.catch`es and the finalize catch; the matcher's retry loop; the
reimbursement workflow's "unreachable" wrapper; `local-client.ts`'s "could not reach" wrapper. Each
caller has a test asserting that a shed surfacing through it produces zero further model calls.

**One permit per HTTP call.** Taken inside the gate, released in `finally` after the response body
is read. The broker never holds a slot across its remote stage or between classify and finalize.
Once a broker task's first stage has been admitted, its later stages wait rather than shed (a member
already holding the connection is not left with a classification they cannot use); the depth cap
still applies.

**Duplicate guard.** One row per request from the moment it arrives; a retry or a wait click finds
the row. That covers clients that received the handle. For a client whose response was lost, a
client-supplied submission key (`Idempotency-Key` header), scoped to the owner and bound to a hash of
the payload, makes the retry find the same row: same key + same payload returns it (or attaches to
its in-flight promise); same key + different payload is a `conflict`. This follows
`adminbot_executions.idempotency_key` / `adminbot_proposals.payload_hash`. The key stays reserved for
as long as the row keeps its body — across `completed`, `failed` and `expired` alike, until the
retention sweep strips it — so a timeout followed by a lost response and a retry lands on the failed
row (with "resubmit with a new key to try again") rather than running the request a second time. A
genuinely new attempt is a new key. The broker suffixes the key per stage (`k:classify`, `k:local`)
so each stage's row is findable. Callers that send no key get none of this protection; the HTTP
layer should always send one.

**Durability.** `adminbot_inference_queue` in the same SQLite file as everything else (schema added
in `persistence/sqlite.ts` via `ensureInferenceQueueSchema`). On startup, `gate.start()`:

- fails rows still `running` as `failed` / `interrupted` — never replays them, because whether the
  GPU ran them is unknowable — with an audit event naming `claimed_at` and `claimed_by` (the dead
  process id) so an operator can tell "we restarted" from "vLLM hung";
- expires `queued`/`shed` rows past `queue.max_age_ms` with `inference.expired` and a "resubmit"
  status;
- re-admits the remaining `queued` rows in the order they joined the line.

Claiming a queued row for dispatch is one `UPDATE ... WHERE status='queued' AND claimed_at IS NULL`.
The promise is **one published result per request, not exactly-once GPU execution**: the restart
scenario measures the server seeing `capacity + interrupted` at the crash boundary, because the dead
process's in-flight requests are still on the server when the survivor starts.

**States and terminal events.** `queued`, `shed`, `running` are live; `completed`, `failed`,
`expired` are terminal, written exactly once. `shed` is *not* terminal — it is "awaiting the
member's choice" — so shed → wait → completed is one terminal event. The `expires_at` deadline is
fixed at arrival and never moves, so a late wait click cannot revive an expired row. Both terminal
transitions are guarded `UPDATE ... WHERE status = 'running'`; if recovery (or a second gate on the
same file) settled the row first, the in-flight call emits no second terminal event and returns the
row's actual state to its caller.

**Steps of a task.** Multi-step callers label each row with a `stage` — `{ name, task, final }`.
The broker's `classify` is non-final; `local` and `finalize` are final. A shed classification that a
member later waits on completes only that step, and its status says so: `task_completed: false`,
`can_wait: false`, message *"The "classify" step finished, but the task it was part of did not.
Resubmit the task."* — never "Done". Continuation of the parent workflow is not built (see below);
this is the status refusing to claim it was.

**Ownership.** Every status / result / wait / preference / list operation takes the owner from the
session (`principalActor`), never the URL or body. A wrong owner reads as not-found on every route,
so a request id cannot be used to learn that somebody else's request exists. Tested at the gate
(`gate.test.ts`) and over HTTP (`api/server.inference.test.ts`).

**Retention.** A periodic sweep (`queue.sweep_interval_ms`) expires live rows past `max_age_ms` and
strips `request_json`, `result_json` and `error` from finished rows older than `queue.retention_ms`,
keeping status metadata. `queue.max_payload_bytes` refuses a single body over the cap;
`queue.max_retained_bytes` refuses new arrivals when the table already holds that much content, and
a *result* that would breach it is delivered to the caller but not stored (`result_retained: false`,
status says "delivered but not kept"). A refused request gets a `refused` outcome and an
`inference.refused` audit event, not a handle — a handle would promise a row that was not written.
Not bounded: row count (metadata rows accumulate until an operator prunes them) and per-owner usage.

*This is logical retention.* Bodies are CVs, receipts and private tasks, and they sit in the same
file as the roster. SQLite does not zero freed pages, the WAL keeps recent content until checkpoint,
and backups of the file carry whatever was in it at the time. `max_age_ms` and `retention_ms`
bound how long content is *reachable through the application*, not how long it exists on disk.
Physical erasure would need `PRAGMA secure_delete`, periodic `VACUUM`, and a backup retention
policy, none of which this change adds.

**Bearer tokens are never stored.** Every caller passes the key beside the request *and* the name
of the environment variable it came from; the row carries the name only, and the gate resolves it at
every dispatch. A shed-then-waited or restart-re-admitted row therefore authenticates with whatever
the environment holds then. The health probe sends the same key: the checked-in vLLM unit runs with
`--api-key`, and an unauthenticated `/v1/models` would read a healthy server as down.

### Observability events — `contracts/actions.ts` `AdminBotAuditEvent.type`

Recorded through the same `adminbot_audit_events` table `listAuditEvents()` reads, each in the same
transaction as the row change it describes. Every event's `details` carries `request_id`, `caller`,
`queue_depth` and `in_flight` at that moment, and `wait_ms` where it applies.

| Event | When | Extra details |
| --- | --- | --- |
| `inference.admitted` | The request took a GPU slot. | `timeout_ms` |
| `inference.queued` | The request joined the line. | `position`, `wait` |
| `inference.shed` | No slot; body kept; member offered the wait. | `reason: no_slot \| queue_full`, `max_depth` |
| `inference.waited` | A shed request was converted to queued at the member's request. | `position` |
| `inference.completed` | **Terminal.** The model answered 2xx. | `duration_ms`, `http_status`, `result_retained` (false when the retained-bytes ceiling refused to keep the reply) |
| `inference.failed` | **Terminal.** `outcome` says how: `timeout`, `error`, `cancelled`, `interrupted`, `http_<status>`. Also the broker's fallbacks (`caller: privacy_broker.<stage>`, `fallback: local`). | `error_code` (a Node/undici code or the error class — never the message, which a model can fill with the prompt), `http_status`; for `interrupted`: `claimed_at`, `claimed_by`, `recovered_by`. The raw error text lives in the queue row's `error` column under body retention. |
| `inference.expired` | **Terminal.** Never admitted; past `max_age_ms`. | `max_age_ms` |
| `inference.refused` | Not stored at all (over a size cap). No row exists; this is the only record. | `reason`, `bytes` |
| `inference.escalation_proposed` | A threshold tripped and an `inference.escalate` proposal was created (or could not be: `proposal_error`). `action_id` links the proposal. | `trigger`, `summary`, threshold details |
| `inference.escalated` | **Only after a connector delivered** the approved proposal. Recorded by the execute path in `kernel/service.ts`. | `trigger`, `recipients` |

The broker's three swallowed failures — `.catch(() => undefined)` on remote (twice), bare `catch {}`
on classify and finalize — each now record an `inference.failed` event saying which stage failed and
that the fallback to local was taken. The fallback still happens; it is no longer invisible.

### Health and escalation

Health: `GET /v1/models` every `health.interval_ms` (default 15 s, 5 s timeout), authenticated.
`failure_threshold` consecutive failures → `down`. Because a listing endpoint can answer while
generation hangs, observed inference timeouts and time-since-last-successful-completion are folded
in: a timeout or transport error marks health `degraded` until a completion clears it; work in flight
with no success inside `health.stale_after_ms` is `degraded`. Whenever health is not `ok`, wait
estimates are `null` rather than extrapolated from a healthy latency.

Three triggers, each with a default: oldest queued age > `escalate.queue_age_ms` (5 min); depth >
`escalate.queue_depth` (16); consecutive *probe* failures ≥ `escalate.health_failures` (3) **or**
consecutive *generation* failures ≥ the same threshold — so a vLLM that lists its models and never
finishes a completion still escalates, even with an empty queue. Each
fires once while its condition holds and re-arms when it clears. On firing the gate (1) writes an
operator-visible console line immediately, (2) calls `service.proposeInferenceEscalation`, which
creates an **`inference.escalate`** typed action (new in `adminBotActionTypes`; policy
`approvalPolicy("T3", ["admin"])`) addressed to every Slack-linked admin via the lab-manager /
admin-notice recipient rule, and (3) records `inference.escalation_proposed`. The connector is the
group-DM path in `connectors/slack-admin.ts` shared with `member_nudge.escalate`. Nothing is sent
until an admin approves; members in line see `escalation: { awaiting_approval: true, proposal_id }`
on their status meanwhile. Repeated trips collapse onto one pending proposal per trigger
(`idempotency_key: inference-escalation:<trigger>:<firedAt>`).

### HTTP surface — `api/server.inference.ts`

| Route | Who | What |
| --- | --- | --- |
| `GET /inference/requests` | session | The caller's own requests, newest first. |
| `GET /inference/requests/:id` | owner | Status. 404 for anyone else. |
| `GET /inference/requests/:id/result` | owner | The stored model reply once completed. 404 otherwise (deliberately the same for "not yours", "not finished", "purged"). |
| `POST /inference/requests/:id/wait` | owner | shed → queued. 202 when it moved; 200 with the current state on a repeat click. |
| `GET/PUT /inference/preferences` | session | `{ inference_always_wait: boolean }`. |
| `GET /inference/status` | admin / service | Gate stats: capacity, in flight, depth, health, retained bytes, armed escalations. |

Interactive routes (`POST /privacy/tasks`, `POST /reimbursements/converse`, `POST /cv/blurb/:id`)
read `X-Inference-Wait: 1|0` and `Idempotency-Key`, and turn a queue decision into a status response
rather than a 500: **202** queued, **409** shed (body says `can_wait` and how many ahead) or key
conflict, **410** expired (resubmit), **503** refused. The body is `{ error: { message, inference },
inference }` where `inference` is the status object above.

### Configuration

Environment variables, on the precedent of `ADMINBOT_WORKSHOP_MATCH_CONCURRENCY` and
`ADMINBOT_LOCAL_BASE_URL`: every value describes the GPU deployment, decided at deploy time by
whoever runs the unit, in the same file as the model URL. `AdminBotSettings` is lab policy an
administrator edits in the UI, and a capacity figure there would let a settings edit oversubscribe
the GPU and reproduce the incident.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMINBOT_INFERENCE_CAPACITY` | `2` (or `ADMINBOT_WORKSHOP_MATCH_CONCURRENCY` if set) | Requests in flight to the model. Must match vLLM `--max-num-seqs`. |
| `ADMINBOT_INFERENCE_DEFAULT_TIMEOUT_MS` | `120000` | Model budget once admitted, for callers that do not name one. |
| `ADMINBOT_INFERENCE_QUEUE_MAX_DEPTH` | `32` | Waiting rows past this are shed even for always-wait members. |
| `ADMINBOT_INFERENCE_QUEUE_MAX_AGE_MS` | `3600000` | A request older than this is never admitted; it expires. |
| `ADMINBOT_INFERENCE_QUEUE_RETENTION_MS` | `3600000` | Finished rows keep their bodies this long before the sweep strips them. |
| `ADMINBOT_INFERENCE_QUEUE_SWEEP_INTERVAL_MS` | `30000` | Sweep cadence. `0` disables. |
| `ADMINBOT_INFERENCE_QUEUE_MAX_PAYLOAD_BYTES` | `16777216` | Largest stored request body (a reimbursement turn can carry 20 inline receipt images). |
| `ADMINBOT_INFERENCE_QUEUE_MAX_RETAINED_BYTES` | `268435456` | Ceiling on request+result bytes across all rows. |
| `ADMINBOT_INFERENCE_HEALTH_INTERVAL_MS` | `15000` | `/v1/models` probe cadence. `0` disables. |
| `ADMINBOT_INFERENCE_HEALTH_TIMEOUT_MS` | `5000` | Probe timeout. |
| `ADMINBOT_INFERENCE_HEALTH_FAILURE_THRESHOLD` | `3` | Consecutive probe failures → `down`. |
| `ADMINBOT_INFERENCE_HEALTH_STALE_AFTER_MS` | `360000` | No completion for this long with work in flight → `degraded`. |
| `ADMINBOT_INFERENCE_ESCALATE_QUEUE_AGE_MS` | `300000` | Oldest waiting request past this fires an escalation. |
| `ADMINBOT_INFERENCE_ESCALATE_QUEUE_DEPTH` | `16` | Waiting depth past this fires an escalation. |
| `ADMINBOT_INFERENCE_ESCALATE_HEALTH_FAILURES` | `3` | Consecutive health failures past this fires an escalation. |

The per-member always-wait preference lives in a new `adminbot_member_preferences(member_id,
updated_at, payload_json)` table — a JSON payload, so a second preference later is a key, not a
migration.

## How this maps to the pass condition

**Burst traffic does not lose requests.** Every arrival is a row before any decision is made about
it. Shed rows keep their body and are convertible. Queued rows survive a restart. Nothing leaves the
table without one of exactly three terminal events. The load sim's burst scenario: 50 simultaneous
arrivals, 50 rows, 50 terminal events, 50 completed, mock `peak_arrivals = 2`.

**…or silently duplicate them.** One row per request from arrival; wait finds the row; a submission
key finds the row across a lost response, including one whose first attempt failed; the mock's
semantic fingerprint of every body it received shows zero duplicates in every scenario. Queue decisions cannot enter a retry loop or a fallback,
and each caller has a test for that. The retry scenario submits 20 logical requests 61 times and the
server runs 20.

**Users receive a clear status.** Every outcome carries a `message` the UI can show as-is
(`GPU busy, 3 ahead of you. Wait or try later.`, `Waiting for the GPU, 2 ahead of you.`, `This request
waited too long and was never run. Resubmit it.`, `The service restarted while this request was
running, so its answer was lost. Resubmit it.`, `The "classify" step finished, but the task it was
part of did not. Resubmit the task.`), plus `ahead`, `estimated_wait_ms` (null when unhealthy),
`can_wait`, `expires_at`, `task_completed` for a step of a larger task, and `escalation` when help
has been asked for. A matcher pass reports deferred batches apart from failed ones, and a pass the
GPU never ran throws rather than returning "no matches"; a CV scan records a deferred member as
`skipped` with the queue row named, not `failed`. Over HTTP a
queue decision is a 202/409/410 with that object, not a 500.

**Preserve the request and use an allowed fallback, queue, or human escalation.** Preserve: the row.
Fallback: the broker's existing local fallback, now audited; no *automatic* weakening of the
fail-closed privacy rule (decided, not built — see Scope). Queue: the durable line. Escalation: the
`inference.escalate` typed action through the approval gate.

## Running the load simulation

```bash
cd openclaw-adminbot
corepack pnpm install --frozen-lockfile

# Everything (about 90 seconds). Writes .artifacts/adminbot-task4/load-sim/report.json.
node --import tsx scripts/adminbot-load-sim.ts

# One scenario, more traffic, a slower model.
node --import tsx scripts/adminbot-load-sim.ts --scenario burst --requests 200 --latency-ms 800
node --import tsx scripts/adminbot-load-sim.ts --scenario restart
```

Scenarios: `burst`, `retry`, `refuse`, `hang`, `restart`, `matcher`, `broker`. Each starts its own
mock on `--port` (default 8100, control on 8101), generates a fresh fixture database, and prints one
`PASS`/`FAIL` line per check. Exit code is 0 only if every check passed.

Every scenario reconciles three views: the logical requests the client submitted (by submission
key — for the restart scenario, from a manifest the victim wrote to disk *before* its first
submission, so a row that never reached disk shows up as lost rather than vanishing from the
accounting); the database (one row per key, exactly one terminal event per finished row, row status
agreeing with its event and result); and the client's own outcomes, which must name the right row,
carry a kind consistent with the row's state, and — for completed outcomes — deliver bytes whose
hash matches the retained result. Plus the mock's `peak_arrivals ≤ capacity` and zero duplicate
fingerprints.

Observed on 2026-09-13 (WSL2, Node 22.22.0), 59 checks across 7 scenarios, all passing:

| Scenario | Numbers |
| --- | --- |
| burst (50 arrivals, 400 ms model) | 26 ran or queued at arrival, 24 shed then converted by two concurrent wait clicks each; 50 rows, 50 `completed`, 50 terminal events, 0 completed twice; mock `peak_arrivals=2`, `arrivals=50`, `served=50`, 50 distinct fingerprints, 0 duplicates; wall 10.5 s against an ideal 10.0 s; no timeout fired. |
| retry | 20 logical requests submitted 61 times (3 concurrent each + 1 payload conflict); 20 rows, server served 20, 20 distinct fingerprints; 1 `conflict` outcome; replay after completion returned the stored result with 0 new server arrivals; another owner's identical key made its own row and could not see the first. |
| refuse (ECONNREFUSED) | 10 requests all `failed`/`error` fast, 10 terminal events; two probes → health `down`, `health` escalation armed and `inference.escalation_proposed` recorded; a late arrival fails rather than queueing forever. |
| hang (never answers, 800 ms timeout) | 6 requests all `failed`/`timeout`, serialized by admission: wall 2448 ms = three rounds; health `degraded` with `inference_timeouts=6` while `/v1/models` still answered; mock `peak_arrivals=1`. |
| restart (12 always-wait, SIGKILL) | Victim killed with 2 running + 10 queued; 3 queued rows backdated past max age. Survivor: `interrupted=2` (audit names the dead process's `claimed_by`/`claimed_at`), `expired=3`, `readmitted=7`, all 7 `completed` with retrievable results; interrupted rows say "resubmit"; 12 rows, 12 terminal events; server `peak_arrivals=4 = capacity + interrupted`. |
| matcher (real `createLocalWorkshopMatcher`) | 6 workshops × 12 papers in batches of 4 = 18 calls, 0 failed, sweep 4.2 s; an interactive request arriving mid-sweep was served in 692 ms; max `queue_depth` seen in the audit = 1 (the matcher never dumped its cross-product into the line); mock `peak_arrivals=2`. **This closes the setup agent's inconclusive check.** |
| broker (20 private tasks) | 40 gated calls (classify + local per task), 40 `completed`, mock `peak_arrivals=2`, 40 distinct fingerprints; 20 audited remote fallbacks (no `NVIDIA_API_KEY` in the sim). |

## Tests

```bash
corepack pnpm test extensions/adminbot/src/inference          # 20 gate tests
corepack pnpm test extensions/adminbot/src/api/server.inference.test.ts
corepack pnpm test extensions/adminbot/src/privacy extensions/adminbot/src/cv-scan.test.ts \
  extensions/adminbot/src/workflows/reimbursements extensions/adminbot/src/workflows/papers \
  extensions/adminbot/src/guidebook extensions/adminbot/src/workflows/meetings \
  extensions/adminbot/src/connectors extensions/adminbot/src/kernel extensions/adminbot/src/persistence
```

Observed 2026-09-13: the touched directories (`api`, `connectors`, `privacy`, `inference`,
`guidebook`, `cv-scan`, `reimbursements`, `papers`, `meetings`, `persistence`) — 69 files / 1019
tests, all green; `kernel` — 26 files / 477 tests, all green. `pnpm tsgo:extensions`: 4 errors, all
pre-existing and unrelated (`api/server.lab-sharing.ts` ×2, `preferred_name` ×2), same as before
this change. `check:import-cycles` 0 cycles; `check:dir-size` 0 failures. The known-red
`workflows/deadlines/board*.test.ts` baseline is still exactly 3 failures.

## What does not work, or was not done

- **Remote path for CV scan and reimbursements: not built, by decision.** Both carry named people's
  data; remote reasoning is allowed only after manual redaction, which was proposed to Andrew and
  is deferred until he answers. No automatic degradation of the privacy classifier under load
  either (regex-only classification was considered and rejected: people decide, the fail-closed
  rule is not weakened by a busy GPU).
- **Multi-stage broker continuation across a restart.** Each stage's result is stored and
  retrievable by its row, but a broker task whose *first* stage completed and whose second was
  interrupted is not resumed: the member sees the interrupted stage's "resubmit" status, and the
  next submission runs the task again from classification. Durable inference is not durable
  delivery of the whole workflow.
- **Escalation reaches nobody until an admin approves.** That is the approval gate doing its job,
  and the console alert fires immediately, but if every admin is asleep the DM waits. The
  proposal's recipients are every Slack-linked admin (lab manager first, if set); a lab with none
  gets an `inference.escalation_proposed` event with `proposal_error` and nothing else.
- **Retention is logical.** See above. No `secure_delete`, no `VACUUM`, no backup policy.
- **Anonymous reimbursement callers get a handle they cannot use.** `POST /reimbursements/converse`
  is on `ANONYMOUS_ROUTES` by design, so an anonymous visitor's turn can be shed and they receive a
  `request_id` — but every `/inference/*` route requires a session, so *that visitor* cannot check
  the status, read the result, or click "wait". (An earlier version of this note said another
  anonymous visitor could; that was wrong — nobody anonymous can reach those routes at all.) The row
  still exists and expires on schedule; the practical effect is that an anonymous visitor's shed
  turn is "try later" with no wait option. The fix is an isolated, expiring visitor session bound to
  those rows, which is out of scope here. A signed-in member's rows are theirs alone.
- **Storage bounds are bytes only.** Request and result bytes are capped and counted; the number of
  rows (status metadata survives the sweep) and per-owner usage are not bounded.
- **Audit growth is unbounded by this change.** Every request adds two to four audit rows; the
  existing `auditRetentionDays` pruning applies to them like any other event.
- **One process.** The counter is process-local. The database claims are atomic, so two service
  processes on one file would not double-dispatch a row, but they would each admit `capacity`
  requests. AdminBot runs as one process; if that changes, capacity has to be shared.
- **No UI.** The status objects are designed to be rendered as-is (`message`, `can_wait`, `ahead`),
  and the routes exist, but nothing under `ui/src/ui/adminbot/` calls them yet.
- **Clients must send `Idempotency-Key`** to get lost-response protection. The routes accept it;
  nothing forces it.
- **The estimate is crude:** an exponential moving average of service time × position ÷ capacity,
  and `null` when health is not `ok`.
- **`AGENTS.md` still says the AdminBot suite is 38 files / 570 tests.** It is not (the handoff
  found 155 / 2,293 before this change). Not fixed here; worth one line to Andrew.

## Review disposition

An independent code review (2026-09-13) rated the first implementation against the thirteen design
concerns and found six would-fail defects and seven should-fix ones. This is where each concern
stands after the fixes — the honest version.

| # | Concern | Status | What remains |
| --- | --- | --- | --- |
| 1 | Stable submission identity | **DELIVERED** for keyed callers | Keys stay reserved across `failed`/`expired` for the retention window; retry onto a failed row is that failure, never a second run. Keys are still optional — a caller that sends none has no lost-response protection. |
| 2 | Atomic claims and recovery | **PARTIAL** | Claim + admitted event are one transaction; every waiter settles; guarded terminal transitions mean a recovered row cannot be completed twice. Recovery is still unfenced across processes: two gates on one file each admit `capacity`. |
| 3 | Durable user-visible delivery | **PARTIAL** | Each step's result is retrievable and a completed step of an unfinished task says so (`task_completed: false`, "resubmit the task"). The parent workflow is not resumed. |
| 4 | Shed state and atomic wait | **DELIVERED** | — |
| 5 | Admission-time timeout and retry semantics | **DELIVERED** | Matcher's outer catch counts deferred apart from failed, keeps handles, and refuses to report "no matches" for a pass that never ran. Attempts of one job share no persistent identity across a process restart. |
| 6 | Server-side ownership | **PARTIAL** | Every route checks the session owner. Anonymous reimbursement rows are unreachable by their submitter (see above); unattended callers use `system:*` owners by design. |
| 7 | Retention policy | **PARTIAL** | Sweep strips bodies *and* raw error text; audit rows carry codes only. Running rows past `max_age` are left to the next recovery; deletion is logical. |
| 8 | Storage bounds | **PARTIAL** | Request and result bytes are both counted against the ceiling; a result that would breach it is delivered but not kept. Row count and per-owner quotas are not bounded. |
| 9 | Per-call permit scope | **DELIVERED** | — |
| 10 | Matcher submission policy | **PARTIAL** | Bounded submitters; deferred batches reported distinctly with handles. No persisted continuation identity for a deferred batch beyond the queue row. |
| 11 | Honest escalation visibility | **PARTIAL** | Alert at once, proposal through the gate, `escalated` only on delivery. Dedup is process-local; `awaiting_approval` reflects the armed trigger, not a live read of the proposal's status. |
| 12 | Generation-aware health | **DELIVERED** | Consecutive generation failures trip the health trigger with an answering probe; estimates hidden whenever health ≠ ok; probe authenticated. |
| 13 | Assertions establish the pass condition | **DELIVERED** for what is claimed | Reconciles submission manifest ↔ rows/events ↔ client outcome kind and content ↔ mock. Does not test delivery of a *parent workflow* across restart, because that is not built. |

## Design record

The full decision trail — why one gate rather than per-caller pools or a proxy, why shed-by-default,
why escalation goes through the approval gate, and the review that turned "shed is terminal" into
"shed is awaiting a choice" and "one row per request" into "plus a submission key" — is in the
project handoff outside this repository. The short version: every choice here was reached by
elimination from what the code already enforces (fail-closed privacy, propose→approve→execute for
anything external), not from preference.
