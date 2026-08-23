# AdminBot — Lab Admin Assistant

<p align="center">
  <strong>Approval-gated AI operations for the lab.</strong>
</p>

**AdminBot** is an AI assistant that runs the lab's administrative work — managing members,
papers, reimbursements, recommendation letters, calendar/email, Slack, and social posts —
behind a human approval gate. It exposes a web **Control UI** for admins and members, and it
executes real-world actions (Google Workspace, Overleaf, messaging) only after they are
reviewed and approved. Unsupported live actions fail closed.

It is built on top of [OpenClaw](https://github.com/openclaw/openclaw) — that base provides the
gateway, agent/tool loop, messaging connectors, device pairing, and the Control UI shell. The
`openclaw-adminbot/` directory is that base plus the AdminBot layer; the `openclaw-setup/`
directory holds a sanitized setup template. This is a **private lab-sharing repository**, not a
public product.

---

## What AdminBot adds

- **`adminbot` plugin** — proposal, approval, audit, lab-member, paper-workflow, privacy-routing,
  and action-execution tools, loaded from `openclaw-adminbot/extensions/adminbot`.
- **AdminBot HTTP service** — a member-facing API (member auth, roster, papers, reimbursements,
  settings, proposals/approvals) served alongside the gateway. Started via
  `openclaw-adminbot/start-adminbot.mjs`.
- **Control UI** — admin and member panels for pending actions, members, papers, settings,
  nudges, and the sensitive-information policy. Deployed to Vercel (see [Hosting](#hosting)).
- **Member vs. admin model** — accounts have a privilege level. Admins and core members get the
  full operator surface; ordinary members get a read-scoped UI with no pending actions, no
  member-management, and no privileged chat actions. Enforcement is bound to the gateway device
  pairing granted at login, so it can't be bypassed from the client.
- **Approval-gated connectors** — Google actions via `gog`, message delivery, social posting,
  Overleaf edits, and paper reminders. Every live action routes through the proposal → approval →
  execution pipeline.
- **Local-first privacy** — loopback classification and placeholder-only remote reasoning; remote
  models see sanitized content only when sanitization is proven safe.

## Architecture

- The **gateway** is the control plane (sessions, tools, events) and the WebSocket surface the
  Control UI connects to. Authorization is enforced via per-device pairing scopes.
- The **AdminBot service** is the member-facing HTTP API. Login issues a member session; the
  member's privilege caps the gateway scopes their device is paired with.

## Setup

`openclaw-setup/` contains shareable setup metadata and a **sanitized** configuration template. It
deliberately omits credentials, device identity and pairing state, runtime databases, logs,
memory, browser state, media, sandboxes, and personal workspaces.

1. Copy the template and fill in local secrets via environment variables or your secret manager.
2. Run the normal OpenClaw onboarding, then the AdminBot setup flow.

Never commit real secrets, device pairing state, or the gateway token.

## Develop

Runtime: **Node 22.19+**. Use `pnpm` (the repo is a pnpm workspace; bundled plugins load from
`extensions/*` during development).

```bash
cd openclaw-adminbot
pnpm install

# Build once (extension + Control UI)
pnpm build
pnpm ui:build

# Run the AdminBot service + gateway locally
node start-adminbot.mjs

# Iterate on the Control UI
pnpm ui:dev
```

`pnpm gateway:watch` does not rebuild `dist/control-ui`; rerun `pnpm ui:build` after `ui/`
changes. On memory-constrained boxes, prefer targeted builds/tests over whole-tree sweeps.

## Relationship to upstream OpenClaw

This repo has **no shared git history** with upstream `openclaw/openclaw`. AdminBot development
happens in a separate dev checkout whose `origin` is upstream; content lands here as squashed
sync commits, and teammates open PRs on top of the latest sync. When updating the OpenClaw base,
rebase or diff the AdminBot layer against upstream rather than merging (the histories are
disjoint). Lab-repo-local files (`vercel.json`, `pnpm-lock.yaml`, `.gitignore`) are not part of
the sync and stay here.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Open PRs against the latest sync commit on `main`.
