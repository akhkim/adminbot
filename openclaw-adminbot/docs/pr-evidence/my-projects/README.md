# My Projects & Papers

Synthetic evidence from the real service and Control UI: the dev service
(`scripts/start-adminbot-dev.ts`) on a throwaway database, seeded through the HTTP API with five
made-up projects for a made-up admin. No live records, members, or messages.

- `1-cards.png` — `/my-work`: the card list, and the project list under the sidebar entry. A
  filled dot is a lane with work that can be done now, a ring a lane that is only waiting, and no
  dot a finished lane. The rejected fifth project is left off by `GET /my/projects`.
- `2-dot-legend.png` — hovering a dot names the lane and what is open on it.
- `3-project-tab.png` — `/my-work/<paper>`: open work, venue targets, blockers, weekly updates.
- `4-archival-tab.png` — a lane tab as a plain form; a blocked slot says what it waits on.
- `5-venue-tab.png` — the submission, the venue decision, and the venue's stages.
- `7-choose-papers.png` — "Choose papers" turns the sidebar list into hide/show checkboxes.

These predate bringing the old card's controls onto the pages. Since then the Project tab also
carries the decision banner, project details, target editor, completion, the timeline and next
steps, the step controls and PaperFlow map, the people on the paper, edit history and delete; the
lane tabs draw the existing checklist renderer one branch per tab, so a slot is never locked behind
its upstream and the feedback request form sits on Writing; the card list gained Add a project,
the flat view and the sheet, the decision banners and blocker roll-up, and the papers that are not
active. An administrator, or anybody with five or more papers, lands on the sheet rather than the
cards, as before the rebuild. The lab-wide author nudge is a board on Active Papers. Shots 1 and
3–5 no longer match and need retaking.

Driven with Playwright against system Chrome: card and tab clicks, a reload on
`/my-work/<paper>/venue` (lands on the same tab), and Back (returns to the previous tab) were
exercised. The gateway was not running, so the shell shows its "disconnected" pill; nothing on
these pages depends on it.
