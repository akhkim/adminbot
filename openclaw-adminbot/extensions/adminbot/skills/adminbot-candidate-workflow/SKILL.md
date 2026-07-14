---
name: adminbot-candidate-workflow
description: Prepare AdminBot candidate decisions for lab applicants, including accept for trial, accept directly, and decline. Use for hiring or trial decisions, candidate review summaries, candidate evidence packets, or any request that could change a candidate's status.
---

# AdminBot Candidate Workflow

Use this skill for candidate decisions and candidate evidence packets.

## Flow

1. Summarize the candidate, role/project fit, and decision requested.
2. Gather evidence pointers from permitted sources: form response id, resume id,
   interview notes, Slack thread, email, or reviewer notes.
3. Separate evaluation from decision. Classification can support a decision but
   is not itself an accept/decline action.
4. Use `adminbot_propose_candidate_decision` for:
   - `accept_for_trial`
   - `accept_direct`
   - `decline`
5. Report the proposal id, risk tier, approval requirement, and payload hash.

## Decision Rules

- Treat all candidate decisions as T4.
- Never auto-accept or auto-decline.
- Include rationale grounded in evidence, not vibe.
- Include an undo plan such as returning the candidate to review, revoking
  onboarding tasks, or sending a correction.
- If evidence is thin or contradictory, propose a review task or questions
  instead of forcing a decision.

## Proposal Notes

Put the candidate name and email in the target when known. Put structured
decision details in `proposedPayload`, including project, reviewer, start date,
trial length, or decline reason category when available.
