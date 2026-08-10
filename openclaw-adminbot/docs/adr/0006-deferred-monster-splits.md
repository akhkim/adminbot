# ADR-0006: Deferred monster-file splits

## Status

Accepted

## Context

This repo's own guidance says to "split files around ~700 lines when it improves
clarity" ([AGENTS.md](../../AGENTS.md), Style). Phase 4 of the restructure went
after the files furthest past that line. Ten source files in `src/` exceed 3,000
lines; the largest is more than seven times the guidance.

Phase 4 split the separable sections out of the four largest and left the rest.
That asymmetry is the thing this ADR records, because it is not obvious from the
resulting files why one 5,000-line module was cut down and another was not.

The pattern is the same in every case that resisted. These files are not large
because they accumulated many independent helpers — those extract cleanly, and
phase 4 extracted them. They are large because a _single function_ is large, and
that function threads mutable state across the stages a split would separate:
flags and cleanup callbacks assigned in one stage and read or invoked in another,
through nested `finally` blocks and closures that capture the enclosing scope.

Extracting a stage from such a body means one of two things:

- passing a mutable context object by reference, so the extracted stage can keep
  assigning the caller's bindings; or
- reordering side effects, so the extracted stage can take and return values.

Both are behavior changes. Neither is provable as behavior-preserving by the test
surface these modules have — which is the second half of the problem. The helpers
phase 4 extracted mostly had _no_ direct coverage; each extraction had to grow
characterization tests first. Doing the same for a 2,000-line function body that
touches session state, abort paths, transcripts and delivery is a project, not a
step in a restructure commit.

`src/infra/state/state-migrations.ts` is large for a different reason and defers
for a different one: it is an append-only migration ledger. Its size is a
function of the fork's history, and splitting it would put migrations in more
than one file, where their total order — the one thing a migration ledger must
guarantee — stops being readable from the source.

## Decision

We will defer the remaining monster-file splits rather than force them, and
govern the debt at the point of edit rather than by a one-time cleanup.

- The files listed below are grandfathered. Their current size is accepted and
  is not treated as a regression.
- The ~700-line guidance in AGENTS.md applies to new files and to new code added
  to these files. A change that grows one of these files should extract what it
  adds, not append to the body.
- A deferred split is unblocked by coverage, not by scheduling: the way to split
  `runEmbeddedAttempt` is to first characterize the stage boundary you intend to
  cut, then cut it.

Deferred, with the reason each one resisted:

