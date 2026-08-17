# Refactor baseline — branch `refactor/navigable-structure`

Recorded 2026-08-08 at commit `94303b53715` (after repairing the test/lint
runners the vitest-matrix collapse left broken). Every step of the
restructure is gated against these numbers: **growth in red is a failure;
pre-existing red is not.** Update this file only when a step legitimately
changes a number (say which step, and why).

## Gate-lane baselines

| Lane            | Command                                             | Baseline                                                                                                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core types      | `pnpm tsgo:core`                                    | 15 errors, all `ui/`: `adminbot/views/admin.ts` ×1, `adminbot/views/profile.ts` ×7, `views/chat.ts` ×7                                                                                                                                                                                                      |
| Extension types | `pnpm tsgo:extensions`                              | clean                                                                                                                                                                                                                                                                                                       |
| Test types      | `pnpm tsgo:core:test` / `pnpm tsgo:extensions:test` | 272 errors in 54 files / 21 errors in 8 files                                                                                                                                                                                                                                                               |
| Lint            | `pnpm lint`                                         | 270 errors / 0 warnings (extensions 98, ui 101, scripts 52, src 18, packages 1)                                                                                                                                                                                                                             |
| Max file lines  | (`eslint/max-lines` in `pnpm lint`)                 | threshold 2200, tests exempt by override; 39 source files carry a `// oxlint-disable max-lines` grandfather header (was threshold 3500 / 40 files, 34 of them tests — see ADR-0006). Contributes 0 of the 270 lint errors.                                                                                  |
| Format          | `pnpm format:check`                                 | 36 unformatted files (was recorded as 105; the lane is `oxfmt`, not prettier, and had already been brought down before phase 3 — re-measured 2026-08-08)                                                                                                                                                    |
| Import cycles   | `pnpm check:import-cycles`                          | 0 runtime value cycles                                                                                                                                                                                                                                                                                      |
| Layering        | `pnpm check:layering`                               | green: 604 frozen `src/` domain edges, 0 failures, 14 warnings (3 grandfathered `plugin-sdk` port-surface edges + 11 aspirational `shared` leaf edges)                                                                                                                                                      |
| Directory size  | `pnpm check:dir-size`                               | green: 274 directories, 12 over the 80-non-test-file limit, all 12 grandfathered at their current counts, 0 warnings                                                                                                                                                                                        |
| Dead files      | `pnpm deadcode:unused-files`                        | green; allowlist matches 16 intentional entries                                                                                                                                                                                                                                                             |
| AdminBot suite  | `pnpm test extensions/adminbot`                     | 29 files / 392 tests, all green (was 28 / 384; `connectors/email-html.test.ts` added 8 passing tests with the HTML email body — the invariant is zero failures, not a fixed count)                                                                                                                          |
| Script tests    | `node scripts/test-projects.mjs test/scripts`       | 20 files / 113 tests; 6 failures: adminbot-reimbursement-from-email ×1, aurora-qwen35-setup ×2, aurora-runtime-bootstrap ×3; adminbot-email-automation still dies at import. (Was 18/89 before `check-layering.test.ts` and `check-dir-size.test.ts` added 24 passing tests; the failure set is unchanged.) |
| auto-reply lane | `pnpm test src/auto-reply`                          | 198 files; 13 files / 14 tests fail (3 of those files die at import: commands-name, dispatch-acp, dispatch-from-config)                                                                                                                                                                                     |
| Aggregate check | `pnpm check`                                        | exit 0, warning on the known-red format/lint/tsgo:core lanes                                                                                                                                                                                                                                                |
| src/config lane | `pnpm test src/config`                              | 148 files; 1795 pass / 55 skip / 30 pre-existing failures (upstream leftovers, e.g. `talk-defaults.test.ts` reads deleted macOS sources)                                                                                                                                                                    |
| Changed gate    | `pnpm check:changed`                                | exit 0; warns on the known-red typecheck-core and lint lanes                                                                                                                                                                                                                                                |
| UI i18n         | `pnpm ui:i18n:check`                                | known red on lab main — ignore                                                                                                                                                                                                                                                                              |
| UI tests        | (jsdom lane)                                        | 14 known failures per AGENTS.md                                                                                                                                                                                                                                                                             |

## Known-broken tooling still to repair

