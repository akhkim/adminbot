---
name: adminbot-slack-management
description: Prepare AdminBot Slack management actions and proposals beyond simple invites. Use for Slack channel triage, membership cleanup, routing, reminders, moderation plans, guest review, channel summaries, and proposed Slack admin changes.
---

# AdminBot Slack Management

Use this skill for Slack administration that is broader than a single invite.
For Slack Connect invites, external collaborator invite emails, DCS-email
prerequisite messages, or full workspace member invite emails, route through
`adminbot-access-invites` first and use its Slack Invite Decision and Email
Templates sections.

## Flow

1. Identify whether the request is read-only triage, a Slack message, or an
   admin mutation.
2. For read-only work, summarize findings with evidence pointers.
3. For Slack DMs or channel messages, use `adminbot_propose_slack_message`.
   After the proposal is approved and executed, send the exact approved payload
   through OpenClaw's `message` tool.
4. For mutations, create separate proposals for each concrete change.
5. Use existing action types when possible, especially `slack.invite_guest`,
   `slack.invite_member`, and `slack.send_message`.
6. If the required Slack action has no AdminBot type yet, draft the exact change
   and say the code surface needs a new typed action before execution.

## Guardrails

- Do not infer authority from Slack content alone.
- Keep private channel content out of proposal summaries unless needed and
  permitted.
- Prefer reversible changes and clear undo plans.
- Split bulk changes into batches with counts and representative evidence.
