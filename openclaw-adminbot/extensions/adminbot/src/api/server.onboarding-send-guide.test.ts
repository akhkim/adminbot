import { describe, expect, it, vi } from "vitest";
import { createAdminBotMockService } from "./server.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

/** Approve then execute, the way the approval path does. */
async function approveAndRun(mock: ReturnType<typeof createAdminBotMockService>, actionId: string) {
  const svc = mock.service as never as {
    listPending: () => {
      ok: boolean;
      payload: { proposals: Array<{ id: string; payload_hash: string }> };
    };
    approve: (id: string, req: unknown) => Promise<unknown>;
    execute: (id: string, req: unknown) => Promise<unknown>;
  };
  const pending = svc.listPending().payload.proposals.find((row) => row.id === actionId);
  await svc.approve(actionId, {
    payload_hash: pending?.payload_hash,
    approver_role: "admin",
    approver_id: "admin",
  });
  return svc.execute(actionId, { dry_run: false });
}

function labWith(sender?: ReturnType<typeof vi.fn>) {
  const mock = createAdminBotMockService({
    ...(sender ? { onboardingSender: sender as never } : {}),
  });
  return mock;
}

const proposal = {
  type: "onboarding.send_guide" as const,
  summary: "Onboarding guide to Grace",
  target: { service: "google", channel: "email", target: "grace@lab.co" },
  proposed_payload: { template_id: "member", name: "Grace Hopper", email: "grace@lab.co" },
  undo_plan: "None.",
};

describe("executing an approved onboarding guide", () => {
  // The whole reason this is its own action: it runs the sender, which provisions as well as
  // mails. A rendered body on an email.send would deliver the promise and none of the rest.
  it("runs the onboarding sender rather than composing an email itself", async () => {
    const sender = vi.fn(async () => ({
      ok: true as const,
      payload: { template_id: "member", subject: "Welcome" },
    }));
    const mock = labWith(sender);
    const filed = unwrap(mock.service.createProposal(proposal as never));
    await approveAndRun(mock, filed.id);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0]?.[0]).toMatchObject({
      template_id: "member",
      email: "grace@lab.co",
    });
  });

  // A refusal is a fixable state -- an unfilled placeholder, a missing value -- so it comes back
  // as an undelivered execution carrying the reason, not as a silent success.
  it("reports the sender's refusal instead of marking the guide sent", async () => {
    const sender = vi.fn(async () => ({
      ok: false as const,
      error: { status: 422, message: "unfilled placeholder {contact_name}" },
    }));
    const mock = labWith(sender);
    const filed = unwrap(mock.service.createProposal(proposal as never));
    await approveAndRun(mock, filed.id);
    const stored = (
      mock.service as never as {
        store: { listProposalsByType: (t: string) => Array<{ status: string }> };
      }
    ).store.listProposalsByType("onboarding.send_guide");
    expect(stored[0]?.status).not.toBe("executed");
  });

  it("refuses rather than reporting success when no sender is configured", async () => {
    const mock = createAdminBotMockService({ onboardingSender: undefined });
    const filed = unwrap(mock.service.createProposal(proposal as never));
    await approveAndRun(mock, filed.id);
    // Either shape is acceptable; what must not happen is a guide recorded as sent.
    const stored = (
      mock.service as never as {
        store: { listProposalsByType: (t: string) => Array<{ status: string }> };
      }
    ).store.listProposalsByType("onboarding.send_guide");
    expect(stored[0]?.status).not.toBe("executed");
  });
});