- ~~The `openclaw/plugin-sdk/media-runtime` export subpath resolves to nothing~~ —
  done. The export map declared 20 plugin-sdk subpaths with no source behind them,
  all of them for subsystems the deep clean removed (speech, media/image/video/music
  generation, realtime voice, browser). Nineteen were dropped. `media-runtime` was
  rebuilt instead, because two surviving plugins import it: it is now a narrow
  re-export of `src/media/{fetch,store,qr-image}` rather than the old broad barrel,
  and `src/media/qr-image.ts` came back with it since `extensions/device-pair`
  calls `writeQrPngTempFile` and `renderQrPngDataUrl` at runtime.
  `test/scripts/adminbot-email-automation.test.ts` now collects and runs; 5 of its
  6 tests pass, and the survivor is an assertion failure, not an import crash.
- `deprecated-internal-config-api.test.ts` reports 7 real violations of the config
  boundary rules: five in `src/config/io/io.ts` (2749, 2758, 2773, 2916, 3008), one
  in `scripts/adminbot-email-automation.ts:752`, one in
  `src/plugins/install/bundled-capability-runtime.test.ts:9`. The guard that finds
  them was restored, not the code it judges — decide per site whether `io.ts` owns
  the seam it is being flagged for.
- ~~`pnpm build` does not reach a compiler~~ — done. The build plan named four
  package scripts the deep clean had deleted along with their backing files, and
  each only surfaced once the one before it was cleared. All four were pruned
  rather than restored, on the evidence that nothing in this fork consumes them:
  - `plugins:assets:build` / `plugins:assets:copy` dispatched through
    `scripts/bundled-plugin-assets.mjs` to whatever a bundled plugin declared under
    `openclaw.assetScripts`. No `extensions/*/package.json` declares that key today,
    and none declared it at `0cb0e76b29f^` either, so the phases were already no-ops
    before the script was deleted. The only plugin that ever used them was canvas,
    which is not part of this fork.
  - `build:plugin-sdk:dts`, `write-plugin-sdk-entry-dts` and
    `check-plugin-sdk-exports` were the npm-publish packaging pipeline. The latter
    two scripts no longer exist, and tsdown already emits the declarations they
    assembled — a clean run writes `dist/plugin-sdk/*.d.ts` and
    `dist/plugin-sdk/webhook-path.js` itself. `build:docker` has skipped this trio
    since `49b248a3334`.

  Two surviving scripts also had to stop assuming deleted plugins:
  `scripts/write-cli-startup-metadata.ts` hashed sources under `extensions/browser`
  and `extensions/canvas` (its `updateHashFromFiles` now skips absent files, and the
  browser help lane degrades to empty when the plugin is not bundled), and
  `scripts/write-cli-compat.ts` imported `daemon-cli-compat` with a `.js` specifier —
  a phase-3 regression from `36b66bdba71`, since node's type-stripping does not remap
  `.js` onto a `.ts` source for a value import.

- The bundled `anthropic` plugin was removed from this fork but
  `src/plugin-sdk/anthropic-cli.ts` still loads its public surface eagerly.
  Anything that transitively imports `src/agents/cli-runner/prepare.ts` from a
  test dies at collection —
  `src/auto-reply/reply/commands/commands-name.test.ts` is the visible case, and
  its collection crash is what was poisoning `commands-gating.test.ts` (see the
  isolate note below).
- ~~`scripts/check.mjs` (`pnpm check`) references 21 deleted package scripts~~ —
  done: the plan now names only surviving scripts, and lanes with a known-red
  baseline warn instead of failing. The npm-shrinkwrap guard is scoped to the
  two dirs that track a shrinkwrap, so `pnpm check:changed` is green.
- ~~`src/scripts/*.test.ts` includes `test-projects.test.ts`, which asserts the
  deleted vitest-matrix routing~~ — done: the directory was triaged and removed;
  `control-ui-i18n.test.ts` moved to `test/scripts/`. Lane counts unchanged
  (still 6 failures), so no baseline number moved.

## UI lane determinism

The lane runs `isolate: false` across two workers, so module and global state carries from one
file into the next and worker assignment shifts run to run. Three leaks were fixed:

- the i18n singleton never dropped a lazily loaded locale bundle, so a file that switched to
  zh-CN left it loaded for everything after it;
- `feedback-widget.test.ts` installed a `getItem`/`setItem`-only `localStorage` via
  `defineProperty` and never removed it, leaving later files a Storage that threw on `clear()`;
