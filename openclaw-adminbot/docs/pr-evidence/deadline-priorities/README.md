# Deadline action priority

Evidence uses the actual `adminbot-deadlines-view` component and production styles with a synthetic published-deadline store. No production member data, mutations or notification sends were used.

The fixture has a submission five days ago, camera-ready date two calendar dates ago (AoE cutoff), conference attendance tomorrow and author response three calendar dates ahead. The baseline is `aed1e82c1042898346827b3e5b3fd2086c0b3c0e`; the after images correspond to this change. Browser captures were made consecutively, so countdown seconds and fixture clock minutes differ.

- `before-context.jpg` / `after-context.jpg`: desktop dark Cards view, 1280×900 CSS viewport; native full-page captures. Different full-page heights and card column widths are retained as captured.
- `before-actions.jpg` / `after-actions.jpg`: native crops of those captures, action area at readable PR width; no pixels enlarged or text altered.
- `mobile-context.jpg`: light Groups view at verified 390×844 CSS viewport. Browser screenshot canvas is 480×1444; the responsive DOM width was 390 with scroll width 384.
- `mobile-detail.jpg`: native crop removing unused canvas whitespace, retaining controls, recent actions, headline and group.

Pass 1: exercised stage filtering (including recent-only Camera-ready), Cards and Groups, schedule disclosure and both themes. The future author-response action leads instead of earlier attendance; attendance remains available in the full schedule. Recent-only filtering no longer displays “Nothing matches this filter.” Desktop and mobile action labels are readable without horizontal overflow.

Pass 2: opened saved captures and crops at native size and approximate 650px PR display width. All images contain only synthetic venue labels and public source URLs. No screenshot edits beyond native cropping.

Pass 3: recorded in the PR/checkpoint after verifying the rendered destination.

Focused validation: 95 deadline/recommendation tests passed; full `scripts/build-all.mjs` passed, including the production UI build. No backend behavior or deployment is inferred from this component fixture.
