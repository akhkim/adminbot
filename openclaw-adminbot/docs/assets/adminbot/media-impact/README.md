# Media Impact UI evidence

Actual `renderProfile` and shared member-badge symbols with production styles and synthetic records; no connected backend. X = 2,500, LinkedIn = 10,000; derived assignment = 10,000. Baseline uses the unchanged components at c5e60333 (same rendered profile/symbol implementation as main); the same synthetic assignment's follower count is ignored there and displays the historical default award count 1. This demonstrates presentation, not a real stored historical award or live eligibility.

Desktop screenshots use the normal browser viewport. iPhone screenshots use a measured 390 × 844 viewport; document width 384 (no page overflow). Both light/dark themes checked. The `*-detail.jpg` files are native-resolution crops of the original context screenshots because browser clipping mis-scaled the coordinates; originals retained. Controls remained readable and zero autosaved as numeric `twitter_followers: 0` through the actual component callback.

Backend tests cover strict >1,000 threshold, maximum, increasing/decreasing/zero counts, invalid numbers, historical award preservation, customized catalog preservation and startup idempotency. UI tests cover numeric autosave and compact/accessibility labels. Screenshot fixtures do not prove authenticated API persistence or a deployed backend.