- `getSafeStorage` accepted any object with `getItem` and `setItem` as a `Storage`, and checked
  the real DOM last, so under Vitest jsdom's own storage was rejected and every UI test had to
  overwrite the global to get storage at all.

What remains: `ui/src/ui/components/feedback-widget.test.ts` fails in roughly 1 run in 6, always
the same five assertions, always passing in isolation and in every pairwise run tried. Waiting for
the shadow root to render before clicking cut it from 6-in-12 to 2-in-12, which says the residue is
timing rather than ordering — the custom-element registry is global and survives `vi.resetModules`,
so when an earlier file has already registered `adminbot-feedback-widget` the element under test
comes from a stale class. Adding a `console.log` to the assertion path made it disappear for six
runs, so instrument it carefully. The clean fix is to run this one file isolated.

## Environment constraints

- Full `pnpm build` and whole-repo vitest sweeps OOM this box — targeted
  invocations only (`pnpm test <dir>`, tsgo lanes, `pnpm check:changed`).
- No remote: commits only, on this branch.
- A large vitest lane can wedge a single vitest process rather than fail — the
  `src/gateway` lane had to be driven one file at a time to finish. When a lane
  stops producing output, kill it and re-run per file; the per-file counts sum
  to the same baseline.
- A killed run leaves `.git/openclaw-local-checks/heavy-check.lock` behind. It
  goes stale after 30s, so the next heavy command waits that long before
  proceeding — that pause is the lock, not a hang.
- A test file that throws while _collecting_ poisons whichever file the worker
  runs next. `test/non-isolated-runner.ts` does its module/mocker reset in
  `onAfterRunSuite`, which never fires for a file that dies at import, so the
  real (unmocked) module graph that file pulled in stays cached. Symptom: a
  `vi.mock` factory silently does not apply and the assertion on its mock reports
  zero calls — intermittently, depending on file ordering. Local workaround in
  the affected file: `vi.hoisted(() => { vi.resetModules(); })`, which runs
  before the static imports bind. This is why `src/auto-reply` had a phantom
  14th failure (`commands-gating`) sitting behind `commands-name`'s import crash.
- `src/gateway/server-methods.test.ts` is load-dependent-slow: it passes, but
  its wall time swings with what else is running on the box. Give it its own
  invocation before concluding a lane is stuck.

## Phase 3 smoke (structural moves complete)

Run 2026-08-08 at `f2e43108df3`, after the get-reply move and the
`src/utils` → `src/shared` fold. Phase 3 touched no UI source.

| Step                                                | Result                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm tsgo:core`                                    | 15 errors — the same 3 `ui/` files as the baseline. No change.                                                                                                                                                                                                                   |
| `pnpm tsgo:extensions`                              | clean                                                                                                                                                                                                                                                                            |
| `pnpm test extensions/adminbot`                     | 28 files / 384 tests, all green                                                                                                                                                                                                                                                  |
| `pnpm ui:build`                                     | pass (built in ~0.9s; the chunk-size and `INEFFECTIVE_DYNAMIC_IMPORT` warnings are pre-existing)                                                                                                                                                                                 |
| `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` | **failed in 0.4s — not an OOM.** `scripts/build-all.mjs` phase 1 shells out to `pnpm plugins:assets:build`, which is not a script in `package.json`. Pre-existing (missing at the baseline commit `94303b53715`), unrelated to the moves. Repaired since — see the re-run below. |
| fallback: `pnpm tsgo:prod`                          | 15 errors, identical to `tsgo:core` — the same 3 `ui/` files, nothing from `src/`                                                                                                                                                                                                |
| fallback: `dist/` spot-check                        | intact: `dist/extensions/adminbot/api.js` and `dist/index.js` still present from the 04:28 pre-phase-3 build, 4129 files total. Only `dist/control-ui/` is newer, from this run's `ui:build`.                                                                                    |

### Build repair re-run

Run 2026-08-08 after pruning the four deleted package scripts out of the build plan
(see the tooling note above). `pnpm build` now reaches every phase.

| Step                                                | Result                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_OPTIONS=--max-old-space-size=4096 pnpm build` | **exit 0 in 42.2s.** No OOM and nowhere near the 12min cap; `tsdown` is 39.7s of it. Produces `dist/extensions/adminbot/api.js`, so AGENTS.md verification step 1 passes. |
| `pnpm ui:build` (inside `build`)                    | pass in 0.88s — the chunk-size warning is pre-existing                                                                                                                    |
| ephemeral-port route check                          | `/adminbot` 200 · `/deadlines` 200 · `/lab/members` 401 · `/settings` 401 · `/audit` 401 — exactly the AGENTS.md contract                                                 |

