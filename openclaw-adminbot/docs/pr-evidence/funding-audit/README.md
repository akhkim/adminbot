# Funding audit evidence

Backend/tool/CLI change; no visual component changes. No private template,
real author, paper or grant data is committed. Synthetic cases live beside the
workflow, service and HTTP route tests.

Before: manual Overleaf proposals contain instructions but no structured,
paper-specific funding-condition audit. Conditional template candidates can be
mistaken for universal acknowledgements.

After: the existing agent tool or `proposals create --file` creates a T4 proposal
with server-computed include/exclude/unknown findings, reasons, source revisions,
paper-time facts and preserved existing credits. Caller findings are replaced
before approval hashing. Unknown/stale/changed findings block the bridge call.
No new controller, model calls, grant defaults or external effects at creation.

## Verification

- 47 focused tests in six files pass: declarative OR/AND, explicit true/false vs
  missing facts, independent affiliation scope, multi-turn versus multi-agent,
  changed/missing/expired sources, contradictory facts, actual usage requirements,
  outside coauthor support, paper/order binding and forged findings/erased credits.
- CLI-to-real-HTTP-route test previews `papers funding-audit --file -` without creating a proposal, checks authentication and malformed input, then calls `proposals create --file -` with synthetic JSON:
  pending T4/two-admin proposal returned, forged caller finding replaced.
- Service/executor test verifies no bridge before two distinct admin approvals;
  after approval, one injected no-op bridge call for a ready audit. Unknown cases
  remain blocked after approval. No real bridge/model/private provider contacted.
- Extension typecheck passes. New workflow/service/HTTP tests and plugin entry
  lint clean; touched adapter retains exactly its baseline 10 lint findings and
  its test retains one baseline optional-chaining finding (compared to base
  3f5971d9 source). No baseline cleanup is included.
- Directory-size and whitespace checks pass.
- Full application build and exact-head CI: pending at initial preparation;
  current PR/owner receipt records final results.

No UI changes: interaction/screenshot evidence passes are not applicable to this
backend audit. Rendered PR verification is separate from actual live app proof.
No merge, deployment, production grant-eligibility verification or manuscript edit.

## Live limits

Sources/facts are reviewed operator assertions with explicit recheck deadlines.
This code does not fetch a live template, re-observe sources after approval, or
verify that a human assertion is true. A source changing before its deadline is
undetectable without a fresh observation. Private policy is supplied via input,
not installed as public defaults. Include/exclude describes a candidate condition,
not authorization to delete coauthor support. A configured existing bridge must
honor the exact reviewed edit and preservation constraints. Live bridge/production
behavior is unverified; exact approvals and a separately authorized release remain.
