# AdminBot UI design guide

How AdminBot pages should look. It applies to people and coding agents alike: read it before
adding or restyling anything under `ui/src/`. When a change breaks one of these rules, the PR says
why.

## Principles

1. **No grey boxes.** A section of a page is not a filled, bordered rectangle. Don't put
   `background: var(--card)`, `var(--bg-elevated)` or `var(--bg-muted)` together with a
   `1px solid` border around page sections, list rows or panels. Group things with whitespace,
   a heading, and at most a hairline divider (`border-top` / `border-bottom: 1px solid
var(--border)`).
2. **Whitespace before lines, lines before boxes.** Reach for spacing first (`--space-4` to
   `--space-6` between sections). Add a hairline only when spacing alone leaves two groups
   ambiguous. Use a box only for the exceptions listed below.
3. **Content lines up on one edge.** Rows and sections have no side padding (`padding-inline: 0`),
   so a row's text starts where its heading starts. An inset list under an un-inset heading looks
   like a box that lost its border.
4. **Hierarchy comes from type, not containers.** The page title is the largest text; a section
   heading is semibold `--control-ui-text-md`; supporting copy is `--muted` at
   `--control-ui-text-sm`. One idea gets one weight step. Don't add a border to make something
   look important.
5. **One accent.** `--accent` marks the primary action and the active state, nothing else. Warning
   and danger colours are for state (overdue, failed), never decoration.
6. **Quiet controls.** Inputs, selects and textareas are transparent with a 1px `--input` border,
   not grey-filled. Each section has at most one primary button. Secondary actions are
   `btn btn--sm` or text links.
7. **Rows, not cards.** A list of items is a list: one line per item, a hairline between items, a
   hover ground (`--bg-hover`) as the only affordance, and a chevron that brightens on hover.
8. **Settled things sink and fold.** Done, reviewed or historical items go to the bottom of the
   section, behind a `<details>` fold, with Undo where it applies.

## Where a filled surface is still right

A surface that floats over the page needs an opaque ground. These keep their background and
border:

- popovers, menus, dropdowns, tooltips, toasts, dialogs and drawers
- chat bubbles and tool-output blocks
- code and `pre` blocks
- chips, pills, badges, tabs and segmented toggles
- buttons

## Tokens

Use the tokens in `ui/src/styles/base.css` (`--space-*`, `--radius-*`, `--border`, `--muted`,
`--accent`, `--bg-hover`). Don't hard-code colours. Both themes must still pass
`ui/src/styles/theme-contrast.node.test.ts`.

## Checklist for a UI PR

- [ ] No new rule combines a grey fill with a border around a page section or row.
- [ ] Rows line up with their heading (no side padding on the row container).
- [ ] At most one primary (accent) button per section.
- [ ] Checked in both dark and light themes, and at phone width (640px).
