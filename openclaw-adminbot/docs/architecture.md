# Architecture guide

Where things live and why, for someone who has just cloned the repo. Read
[README.md](../README.md) for what AdminBot does and [AGENTS.md](../AGENTS.md) for the
rules you must not break. Structural decisions are recorded in [docs/adr/](adr/) —
this page links out rather than re-arguing them.

## What this is

AdminBot is a fork of [OpenClaw](https://github.com/openclaw/openclaw) — an extensible
multi-channel AI gateway — cleaned down to what the lab actually runs. Nine bundled plugins
survive of ~130; the speech subsystems, native apps, upstream CI and the npm release
machinery are gone, and `chore/deep-clean` removed about half the tree. The gateway, agent
runtime and Control UI are inherited and largely untouched; everything AdminBot-specific
lives in `extensions/adminbot/`, `ui/src/ui/adminbot/`, `scripts/adminbot-*` and
`deploy/aurora/`. The fork has diverged permanently — no upstream merges are expected — so
structural changes are judged on blast radius and reviewability, not on merge compatibility
([ADR-0001](adr/0001-targeted-subgrouping-over-full-hexagonal-reshape.md)).

## The hexagonal reading

The repo is already ports-and-adapters at the macro level. The vocabulary is applied as
rules and documentation rather than as folder names — that is the whole content of
[ADR-0001](adr/0001-targeted-subgrouping-over-full-hexagonal-reshape.md).

| Role                 | Where                              | Notes                                                                                                                                      |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Product**          | `extensions/adminbot/`             | `contracts/` → `kernel/` → `persistence/` → `api/` → `workflows/` → `connectors/` → `adapters/openclaw/` → `web/console/`; textbook layers |
| **Port surface**     | `src/plugin-sdk/`                  | 431 flat modules, one file = one public subpath ([ADR-0003](adr/0003-plugin-sdk-stays-flat.md))                                            |
| **Adapters**         | `extensions/*`                     | adminbot, slack, vllm, nvidia, ollama, openrouter, brave, memory-core, device-pair                                                         |
| **Composition root** | `extensions/adminbot/host/main.ts` | the single place connectors, the store and cross-plugin deps are wired together                                                            |
| **Application core** | `src/` (inherited)                 | `src/agents` is its application layer ([ADR-0004](adr/0004-agents-is-the-application-layer.md))                                            |

Two consequences worth internalising before you edit anything:

- **`extensions/adminbot` must not import core internals.** It reaches the core only through
  `openclaw/plugin-sdk/*`, and `extensions/tsconfig.package-boundary.*` enforces that
  mechanically by remapping those subpaths onto built `.d.ts` files. Cross-plugin wiring
  (Slack Connect invites, core device pairing) is injected into `host/main.ts` as `deps`
  precisely because the plugin may not import it.
- **`workflows/` and `connectors/` look like duplication and are not.** OpenReview, Overleaf
  and social posting each appear on both sides because `workflows/*` produce typed proposals
  and `connectors/*` consume approved ones. Collapsing a pair into one per-integration module
  would dissolve the approval gate — see
  [ADR-0002](adr/0002-adminbot-executors-features-seam.md) before you "tidy" it.
- **The product tree follows the AdminBot v2 taxonomy** (`workflows/`, `connectors/`,
  `adapters/`, `kernel/`, `persistence/`, `privacy/`, `api/`, `content/`), so a reader of
  the v2 design document can navigate v1 — see
  [ADR-0007](adr/0007-adminbot-adopts-the-v2-taxonomy.md). The names are shared; the
  architecture is not yet.

## Directory map

### Top level

| Directory     | Files | What it is                                                                                                  |
| ------------- | ----: | ----------------------------------------------------------------------------------------------------------- |
| `src/`        | 8,469 | the inherited OpenClaw core: gateway, agent runtime, channels, config, CLI                                  |
| `extensions/` |   651 | the nine bundled plugins plus the package-boundary tsconfigs                                                |
| `ui/`         |   531 | the Control UI (Vite + TypeScript); `src/ui/adminbot/` holds the AdminBot surfaces                          |
| `packages/`   |   390 | 16 workspace libraries with no dependency on the core (see below)                                           |
| `scripts/`    |   134 | build, check and `adminbot-*` operational scripts; `lib/` holds their shared helpers                        |
| `test/`       |    86 | cross-cutting test harness: `global-setup.ts`, `non-isolated-runner.ts`, `scripts/`, `helpers/`             |
| `docs/`       |    18 | this page, [adr/](adr/), [tools/](tools/), [deploy/](deploy/), [refactor-baseline.md](refactor-baseline.md) |
| `deploy/`     |     9 | the Aurora host bootstrap                                                                                   |
| `config/`     |     9 | check-lane configuration: `layering.json`, `dir-size-grandfather.json`, `tsconfig/oxlint.*.json`            |
| `git-hooks/`  |     1 | the `pre-commit` hook (formats and lints staged files)                                                      |

### `src/` domains with ≥20 files

| Domain       | Files | What it owns                                                                                                |
| ------------ | ----: | ----------------------------------------------------------------------------------------------------------- |
| `agents`     | 1,778 | the application layer: everything an agent run is ([ADR-0004](adr/0004-agents-is-the-application-layer.md)) |
| `infra`      |   779 | process-level plumbing: exec, outbound delivery, install, heartbeat, net, state                             |
| `gateway`    |   720 | the RPC server, its methods, sessions, protocol and clients                                                 |
| `commands`   |   690 | user-facing command implementations, `doctor` chief among them                                              |
| `plugins`    |   624 | the plugin host: discovery, manifests, contracts, runtime, install                                          |
| `plugin-sdk` |   542 | the port surface extensions import (flat by decision)                                                       |
| `auto-reply` |   539 | inbound message → reply decision → dispatch                                                                 |
| `cli`        |   442 | the `openclaw` binary's argument surface and sub-CLIs                                                       |
| `config`     |   378 | config schema, IO, mutation, redaction, session config                                                      |
| `channels`   |   378 | channel-agnostic message model, turn kernel, channel-plugin registry                                        |
| `cron`       |   212 | scheduled jobs and their timer service                                                                      |
| `shared`     |   163 | the single home for cross-cutting helpers ([ADR-0005](adr/0005-shared-is-the-helper-home.md))               |
| `secrets`    |   125 | secret refs, keyring access, redaction                                                                      |
| `skills`     |   102 | skill-pack discovery and loading                                                                            |
| `acp`        |    98 | Agent Client Protocol translation and control plane                                                         |
| `llm`        |    81 | provider-independent LLM contracts and OAuth helpers                                                        |
| `security`   |    80 | policy checks and sandbox posture                                                                           |
| `logging`    |    71 | subsystem loggers and the diagnostics timeline                                                              |
| `daemon`     |    71 | the background daemon lifecycle                                                                             |
| `hooks`      |    64 | message and agent hook plumbing                                                                             |
| `tasks`      |    59 | the task registry                                                                                           |
| `test-utils` |    50 | shared test doubles for core suites                                                                         |
| `media`      |    49 | media handling that ~50 non-test modules still import                                                       |
| `flows`      |    42 | multi-step interaction flows                                                                                |
| `process`    |    34 | child-process supervision                                                                                   |
| `wizard`     |    33 | interactive setup wizard and its i18n                                                                       |
| `sessions`   |    24 | session identity primitives                                                                                 |
| `node-host`  |    20 | node-host runtime glue                                                                                      |

Everything below 20 files (`routing`, `state`, `status`, `model-catalog`, `context-engine`,
`trajectory`, `pairing`, `memory-host-sdk`, `commitments`, `tools`, `transcripts`,
`bootstrap`, `web-search`, `web-fetch`, and a handful of two-file shims) is a leaf you can
read in one sitting.

### Inside the phase-3 regrouped directories

These are the directories the restructure sub-grouped, so their subdirectory names are the
map. Everything else in `src/` is still flat by design.

- **`src/config`** — `channel`, `env`, `gateway`, `io`, `legacy`, `markdown`, `mutate`,
  `paths`, `plugin`, `redact`, `runtime`, `schema`, `sessions`, `types`, `zod`
- **`src/commands`** — `agent`, `agents`, `auth`, `channel-setup`, `channels`, `configure`,
  `daemon`, `doctor` (250 files on its own), `gateway`, `gateway-status`, `maintenance`,
  `migrate`, `models`, `onboard`, `onboard-non-interactive`, `sandbox`, `sessions`, `setup`,
  `status`, `status-all`
- **`src/cli`** — `config`, `cron-cli`, `daemon-cli`, `devices`, `gateway-cli`, `node-cli`,
  `nodes-cli`, `plugins`, `program` (the commander wiring), `send-runtime`, `shared`,
  `skills`, `update-cli`
- **`src/infra`** — `approvals`, `command-analysis`, `command-explainer`, `diagnostics`,
  `exec`, `format-time`, `heartbeat`, `install`, `net`, `outbound`, `providers`, `state`,
  `system`, `tls`
- **`src/gateway`** — `auth`, `client`, `control`, `hooks`, `http`, `methods`, `node`,
  `protocol`, `server`, `server-methods` (one module per RPC method), `sessions`, `test`
- **`src/auto-reply`** — `reply` (the pipeline), `usage-bar`, `test-helpers`.
  `src/auto-reply/reply` in turn holds `agent`, `commands`, `commands-acp`,
  `commands-subagents`, `directives`, `dispatch`, `exec`, `export-html`, **`get-reply`**,
  `inbound`, `providers`, `queue`, `session`, `test-fixtures`
- **`src/plugins`** — `capability-runtime-vitest-shims`, `compat`, `config`, `contracts`,
  `embedding`, `hooks`, `host`, `install`, `manifest`, `providers`, `runtime`,
  `test-helpers`, `web`
- **`src/agents`** — `acp`, `agent-hooks`, `auth`, `auth-profiles`, `cli-runner`, `command`,
  `compaction`, `embedded`, `embedded-agent-helpers`, `embedded-agent-runner` (298 files,
  including its own `run/` stage directory), `harness`, `mcp`, `models`, `modes`, `prompt`,
  `runtime`, `runtime-plan`, `sandbox`, `schema`, `sessions`, `subagents`, `templates`,
  `test-helpers`, `tools`, `transport`, `utils`, `workspace`
- **`src/channels`** — `allowlists`, `inbound-event`, `message`, `message-access`, `plugins`,
  `status`, `transport`, `turn`

### `packages/`

Workspace libraries with no dependency on `src/`. None declares a `description` in its
`package.json`, so these lines come from each package's public barrel.

| Package              | What it exports                                                                        |
| -------------------- | -------------------------------------------------------------------------------------- |
| `acp-core`           | shared ACP session, metadata and runtime-helper contracts                              |
| `agent-core`         | the agent loop, harness, session storage, compaction and execution environments        |
| `gateway-client`     | the gateway connection client, device auth, readiness and timeout helpers              |
| `gateway-protocol`   | the wire types, JSON schemas and validators both ends of the gateway compile against   |
| `llm-core`           | provider-independent LLM contracts, diagnostics and event-stream types                 |
| `llm-runtime`        | the API-provider registry and stream helpers                                           |
| `markdown-core`      | Markdown parsing, rendering, chunking and table conversion                             |
| `media-core`         | media URL, MIME, path-policy and bounded-read helpers                                  |
| `memory-host-sdk`    | the memory engine surface (storage, embeddings, QMD, query, status) as subpath exports |
| `model-catalog-core` | model-catalog normalization, provider ids and model refs                               |
| `net-policy`         | IP parsing, SSRF-relevant address classification and URL redaction                     |
| `normalization-core` | string/number/record coercion and normalization helpers                                |
| `plugin-sdk`         | a thin public facade that re-exports selected `src/plugin-sdk/*` modules as a package  |
| `terminal-core`      | terminal formatting: ANSI, links, palettes, progress lines, styled prompts             |
| `tool-call-repair`   | recovery of model-emitted plain-text tool calls                                        |
| `web-content-core`   | shared provider runtime for web-content fetching                                       |

`packages/sdk/` is not a package: it holds only a `node_modules` directory and no tracked
files. Ignore it.

### `ui/`

`ui/src/ui/` is mostly flat, with the surfaces grouped into `views/` (one module per tab),
`controllers/` (gateway state per tab), `chat/`, `components/`, `types/` and
`adminbot/` (the member-facing AdminBot tabs plus `access.ts`, the visibility table).
`ui/src/ui/navigation.ts` holds `TAB_GROUPS` and the `Tab` union.

## The request lifecycle

One inbound Slack message, end to end. Every hop below was verified by following the actual
imports.

1. **Channel inbound.** `extensions/slack/src/monitor/message-handler.ts` and
   `.../message-handler/dispatch.ts` import from `openclaw/plugin-sdk/channel-inbound`,
   which re-exports `src/channels/message/inbound-reply-dispatch.ts`
   (`src/plugin-sdk/channel-inbound.ts` is the re-export). The channel-agnostic turn model
   lives in `src/channels/turn/kernel.ts`, which builds the reply pipeline via
   `src/channels/message/reply-pipeline.ts`.
2. **Auto-reply dispatch.** `inbound-reply-dispatch.ts` imports `withReplyDispatcher` from
   `src/auto-reply/dispatch.ts` and `dispatchReplyFromConfig` from
   `src/auto-reply/reply/dispatch/dispatch-from-config.ts`. `dispatch.ts` is the thin entry
   (`dispatchInboundMessage`); `dispatch-from-config.ts` is where the decision actually
   happens, and it lazily loads
   `src/auto-reply/reply/get-reply/get-reply-from-config.runtime.ts`.
3. **Get-reply pipeline.** `src/auto-reply/reply/get-reply/get-reply.ts` resolves
   directives, model overrides, session binding and inline actions, then hands to
   `get-reply-run.ts`, which pulls agent-side state from `src/agents/*`
   (`agent-scope.js`, `harness/policy.js`, `embedded-agent-runner/sandbox-info.js`).
4. **Agent run.** `src/auto-reply/reply/agent/agent-runner.ts` and its sibling
   `agent-runner-execution.ts` drive the run, importing from
   `src/agents/embedded-agent-runner/` (`runs.js`, `delivery-evidence.js`,
   `result-fallback-classifier.js`). The run body itself is
   `src/agents/embedded-agent-runner/run.ts` → `run/attempt.ts`, with its stages split into
   dot-suffix siblings (`attempt.llm-boundary.ts`, `attempt.session-lock.ts`, …). The public
   entry is `runEmbeddedAgent` from `src/agents/embedded/embedded-agent.ts`.
5. **Gateway.** The run reports back through `src/gateway/`: `attempt.llm-boundary.ts`
   imports `gateway/server-methods/agent-timestamp.js`, and agent tools reach the gateway via
   `src/gateway/call.ts`. The Control UI's own entry is the mirror image —
   `src/gateway/server-methods/chat.ts` imports `dispatchInboundMessage` from
   `src/auto-reply/dispatch.ts`, so a browser message joins the pipeline at step 2.

## I want to…

| Task                           | Where                                                                                                                                                                      | Read first                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Add a slash command            | handler in `src/auto-reply/reply/commands/commands-*.ts`, registration in `src/auto-reply/commands-registry.data.ts`                                                       | —                                                                        |
| Add a provider transport       | a new `extensions/<provider>/` adapter; stream plumbing in `src/agents/transport/`                                                                                         | [ADR-0003](adr/0003-plugin-sdk-stays-flat.md)                            |
| Add an AdminBot workflow       | `extensions/adminbot/src/workflows/<area>/` — proposals only, never a connector call                                                                                       | [ADR-0007](adr/0007-adminbot-adopts-the-v2-taxonomy.md)                  |
| Add a connector (executor)     | `extensions/adminbot/src/connectors/<name>.ts`, register in `composite.ts`, wire in `host/main.ts`                                                                         | [AGENTS.md](../AGENTS.md) hard rules                                     |
| Add reviewed org data          | `extensions/adminbot/content/<area>/` — templates and datasets, never runtime state or secrets                                                                             | [ADR-0007](adr/0007-adminbot-adopts-the-v2-taxonomy.md)                  |
| Add an action type             | `extensions/adminbot/src/contracts/actions.ts` + a proposer + a connector, or it fails closed                                                                              | [ADR-0002](adr/0002-adminbot-executors-features-seam.md)                 |
| Change the config schema       | `src/config/zod/` and `src/config/schema/`; IO in `src/config/io/`                                                                                                         | —                                                                        |
| Add a check lane               | `scripts/check-*.mjs` + a `package.json` script + an entry in `buildCheckPlan` in `scripts/check.mjs`                                                                      | `scripts/check-dir-size.mjs` as the model                                |
| Move files                     | write a manifest in `scripts/moves/*.json`, run `scripts/lib/codemod-move.ts`; one move per commit                                                                         | [ADR-0001](adr/0001-targeted-subgrouping-over-full-hexagonal-reshape.md) |
| Split a big file               | dot-suffix siblings next to the original (`attempt.session-lock.ts`); characterize the seam first                                                                          | [ADR-0006](adr/0006-deferred-monster-splits.md)                          |
| Find why a message got a reply | `src/auto-reply/reply/dispatch/dispatch-from-config.ts`, then the get-reply pipeline                                                                                       | the lifecycle above                                                      |
| Add a UI tab                   | `ui/src/ui/views/<tab>.ts` + `controllers/<tab>.ts`, `TAB_GROUPS`/`Tab` in `navigation.ts`, visibility in `adminbot/access.ts`                                             | [AGENTS.md](../AGENTS.md) — the access table is not security             |
| Add a `plugin-sdk` subpath     | **three registrations**: `src/plugin-sdk/<name>.ts`, the `./plugin-sdk/<name>` entry in root `package.json` exports, and `extensions/tsconfig.package-boundary.paths.json` | [ADR-0003](adr/0003-plugin-sdk-stays-flat.md)                            |
| Add a cross-domain import      | edit `config/layering.json` — the frozen edge set is deliberate, not generated on demand                                                                                   | [ADR-0004](adr/0004-agents-is-the-application-layer.md)                  |
| Put a new helper somewhere     | `src/shared/` (root or a topical subdirectory). `src/utils.ts` is frozen.                                                                                                  | [ADR-0005](adr/0005-shared-is-the-helper-home.md)                        |
| Run one test lane              | `pnpm test <path>` — always scoped, never bare                                                                                                                             | the warning below                                                        |

## Gates and commands

```bash
pnpm build                        # tsdown; required before `pnpm adminbot`
pnpm test <path>                  # vitest, node + jsdom lanes — ALWAYS pass a path
pnpm tsgo:core / tsgo:extensions   # typecheck
pnpm lint / pnpm format
pnpm check / pnpm check:changed    # the aggregate lanes
pnpm ui:build
```

| Lane            | Command                                       | Baseline                                               |
| --------------- | --------------------------------------------- | ------------------------------------------------------ |
| Core types      | `pnpm tsgo:core`                              | 15 errors, all in three `ui/` files                    |
| Extension types | `pnpm tsgo:extensions`                        | clean                                                  |
| Lint            | `pnpm lint`                                   | 270 errors / 0 warnings                                |
| Max file lines  | (`max-lines` inside lint)                     | threshold 2200, tests exempt; 39 grandfathered sources |
| Format          | `pnpm format:check`                           | 36 unformatted files                                   |
| Import cycles   | `pnpm check:import-cycles`                    | 0 runtime value cycles                                 |
| Layering        | `pnpm check:layering`                         | 0 failures, 14 warnings                                |
| Directory size  | `pnpm check:dir-size`                         | 0 failures (12 grandfathered directories)              |
| Dead files      | `pnpm deadcode:unused-files`                  | green                                                  |
| AdminBot suite  | `pnpm test extensions/adminbot`               | 29 files / 392 tests, all green                        |
| Script tests    | `node scripts/test-projects.mjs test/scripts` | 20 files / 113 tests, 6 known failures                 |

**Growth in red is a failure; pre-existing red is not.** The full, authoritative numbers —
including which specific tests fail and why — live in
[docs/refactor-baseline.md](refactor-baseline.md). Neither `pnpm check` nor
`pnpm check:changed` diffs against them: they exit 0 and _warn_ on known-red lanes, so you
must compare counts by hand.

**Targeted invocations only.** A full `pnpm build` and any whole-repo vitest sweep OOM-thrash
the dev box. Scope every test run to a path. A large lane can wedge a vitest process rather
than fail it — when output stops, kill it and re-run per file; the per-file counts sum to the
same baseline.

**Pre-commit.** `git-hooks/pre-commit` runs `oxfmt --write` on staged files, re-stages them,
then lints them through the same `scripts/run-oxlint.mjs` entry `pnpm lint` uses. Because the
lint baseline is known-red, a commit touching an already-red file will be blocked on
pre-existing errors; `git commit --no-verify` is the documented escape, and the hook says so
when it fires. Verify by hand that you added nothing new.
