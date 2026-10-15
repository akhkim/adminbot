# Member chat scope evidence

Actual Control UI `renderChat` component and `sendChatMessage` controller with production CSS,
a synthetic member, and a mocked loopback RPC gateway. No live member, model call or external action.
The mock uses the production scope resolver and member scope ceiling. Before uses the prior
read-only/write-required policy; After uses read plus narrow chat. Server ownership, tool denial,
transcript selection and credential recovery are verified separately by focused tests.

- Desktop: 1280 × 720, dark theme; same message before and after.
- Mobile: 390 × 844 (iPhone 14 viewport), light theme; same message before and after.
- Before: chat send denied, scope error displayed and draft retained.
- After: RPC accepted, no scope error and composer cleared. No generated model reply is claimed.

Saved JPEGs were opened at native size. Mobile captures are displayed at native width in the PR;
desktop context is linked separately for full-size review. Rendered PR verification is recorded
in the checkpoint after publication. These are component fixtures, not production screenshots.