`SERVICE_PORT` in `extensions/adminbot/host/main.ts` is a hard-coded `8765` and the
systemd unit holds it on this box, so the route check ran an out-of-repo driver that
calls the same `createAdminBotHost` composition and listens on `127.0.0.1:8799`.
`node start-adminbot.mjs` itself cannot bind while the unit is up.

Nothing in phase 3 moved a gate number. The one apparent regression —
`src/auto-reply` at 14 failing files instead of 13 — was a pre-existing flake,
not a move: see the isolate-false note under environment constraints.

### Root-file counts per restructured directory

Root files only (`git ls-files src/<d> | sed "s|^src/<d>/||" | grep -v / | wc -l`),
recounted at `f2e43108df3`.

| Directory              | Root files | Subdirs | Files in tree |
| ---------------------- | ---------- | ------- | ------------- |
| `src/commands`         | 45         | 20      | 690           |
| `src/config`           | 100        | 15      | 378           |
| `src/cli`              | 107        | 13      | 442           |
| `src/auto-reply/reply` | 133        | 14      | 456           |
| `src/shared`           | 144        | 1       | 163           |
| `src/gateway`          | 191        | 12      | 707           |
| `src/agents`           | 196        | 27      | 1744          |
| `src/plugins`          | 222        | 13      | 624           |
| `src/infra`            | 287        | 14      | 779           |

`src/shared` is new to this table: the `src/utils` fold made it a restructured
directory, and ADR-0005 records that its root growing past the ≤80 target is
accepted, with topical subdirectories as the relief valve.

## Phase 6 complete — 2026-08-08

Documentation and ratchet phase. No source behaviour changed; the only code-shaped
edit was the `max-lines` grandfather headers moving from 34 test files onto 33
additional sources when the threshold dropped 3,500 → 2,200 and tests were
exempted (see ADR-0006). Landed in this phase:

- `.oxlintrc.json` — test exemption + the 2,200 threshold
- `docs/architecture.md` — the navigation guide ADR-0001 promised
- `.ai-style-rules.md` — the conventions, with two genuine conflicts recorded
  unresolved (`.js` vs `.ts` import specifiers in `ui/`; dot- vs dash-form
  test-helper filenames)
- Root `AGENTS.md` refreshed; `src/plugins/AGENTS.md` had two paths corrected
  for the phase-3 `providers/` and `web/` regrouping

Full-gate sweep at this commit:

| Lane                                          | Result                                         |
| --------------------------------------------- | ---------------------------------------------- |
| `pnpm lint`                                   | 270 errors, 0 `max-lines` occurrences          |
| `pnpm tsgo:core`                              | 15 errors in the same 3 `ui/` files            |
| `pnpm tsgo:extensions`                        | clean                                          |
| `pnpm format:check`                           | 36 unformatted files                           |
| `pnpm check:import-cycles`                    | 0 runtime value cycles                         |
| `pnpm check:layering`                         | 604 edges, 604 frozen, 0 failures, 14 warnings |
| `pnpm check:dir-size`                         | 274 directories, 12 grandfathered, 0 failures  |
| `pnpm deadcode:unused-files`                  | green, 16 allowlist entries                    |
| `pnpm test extensions/adminbot`               | 28 files / 384 tests, all green                |
| `node scripts/test-projects.mjs test/scripts` | 20 files / 113 tests, 6 known failures         |
| `pnpm check`                                  | exit 0 (warns on format, lint, tsgo:core)      |
| `pnpm check:changed`                          | exit 0 (warns on typecheck core, lint)         |
| `pnpm build`                                  | exit 0 in ~45s, bare and with the heap flag    |

`pnpm build` was re-verified twice without `NODE_OPTIONS=--max-old-space-size=4096`
and did not OOM, so AGENTS.md's four verification steps are fully runnable again.
The "unrestricted builds OOM-thrash this box" warning is retired; unscoped
`pnpm test` is still the real hazard.
