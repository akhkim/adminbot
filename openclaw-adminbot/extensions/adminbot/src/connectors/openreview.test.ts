// The delivery kill switch, and the one thing it must never do: look like a delivery.
//
// ADMINBOT_OPENREVIEW_SEND is off by default so a freshly deployed service watches a full
// reviewing cycle before it can mail a committee. That mode is deliberate. What was not is that
// the executor reported it as success -- the Python bridge already answers
// `{"ok": true, "sent": false, "dry_run": true}` without `--send`, and this connector discarded
// that and returned `handled: true`, so the service stored an approved reminder nobody received
// as `executed` and wrote it into the audit trail as a delivery.
import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { createAdminBotOpenReviewExecutor } from "./openreview.js";

function proposal(overrides: Partial<AdminBotStoredProposal> = {}): AdminBotStoredProposal {
  return {
    id: "act_1",
    type: "openreview.nudge",
    risk_tier: "T1",
    summary: "ICLR submission 12: reviews are due",
    proposed_payload: {
      invitation: "ICLR.cc/2026/Conference/-/Message",
      signature: "ICLR.cc/2026/Conference/Program_Chairs",
      groups: ["ICLR.cc/2026/Conference/Submission12/Reviewers"],
      subject: "Reviews are due",
      body: "Please submit your review.",
    },
    payload_hash: "sha256:test",
    status: "approved",
    approval_requirement: { requires_approval: false, approver_roles: [], min_approvals: 0 },
    approvals: [],
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  } as AdminBotStoredProposal;
}

describe("createAdminBotOpenReviewExecutor", () => {
  it("reports a withheld message as handled but not delivered", async () => {
    const run = vi.fn(async () => ({ ok: true, sent: false, dry_run: true }));
    const executor = createAdminBotOpenReviewExecutor({ scriptPath: "/bin/true", send: false, run });

    const outcome = await executor.execute(proposal());

    // Handled, because this connector owns the type and did the composing and validating.
    expect(outcome.handled).toBe(true);
    // Not delivered, which is the half that used to be missing.
    expect(outcome.delivered).toBe(false);
    expect(outcome.reason).toContain("ADMINBOT_OPENREVIEW_SEND");
    // The bridge is still run -- composing and validating is the point of the rehearsal -- it is
    // simply never asked to post.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).not.toContain("--send");
  });

  it("delivers, and says so, once the switch is on", async () => {
    const run = vi.fn(async () => ({ ok: true, sent: true }));
    const executor = createAdminBotOpenReviewExecutor({ scriptPath: "/bin/true", send: true, run });

    const outcome = await executor.execute(proposal());

    expect(outcome).toEqual({ handled: true });
    expect(run.mock.calls[0]?.[0]).toContain("--send");
  });

  it("leaves another connector's action alone", async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const executor = createAdminBotOpenReviewExecutor({ scriptPath: "/bin/true", send: true, run });

    expect(await executor.execute(proposal({ type: "slack.send_message" }))).toEqual({
      handled: false,
    });
    expect(run).not.toHaveBeenCalled();
  });
});
