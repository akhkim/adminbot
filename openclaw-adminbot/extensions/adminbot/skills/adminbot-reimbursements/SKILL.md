---
name: adminbot-reimbursements
description: Prepare AdminBot reimbursement packets and reimbursement submission proposals. Use for receipts, expense summaries, claimant details, missing reimbursement fields, finance-policy checks, or any request to submit or draft reimbursement paperwork.
---

# AdminBot Reimbursements

Use this skill for reimbursement preparation and submission proposals.

## Packet Preparation

1. Identify claimant name, email, address, title, personnel number when
   available, trip title, travel dates, destination, business purpose,
   reimbursement currency, and each receipt's date, category, description, and
   amount.
2. Gather every receipt and supporting evidence file without copying bank,
   card, or payment secrets into prompts or proposal summaries.
3. Prepare copies of both installed templates in `forms/`:
   - `Compute_Expense_Form.xlsx`: populate claimant/travel fields, requested
     currency, each receipt row, category totals, preparation date, and the
     claimant print-name/title fields.
   - `Trip_Summary_Form.docx`: populate trip/claimant/purpose fields, summarized
     expense categories and total, and the enclosed supporting-file list.
4. Keep the funding source, business-officer accounting allocation, claimant
   signature, and authorized-approver fields blank for human review.
5. Never invent an exchange rate or silently truncate receipts. A packet with
   mixed/unconverted currencies, more than 30 expense rows, or missing required
   claimant/trip facts needs review before delivery or submission.
6. The complete packet consists of both completed forms and every original
   receipt/supporting file, and list any remaining policy questions.

## Preparing the packet

Use `adminbot_reimbursement_converse` and `adminbot_reimbursement_generate`.
Those are the live path: they fill the real forms and hand the claimant the
files. The Control UI exposes the same thing on the Reimbursements tab, which
needs no account, so a claimant can complete a packet without one.

## Submission

AdminBot does not submit reimbursement paperwork. There is no connector behind
it, so a submission proposal would sit approved and unexecutable. Hand the
finished packet to the claimant and say where it goes.

Never include bank account numbers, card numbers, or payment secrets in anything
this skill produces.
