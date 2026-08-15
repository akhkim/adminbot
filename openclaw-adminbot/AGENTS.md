# AGENTS.md

Working rules for this repo. Read [README.md](README.md) first for what AdminBot is and where
things live.

Conventions: see [.ai-style-rules.md](.ai-style-rules.md).

## What this repo is

A fork of upstream OpenClaw, cleaned down to what AdminBot runs. Nine bundled plugins survive
(`adminbot`, `slack`, `vllm`, `nvidia`, `ollama`, `openrouter`, `brave`, `memory-core`,
`device-pair`); the other ~130 were removed, along with the speech/talk subsystems, the native
apps, upstream CI and the npm release machinery. `src/media/` survives — 30 source files that
~50 non-test modules still import, including `src/plugin-sdk/` (8 files), `src/gateway/`,
`src/agents/`, `src/auto-reply/` and `src/channels/`.

`origin` is upstream `openclaw/openclaw` and is **not** pushable. The `lab` remote is a local
clone of the shared repo and shares no git history with this one — content moves dev → lab as
squashed sync commits, never as merges.

## Hard rules

- **The agent proposes; the service executes.** Anything with an external effect is a typed action
  in `extensions/adminbot/src/contracts/actions.ts` that goes through propose → approve → execute →
  audit. Do not add a code path that reaches Slack, Gmail, Calendar, Overleaf, OpenReview or a
  social network without passing the approval gate.
- **Unsupported action types fail closed.** Never record something as executed that no connector in
  `extensions/adminbot/src/connectors/` handled.
- **The Control UI access table is visibility, not security.** `ui/src/ui/adminbot/access.ts` hides
  tabs; the service re-checks every privileged route and the gateway enforces device scopes. A new
  privileged route needs a server-side check, not just a hidden tab.
- **Never commit secrets.** `.env`, `client_secret*.json` and `state/` are ignored and stay ignored.
  Channel and provider credentials live in `~/.openclaw/credentials/`.
- **`extensions/adminbot` must not import core internals.** It goes through
  `openclaw/plugin-sdk/*`. Cross-plugin wiring (Slack Connect invites, core device pairing) belongs
  in the launcher, which is why `host/main.ts` takes them as injected deps.

## Commands

```bash
pnpm build                       # tsdown; required before `pnpm adminbot`
pnpm test <path>                 # vitest, two lanes (node + jsdom ui)
pnpm tsgo:core / tsgo:extensions  # typecheck
pnpm lint / pnpm format
pnpm ui:build
pnpm check / pnpm check:changed  # aggregate lanes
pnpm check:layering              # frozen src/ domain edges (config/layering.json)
pnpm check:dir-size              # ≤80 non-test files per directory, ratcheted
```

Node 22.19+. Full-directory vitest sweeps OOM-thrash this box — scope every test run to a path.
`pnpm build` itself is fine again (~45s, exit 0), but it is the heaviest command here; do not run
it alongside a test lane.

[docs/architecture.md](docs/architecture.md) is the map — directory layout, the request lifecycle,
and a "where do I put this?" table. [docs/adr/](docs/adr/) records why the tree is shaped the way
it is, and [.ai-style-rules.md](.ai-style-rules.md) collects the conventions.

## Known-red baseline

Do not treat these as regressions; treat any _growth_ in them as one.
[docs/refactor-baseline.md](docs/refactor-baseline.md) is the source of truth — it carries every
lane, which specific tests fail, and why. This is the summary.

- `tsgo:core`: 15 errors, all in `ui/src/ui/adminbot/views/{profile,admin}.ts` and
  `ui/src/ui/views/chat.ts`
- UI suite: 14 failures — 10 in `views/chat.test.ts`, 2 in `i18n/translate`, 2 in
  `navigation.browser`
- `test/scripts`: 20 files / 113 tests, 6 failures — 1 in `adminbot-reimbursement-from-email`, 2 in
  `aurora-qwen35-setup`, 3 in `aurora-runtime-bootstrap`. `adminbot-email-automation` used to die
  at import on the `openclaw/plugin-sdk/media-runtime` subpath; that subpath is real again, so the
  spec collects and one assertion failure remains.
- `src/plugins/contracts` + `src/plugins/install`: 16 files / 53 failures, nearly all of them
  asserting against the ~130 plugins the deep clean removed (discord, matrix, telegram,
  migrate-hermes) or against provider registries those plugins fed.
- `lint`: 270 errors / 0 warnings (extensions 98, ui 101, scripts 52, src 18, packages 1). The
  `max-lines` rule inside that lane contributes 0 of them: the threshold is 2,200, tests are
  exempt, and the 39 source files over it carry a grandfather header naming
  [ADR-0006](docs/adr/0006-deferred-monster-splits.md).
- `format:check`: 36 unformatted files
- `tsgo:core:test`: 272 errors in 54 files; `tsgo:extensions:test`: 21 errors in 8 files
- `ui:i18n:check` is red
- Green and expected to stay green: `check:import-cycles` (0 cycles), `check:layering` (0
  failures, 14 warnings), `check:dir-size` (0 failures, 0 warnings), `deadcode:unused-files`,
  `deadcode:dependencies`, `pnpm build`

`pnpm check` and `pnpm check:changed` exit 0: lanes with a known-red baseline (format, lint,
`tsgo:core`, the test-type lanes) warn and let the run continue, and only a clean lane can fail
the gate. Neither runner diffs against the numbers above — compare by hand.

The AdminBot suite itself (`pnpm test extensions/adminbot`) is fully green — 38 files, 570 tests.
Keep it that way.

## Verification

Tests are a weak gate here: much of the surviving core is lazy-imported, so a clean typecheck
proves little. All four steps below are runnable again — `pnpm build` reached no compiler for a
while after the deep clean, because the build plan named four package scripts that had been
deleted along with their backing files. Those were pruned, and a bare `pnpm build` now exits 0 in
~45s. Before landing anything structural:

1. `pnpm build` — must produce `dist/extensions/adminbot/api.js`
2. `node start-adminbot.mjs` — or bind an ephemeral port if the systemd unit holds 8765; check
   `/adminbot` and `/deadlines` answer 200 and `/lab/members`, `/settings`, `/audit` answer 401
3. `pnpm ui:build`
4. `pnpm test extensions/adminbot`

Do not deploy to Aurora until all four pass: `scripts/aurora-adminbot-host.sh` `git archive`s the
whole repo, so a broken tree ships wholesale.

## Style

- TypeScript ESM, strict. Prefer real types over `any`.
- Comments explain _why_ — an invariant, an ordering constraint, a failure mode. Not what the line
  does.
- Split files around ~700 lines when it improves clarity. Generated files say so in a header and
  name their generator.
- American spelling. "AdminBot" in prose, `adminbot` in code and paths.