| File                                                    | Lines after phase 4 | Why it is deferred                                                                                                                                                                                                  |
| ------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/embedded-agent-runner/run/attempt.ts`       | 5,465 (was 5,781)   | `runEmbeddedAttempt` is 4,917 of them: 25 function-scope mutable bindings, 8 `finally` blocks, 82 closures.                                                                                                         |
| `src/gateway/server-methods/chat.ts`                    | 2,492 (was 5,104)   | The `chat.send` handler is a single ~1,900-line arrow function holding dispatch, delivery, transcript and abort state in one scope.                                                                                 |
| `src/agents/transport/openai-transport-stream.ts`       | 2,875 (was 4,427)   | Two stream pumps (`processResponsesStream`, `processOpenAICompletionsStream`, 310 and 433 lines) accumulate partial assistant output across events in scope-local buffers every branch of the event switch mutates. |
| `src/agents/embedded-agent-runner/run.ts`               | 3,705 (was 4,067)   | `runEmbeddedAgentInternal` is 3,429 of them — the retry/failover loop, with the same threaded-cleanup shape as `attempt.ts`.                                                                                        |
| `src/infra/state/state-migrations.ts`                   | 4,097               | Append-only migration ledger; splitting it makes the migrations' total order unreadable and risks reordering.                                                                                                       |
| `src/cli/update-cli/update-command.ts`                  | 4,004               | Single command body with staged rollback; the stages share the partially-applied update state.                                                                                                                      |
| `src/plugins/runtime/loader.ts`                         | 3,377               | Plugin load is one ordered pipeline over a shared mutable registry.                                                                                                                                                 |
| `src/auto-reply/reply/agent/agent-runner-execution.ts`  | 3,344               | Same threaded-cleanup shape as the embedded runner it wraps.                                                                                                                                                        |
| `src/auto-reply/reply/dispatch/dispatch-from-config.ts` | 3,284               | Dispatch decision and delivery share one scope; three of its own test files already die at import (known-red).                                                                                                      |
| `src/agents/sessions/agent-session.ts`                  | 3,282               | Session lifecycle object; its methods share private mutable session state by design.                                                                                                                                |

## Alternatives considered

- **Force the splits now.** Rejected. Every candidate needs either a mutable
  context passed by reference or a side-effect reordering, and the modules do not
  have the characterization coverage to disprove a behavior change. The
  restructure's whole gate discipline is "growth in red is a failure" — a split
  that cannot be shown to preserve behavior fails that on the only axis that
  matters, whether or not the suite happens to stay green.
- **Raise the guidance to match reality** (say ~2,000 lines, or drop the number).
  Rejected: it would let new code inherit the debt. The guidance is aimed at the
  file being written today, and it is working — phase 4's extracted fragments are
  17 to 437 lines each. The problem is ten grandfathered files, not the rule.
- **Add an automated max-lines lint rule with a per-file allowlist.** Attractive,
  and the natural mechanism for the ratchet this ADR describes. Not done here:
  the lint lane is already 270 errors known-red, and adding a rule that fires on
  ten more files would make the "no growth in red" comparison harder to read, not
  easier. Recorded as follow-up work rather than rejected — and since landed,
  see the ratchet note under Consequences.

## Consequences

- Easier: the split that _was_ possible is done. Phase 4 moved 4,526 lines out of
  three entry files into 31 dot-suffix sibling fragments (17 to 437 lines each),
  and added 56 characterization tests over the previously-uncovered helpers it
  extracted from `run.ts`. The next person to touch one of these files has smaller
  units to work against and a smaller body to read around.
- Harder: ten files stay well past the guidance, and this ADR is the only place
  that says why. A reader who finds `attempt.ts` at 5,465 lines and assumes
  nobody looked at it will be wrong.
- Committed: the deferred splits are unblocked by characterization coverage.
  Anyone taking one on should expect the coverage to be most of the work, and
  should extract one stage at a time behind its own tests rather than attempting
  the whole body.
- Committed since: the ratchet exists. `oxlint`'s `max-lines` rule is on at
  error level, and every file over the threshold carries a
  `// oxlint-disable max-lines` header naming this ADR. The rule contributes
  zero errors at the 270-error lint baseline, so the "no growth in red"
  comparison still reads cleanly.
- The threshold started at **3,500 lines** — not the ~700 of the guidance and
  not the 1,600 first proposed, because those would have grandfathered 997 and
  276 files and a grandfather list that long is a list nobody reads. At 3,500
  the set was 40 files, but 34 of them were colocated `.test.ts` files. That is
  the wrong inventory: a test file is read top-down as a list of independent
  cases, so its length costs far less than the length of a source module whose
  parts interact, and 34 tests drowning 6 sources made the list say nothing
  about the debt this ADR governs.
- **Current setting: tests are exempt and the threshold is 2,200 lines.**
  `.oxlintrc.json` carries an override turning `max-lines` off for
  `**/*.test.ts`, `**/*.test-harness.ts`, `**/*.test-helpers.ts` and
  `**/*.test-support.ts`; the remaining rule covers source only. At 2,200 the
  grandfather set is **39 source files**, comparable in size to the old
  40-file list but made entirely of production code — and it now includes all
  ten files in the table above, so nothing in this ADR is governed by the table
  alone any more. Test files no longer carry the header at all.
- Ratcheting further is the same move: lower the number, add headers to whatever
  newly crosses, and check that `pnpm lint` still reports 270 errors with zero
  `max-lines` occurrences. The header on a file that is no longer over the
  threshold is itself a lint error (the lane runs with
  `unused-disable-directives`), so the inventory cannot silently go stale.
