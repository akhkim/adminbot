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

## Less on the page

AdminBot is used by people who come to do one thing and leave. Every element on a page costs
attention, so each one has to earn its place. These rules come before the visual ones above.

9. **One job per page, said in the title.** The first screen answers "what do I do here?" with
   one primary action. Anything else is secondary or lives one click away.
10. **Show what needs the viewer; hide the rest.** A section with nothing in it doesn't render: no
    "0" counters, no "Nothing outstanding", no empty table. If the whole page is empty, show a single
    empty state with the one action that fills it.
11. **No instructions on the page.** No paragraphs explaining how the page works, where data comes
    from, or what a button will do. If a control needs a sentence of explanation, rename or redesign
    the control. A short subtitle under the page title is the limit. Rare, necessary detail goes in a
    "Why?" link or a tooltip.
12. **Data is always current.** No "Refresh" buttons. Load on open, update after every action, and
    poll quietly where the data changes underneath. A stale-data problem is a bug, not a button.
13. **One search, filters on demand.** A list gets one search box. Filters live behind a
    "Filters" control and show as removable chips once set. Never render more than one row of
    filter dropdowns by default.
14. **Actions appear where and when they apply.** Per-row actions show on hover or in the row's
    menu, not as a button repeated on every row. Admin-only controls are hidden from members, not
    labelled "Admins only".
15. **Progressive disclosure for rare paths.** Manual entry, "file by hand", history, settings and
    advanced options sit behind a fold or a secondary link, closed by default.
16. **Text fits its box.** Placeholders are short enough to show in full at 1280px and 375px.
    Table headers don't wrap; prefer fewer columns over cramped ones. Nothing overflows or is
    clipped at phone width.
17. **No page chrome above the title.** Status banners (offline, saved, sync) go in the header bar
    or a toast, never as a strip above the page heading.

### Copy

- Write like a product, not like a model: short, plain, specific. No "simply", no
  "Note that", no em-dash asides, no describing the system to the user.
- Labels are nouns, buttons are verbs ("Send request", not "Make a Request").
- Empty states say what will appear and give the action, in one line.

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
- [ ] No empty sections, zero counters, Refresh buttons or explanatory paragraphs.
- [ ] Filters beyond one search box are behind a "Filters" control.
- [ ] Placeholders and headers fit without truncation at 1280px and 375px.
