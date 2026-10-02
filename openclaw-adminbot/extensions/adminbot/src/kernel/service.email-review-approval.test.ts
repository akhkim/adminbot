// Putting an undecided email to the reviewer as an approval, and applying what they approve.
//
// Two wires, tested as a pair because either alone is inert: the sweep that asks, and the execution
// that writes. What they exist to replace is a Control UI tab somebody had to remember to open.
import { describe, expect, it } from "vitest";
import { AdminBotMemoryStore } from "../persistence/memory.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

function held(overrides: Record<string, unknown> = {}) {
  return {
    message_id: "gmail-1",
    thread_id: "gmail-thread-1",
    sender: "candidate@example.com",
    subject: "Re: your onboarding",
    category: "unknown",
    reason: "onboarding follow-up matched no tracked onboarding thread",
    updated_at: "2026-09-14T10:00:00.000Z",
    ...overrides,
  };
}

function withHeldEmail(overrides: Record<string, unknown> = {}) {
  const store = new AdminBotMemoryStore();
  const service = new AdminBotService(store);
  store.saveEmailReview(held(overrides) as never);
  return { store, service };
}

/** Approve the one pending proposal the way the channel would, then execute it. */
async function approveAndExecute(
  service: AdminBotService,
  actionId: string,
  approverId = "andrew",
) {
  const pending = unwrap(service.listPending());
  const proposal = pending.proposals.find((row) => row.id === actionId);
  if (!proposal) {
    throw new Error("proposal is not pending");
  }
  unwrap(
    await service.approve(actionId, {
      payload_hash: proposal.payload_hash,
      approver_role: "admin",
      approver_id: approverId,
    }),
  );
  return unwrap(await service.execute(actionId, { dry_run: false }));
}

describe("email review as an approval", () => {
  it("asks about a held message once, and does not ask again while it sits", () => {
    const { service } = withHeldEmail();

    const first = unwrap(service.proposeEmailReviewResolutions("sweep"));
    expect(first.proposed).toEqual(["gmail-1"]);

    // The pass runs hourly against the same queue. Without the ledger this is a fresh approval in
    // Slack every hour until somebody answers it.
    const second = unwrap(service.proposeEmailReviewResolutions("sweep"));
    expect(second.proposed).toEqual([]);
    expect(second.already_asked).toEqual(["gmail-1"]);
  });

  it("asks again when the pass has touched the message since", () => {
    const { store, service } = withHeldEmail();
    unwrap(service.proposeEmailReviewResolutions("sweep"));
    store.saveEmailReview(held({ updated_at: "2026-09-14T11:00:00.000Z" }) as never);
    expect(unwrap(service.proposeEmailReviewResolutions("sweep")).proposed).toEqual(["gmail-1"]);
  });

  it("proposes dismissal for a message nothing can be attached to, and needs approval first", () => {
    const { service } = withHeldEmail();
    const actionId = unwrap(service.listPending()).proposals.length;
    expect(actionId).toBe(0);

    unwrap(service.proposeEmailReviewResolutions("sweep"));
    const [proposal] = unwrap(service.listPending()).proposals;
    expect(proposal?.type).toBe("email_review.resolve");
    expect(proposal?.summary).toContain("dismiss");
    // The point of routing this through an approval rather than a tool: it does not apply itself.
    expect(proposal?.status).toBe("pending");
    expect((proposal?.proposed_payload as Record<string, unknown>).resolution).toEqual({
      kind: "dismissed",
    });
  });

  it("applies the dismissal on approval, and names the approver as the resolver", async () => {
    const { service } = withHeldEmail();
    unwrap(service.proposeEmailReviewResolutions("sweep"));
    const [proposal] = unwrap(service.listPending()).proposals;

    const executed = await approveAndExecute(service, proposal!.id, "andrew");
    expect(executed.status).toBe("executed");

    // Gone from the queue, and the audit row carries who decided it.
    expect(unwrap(service.listEmailReviews()).reviews).toEqual([]);
    const resolved = unwrap(service.listEmailReviews()).recent_resolutions;
    expect(resolved[0]).toMatchObject({
      message_id: "gmail-1",
      resolution: "dismissed",
      resolved_by: "andrew",
    });
  });

  // The approval can sit in Slack for a day, and the queue is also worked from the Control UI. If
  // somebody settles the item there first, pressing approve must fail rather than report a
  // resolution that did not happen -- the same fail-closed rule the connectors follow.
  it("fails the execution when the item was already settled in the Control UI", async () => {
    const { service } = withHeldEmail();
    unwrap(service.proposeEmailReviewResolutions("sweep"));
    const [proposal] = unwrap(service.listPending()).proposals;
    unwrap(
      await service.approve(proposal!.id, {
        payload_hash: proposal!.payload_hash,
        approver_role: "admin",
        approver_id: "andrew",
      }),
    );

    // Settled in the Control UI in the gap between the press and the write.
    unwrap(
      service.resolveEmailReview({
        messageId: "gmail-1",
        resolution: { kind: "dismissed" },
        actor: "zhijing",
      }),
    );

    const executed = await service.execute(proposal!.id, { dry_run: false });
    expect(executed.ok).toBe(false);
    if (!executed.ok) {
      expect(executed.error.message).toContain("already resolved");
    }
    // And the first decision stands, under the name of whoever actually made it.
    expect(unwrap(service.listEmailReviews()).recent_resolutions[0]).toMatchObject({
      resolved_by: "zhijing",
    });
  });

  it("refuses a payload it cannot read instead of guessing at the resolution", async () => {
    const { service } = withHeldEmail();
    const created = unwrap(
      service.createProposal({
        type: "email_review.resolve",
        summary: "Resolve held email with a broken payload",
        target: { service: "adminbot", channel: "adminbot", target: "gmail-1" },
        proposed_payload: { message_id: "gmail-1", resolution: { kind: "attach-everything" } },
        undo_plan: "none",
      }),
    );
    const pending = unwrap(service.listPending()).proposals.find((row) => row.id === created.id);
    unwrap(
      await service.approve(created.id, {
        payload_hash: pending!.payload_hash,
        approver_role: "admin",
        approver_id: "andrew",
      }),
    );
    const executed = await service.execute(created.id, { dry_run: false });
    expect(executed.ok).toBe(false);
    if (!executed.ok) {
      expect(executed.error.message).toContain("payload is invalid");
    }
    // And the message is still in the queue, unresolved.
    expect(unwrap(service.listEmailReviews()).reviews).toHaveLength(1);
  });
});
