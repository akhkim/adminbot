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
4. Hand the draft back in the conversation. There is no letter-drafting action
   type: nothing in `connectors/` can send a letter, so a proposal would sit
   approved and unexecutable.

## Where a letter request actually lives

A member asks for letters through the Control UI's **Logistics -> Recommendation
Letters** template, which stores the schools, both deadlines per school with the
timezone they are read in, the CV and Drive links, and the per-project record of
what the member actually did. An admin works that queue.

That request is the system of record. Use this skill to help write the letter
itself; do not try to file the request or the send on the member's behalf.
