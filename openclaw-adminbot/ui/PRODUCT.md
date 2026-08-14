# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Members and admins of Jinesis Lab, roughly evenly weighted as daily audiences of the Control UI, plus anonymous visitors on two open surfaces:

- **Anonymous visitors**: no session. Reach only the reimbursement assistant (self-scoped, sees only what they typed) and the public deadline board (a bundled conference dataset).
- **Members**: signed-in lab members. Use the dashboard, their own profile, "my work" (paper progress, onboarding checklist), the roster, and the paper list. Every surface they see is scoped to their own role or their own record.
- **Admins**: the lab's sole approver class. Everything beyond member surfaces — registrations, onboarding administration, settings, announcements, activity, audit, and the AdminBot operator console — requires admin privilege.

## Product Purpose

AdminBot runs a research lab's administrative work — members, papers, reimbursements, recommendation letters, calendar and email, Slack, and social posts — behind a human approval gate. The Control UI is the member-facing surface: signed-in members see what's waiting on them (onboarding steps, blank mandatory profile fields, pending approvals) the moment they land, instead of behind a tab they had to think to open. Success is a lab where routine admin work moves through an agent-proposed, human-approved pipeline instead of manual back-and-forth, without members or admins ever needing to trust an agent acting unsupervised.

## Positioning

The agent **proposes; it never acts.** Every external effect — Slack messages, emails, calendar writes, reimbursement payouts, member approvals — is one of 33 typed action types that goes through the same pipeline: agent proposes → human approves (by payload hash) → service executes → audit. An action type with no executor fails closed; it is never recorded as executed. This is the mechanism a neighboring "AI admin assistant" could not truthfully copy without also giving up direct agent execution.

The Control UI's access table (`ui/src/ui/adminbot/access.ts`) is a **visibility contract, not a security boundary**: hiding a tab is a UI affordance, and the backing service re-checks every privileged route against the authenticated session independently of what the UI shows.

## Operating Context

- Three access roles, least to most privileged: `anonymous`, `member`, `admin`. A live gateway connection with no member session (an operator holding a gateway credential) is treated as `admin` — the break-glass operator path.
- Guest/anonymous entry points: the reimbursement assistant (upload a receipt, describe the expense, generate a reimbursement artifact) and the public deadline board.
- Signed-in member entry point: a dashboard that surfaces an "attention stack" — onboarding steps, blank mandatory profile fields, pending approvals — ahead of anything else, and collapses to nothing when there's nothing outstanding.
- The product is a fork of OpenClaw (an extensible multi-channel AI gateway); the gateway, agent runtime, and much of the Control UI shell are inherited, with AdminBot-specific surfaces layered under `ui/src/ui/adminbot/`.
- Deployed at `https://jinesis-admin.vercel.app` (Vercel, from the lab's separate deploy repo).

## Capabilities and Constraints

- 33 typed, auditable action types cover the lab's admin surface area: members, papers, reimbursements, recommendation letters, calendar/email (via `gog`), Slack, and social posts.
- The underlying model runs with a minimal tools profile: no shell, no filesystem, no browser access — the agent's only path to effect is a proposal.
- The Control UI's role table is a presentation-layer contract only; actual authorization is enforced server-side per request.

## Brand Commitments

- Product/lab name: **Jinesis Lab**, wordmark rendered as "Jinesis" + "Lab" (two-weight lockup) on the signed-out landing page.
- Existing visual system: dark theme (`#0a0a0a` background/theme color per the PWA manifest), inherited largely from the OpenClaw Control shell it forks.
- App manifest currently still reads "OpenClaw Control" / "Multi-channel AI gateway control panel" — a legacy artifact from the fork, not a deliberate brand choice for AdminBot/Jinesis Lab.

## Evidence on Hand

No customer testimonials, case studies, or external press — this is an internal lab tool, not a marketed product. The deadline board's bundled conference dataset is the one piece of real, reviewed content shipped with the app; treat it as real data, not a placeholder.

## Product Principles

1. **Propose, never act.** Every surface that lets a person trigger an external effect is a proposal into the approve → execute → audit pipeline, never a direct action — design should make that gate visible, not hide it behind a button that reads as instant.
2. **Fail closed, not silently.** An action type with no executor must never look like it succeeded. UI states should distinguish "proposed," "approved," "executed," and "failed closed" rather than collapsing them into a generic success/error state.
3. **Attention over navigation.** What's waiting on a member (onboarding, blank fields, pending approvals) surfaces first; the rest of the app is there to be found, not to be scanned every visit.
4. **Visibility is not security.** The UI may hide tabs a role shouldn't see, but must never imply that hiding is what protects the underlying data — copy and states should not overstate what the client enforces.
5. **Guest paths stay self-scoped.** Anonymous surfaces (reimbursement assistant, deadline board) must never suggest they see more than what the visitor themselves provided or a public dataset.

## Accessibility & Inclusion

No specific standard or user need has been mandated beyond ordinary good practice.
