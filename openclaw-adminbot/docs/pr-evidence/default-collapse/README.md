# Default-collapse browser evidence

Actual production `renderPaperLegacy` and `renderPaperFeedback` components with production styles, synthetic paper/empty feedback slots, and disabled external saves. Captured at a 390×844 iPhone 14 viewport. This is component verification, not a live authenticated member session.

- `collapse450-legacy-mobile-before.jpg`: PR head `5efac4c9`, folded paper title pushes the workflow stage outside the card.
- `collapse450-legacy-mobile-light-closed.jpg`: heading can shrink; title uses its existing ellipsis and the stage remains visible. The accessible button name retains the full title.
- `collapse450-legacy-mobile-dark-groups.jpg`: keyboard-opened paper exposes all seven groups collapsed; opening Project leaves the other six closed. Full title is visible after expanding the paper.
- `collapse450-feedback-mobile-light-closed.jpg`: ARR, arXiv, and camera-ready headings all start closed.
- `collapse450-feedback-mobile-light-open.jpg`: Enter opens ARR while the other headings stay closed. Full form and queue control remain available; no submission was sent.

Images are unaltered browser captures (context clips where appropriate). Saved images were inspected at native size. Legacy and feedback interactions were also checked in the other theme; the legacy collapsed heading was checked at 1280×720. No performance or live persistence claim.

Remaining before overall PR readiness: actual styled checks for the other affected checklist, people, social settings, travel/reimbursements, weekly updates, admin board, and overview components; rendered destination verification of this evidence.
