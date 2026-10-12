# Checked reimbursement submission evidence

Actual Lit reimbursement component, production CSS and controller, local HTTP API fixtures. Synthetic member/attachments; stubbed form generation and a no-op finance executor. No real receipts or email were used.

Before: API source at 3ffc6a25d9cc631a19bb1bf761097bfd661979bc accepts unchecked attachments and returns its executed result. After: current route refuses them with HTTP 422 and visible regeneration/review guidance. Regeneration through the server gate followed by keyboard submission succeeds against the no-op executor. The changing funder, missing form, renamed file, changed content and forged-proof cases are covered by route tests.

Desktop DOM viewport 1000×900; phone 390×844, no horizontal overflow (document width 384). Dark desktop/phone and light phone checked. Desktop captures use identical data, theme and workspace framing. Detail JPEGs are native-resolution crops of the unmodified context JPEGs: desktop (0,40)-(980,790), phone (0,60)-(375,520). Context files retain the original capture. No pixels enlarged or overlaid.

Pass 1: actual interactions and loading/disabled/rejection/recovery states observed. Pass 2: all saved detail files opened at native size, desktop details also opened at 640-pixel review width; labels and guidance readable, synthetic data only. Pass 3: rendered PR must be checked after publication and pinned to the pushed head.

The signing key belongs to the current API process. A restart/release requires regeneration and review; this intentionally rejects stale packages rather than retaining financial documents in a second cache. Proof establishes that the exact submitted package passed generation checks; it does not establish that claimant-entered financial facts are true.
