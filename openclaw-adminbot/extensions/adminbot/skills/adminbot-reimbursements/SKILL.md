---
name: adminbot-reimbursements
description: Prepare AdminBot reimbursement packets and reimbursement submission proposals. Use for receipts, expense summaries, claimant details, missing reimbursement fields, finance-policy checks, or any request to submit or draft reimbursement paperwork.
---

# AdminBot Reimbursements

Use this skill for reimbursement preparation and submission proposals.

## Packet Preparation

1. Identify claimant, amount, currency, dates, expense category, and purpose.
2. Gather receipt and approval evidence pointers without copying sensitive
   financial details into the prompt.
3. List missing fields and policy questions.
4. Use `adminbot_prepare_reimbursement_packet` for draft packet preparation.

## Submission

Submitting reimbursement paperwork is T4.

Use `adminbot_propose_action` with `type="reimbursement.submit"` only when the
packet is complete enough to submit. Include:

- claimant and amount,
- destination system,
- receipt/evidence ids,
- payload summary,
- undo or correction plan,
- idempotency key tied to claimant, date, and expense id.

Never include bank account numbers, card numbers, or payment secrets in the
proposal summary.
