# ADR-0005: src/shared is the helper home

## Status

Accepted

## Context

Before this decision the fork had three helper tiers with no rule about which
one a new helper belonged in:

- **`src/utils.ts`** — a single 227-line module at the src root, imported by 315
  files (312 of them under `src/`). It holds the oldest, most-used primitives.
- **`src/utils/`** — 29 non-test modules plus 15 test files, holding a second
  generation of the same kind of helper.
- **`src/shared/`** — 78 non-test modules (100 files at its root, plus
  subdirectories such as `shared/text/`), holding a third.

Nothing distinguished them. `message-channel.ts` lived in `src/utils/` while
`message-channel-*` consumers reached for `src/shared/`; `safe-json.ts` sat in
`utils/` while `balanced-json.ts` sat in `shared/`. A contributor adding a
helper had to guess, and the guess was unreviewable because no stated rule
existed to violate.

Collapsing the tiers downward is not symmetric. `src/utils/` is cheap to fold:
44 files, no name collisions with `src/shared/`, and the codemod rewrites the
importers mechanically. `src/utils.ts` is not: this repo writes explicit
relative paths rather than barrel imports, so splitting it churns 315 importing
files for a navigation gain that is close to zero — the module is small and its
exports are already the ones every contributor knows by name.

## Decision

We will make `src/shared/` the single home for cross-cutting helpers.

- Every file in `src/utils/` moves to `src/shared/`, keeping its filename. The
  directory is gone.
- New helpers go in `src/shared/` (its root, or an existing topical
  subdirectory such as `shared/text/`). There is no other correct location.
- `src/utils.ts` is frozen: no new exports, no new importers. Its 315 existing
  importers are left untouched.

## Alternatives considered

- **Keep `src/utils/` and add a re-export facade from `src/shared/`** — would
  preserve both paths and let importers migrate lazily. Rejected: barrel and
  re-export modules are against this repo's import convention (explicit path
  per module), and it would have institutionalized the ambiguity rather than
  removing it.
- **Also split `src/utils.ts` into `src/shared/` modules** — the tidiest end
  state, and the one a greenfield repo would pick. Rejected: 315 importing
  files rewritten in one commit, with no navigation gain to show for it. The
  file is one screen of well-known primitives, not a directory anyone gets lost
  in.
- **Fold `src/shared/` into `src/utils/` instead** — same mechanical cost, but
  `shared/` is the larger tier (78 modules vs 29), already has topical
  subdirectories, and "shared" describes the intent better than "utils".
  Rejected on all three counts.

## Consequences

- Easier: one obvious place to put a helper, and one place to look for one.
  `src/shared/` is now the answer to both questions.
- Harder: `src/shared/` root grows to 144 files (95 non-test), past the restructure's
  ≤80-files-per-directory target. Topical subdirectories (`shared/text/` and
  successors) are the intended relief valve, applied as families become clear —
  not preemptively.
- `src/utils.ts` shrinks only opportunistically: when a file that imports it is
  being edited for another reason, moving the helper it uses into
  `src/shared/` is welcome. There is no migration commit planned.
- The fold surfaced near-duplicate pairs that were previously separated only by
  directory: `safe-json` / `balanced-json`, `token-format` / `text-chunking`,
  and `usage-format` / `usage-types` + `usage-aggregates`. Merging them is
  deferred — each is a behavioral change needing its own reasoning and its own
  test run, and doing it inside a move commit would make the move
  un-reviewable. Each file carries a `NOTE(dedupe)` header pointing at its
  counterpart and at this ADR, so the debt is visible from the file rather than
  only from here.
