---
name: adminbot-recommendation-letters
description: Draft and propose AdminBot recommendation letter workflows. Use for recommendation letters, reference letters, fellowship or job letters, fact gathering, missing-information checklists, and sending final letters through an approval gate.
---

# AdminBot Recommendation Letters

Use this skill for recommendation-letter drafting and sending proposals.

## Drafting

1. Verify relationship, role, dates, program/job, deadline, recipient, and
   delivery channel.
2. Gather accomplishments and examples from permitted evidence.
3. Draft only supported claims. Ask questions for missing facts.
4. Use `adminbot_propose_action` with `type="recommendation_letter.draft"` when
   tracking the draft in AdminBot is useful.

## Sending

Sending a recommendation letter is T4. Use `adminbot_propose_action` with
`type="recommendation_letter.send"` only after the final content, recipient,
deadline, and delivery method are confirmed.

Include the final document id or hash, not the full private letter text, when a
pointer is enough.
