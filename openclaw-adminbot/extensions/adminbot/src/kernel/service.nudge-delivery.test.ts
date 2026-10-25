// A nudge's portal notification and its Slack send are two facts, and the summary counts them apart.
//
// Issue #536: a one-time webpage nudge recorded "ten notified" while the execution ledger showed two
// executed Slack sends and eight unresolved failures. The audit's `notified` was everyone who
// resolved to a member, so a failed DM, an alumnus and an opted-out member all read as told.
import { describe, expect, it, vi } from "vitest";
import type { AdminBotMemberNudgeResult } from "../contracts/actions.js";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

function serviceWithOutcomes(outcomes: Record<string, "ok" | "throw" | "kill-switch">) {
  const execute = vi.fn(async (proposal: { proposed_payload?: unknown }) => {
    const target = String((proposal.proposed_payload as { target?: unknown })?.target ?? "");
    const outcome = outcomes[target] ?? "ok";
    if (outcome === "throw") {
      throw new Error("slack: request timed out");
    }
    if (outcome === "kill-switch") {
      return { handled: true, delivered: false, reason: "slack delivery disabled" };
    }
    return { handled: true };
  });
  const service = new AdminBotService(undefined, { executor: { execute } });
  return { service, execute };
}

function memberNudgeAudit(service: AdminBotService) {
  const event = service.listAuditEvents().find((entry) => entry.type === "member_nudge.sent");
  return event?.details as Record<string, unknown>;
}

describe("member nudge delivery accounting", () => {
  it("reports two executed Slack sends and eight unknown outcomes, not ten notified sends", async () => {
    const outcomes: Record<string, "ok" | "throw"> = {};
    const ids: string[] = [];
    const { service, execute } = serviceWithOutcomes(outcomes);
    for (let index = 0; index < 10; index += 1) {
      const id = `m${index}`;
      ids.push(id);
      outcomes[`U${index}`] = index < 2 ? "ok" : "throw";
      unwrap(
        service.upsertLabMember({
          receives_nudges: true,
          id,
          name: `Member ${index}`,
          slack_user_id: `U${index}`,
        }),
      );
    }

    const result: AdminBotMemberNudgeResult = unwrap(
      await service.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: ids,
          message: "Add a personal webpage to your profile.",
        },
        "admin-1",
      ),
    );

    // Every one of them was told in the portal -- that copy is filed before the DM is tried.
    expect(result.portal_notified).toEqual(ids);
    expect(result.deliveries?.map((entry) => [entry.member_id, entry.outcome])).toEqual(
      ids.map((id, index) => [id, index < 2 ? "executed" : "unknown"]),
    );
    // Each row names its proposal, so the outcome can be reconciled against the ledger.
    for (const delivery of result.deliveries ?? []) {
      expect(service.getProposal(delivery.action_id)?.target).toMatchObject({
        recipientMemberId: delivery.member_id,
      });
    }
    expect(memberNudgeAudit(service)).toMatchObject({
      requested: 10,
      created: 2,
      skipped: 8,
      notified: 10,
      portal_notified: 10,
      executed: 2,
      not_delivered: 0,
      failed: 0,
      unknown: 8,
    });
    expect(memberNudgeAudit(service).unknown_action_ids).toHaveLength(8);
    // Reported, not retried: one execution attempt per recipient and no more.
    expect(execute).toHaveBeenCalledTimes(10);
  });

  it("counts only members a portal notification was filed for as notified", async () => {
    const { service } = serviceWithOutcomes({ "U-KILL": "kill-switch" });
    unwrap(
      service.upsertLabMember({
        receives_nudges: true,
        id: "sent",
        name: "Sent",
        slack_user_id: "U-SENT",
      }),
    );
    unwrap(
      service.upsertLabMember({
        receives_nudges: true,
        id: "held",
        name: "Held Back",
        slack_user_id: "U-KILL",
      }),
    );
    unwrap(service.upsertLabMember({ receives_nudges: true, id: "no-slack", name: "No Slack" }));
    unwrap(
      service.upsertLabMember({
        receives_nudges: true,
        id: "alum",
        name: "Alum",
        status: "alumni",
        slack_user_id: "U-ALUM",
      } as never),
    );
    unwrap(
      service.upsertLabMember({
        receives_nudges: false,
        id: "off-list",
        name: "Off List",
        slack_user_id: "U-OFF",
      }),
    );

    const result = unwrap(
      await service.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: ["sent", "held", "no-slack", "alum", "off-list", "missing"],
          message: "Add a personal webpage to your profile.",
        },
        "admin-1",
      ),
    );

    // The member with no Slack account is still told in the portal; the refused ones are not.
    expect(result.portal_notified).toEqual(["sent", "held", "no-slack"]);
    expect(result.deliveries?.map((entry) => [entry.member_id, entry.outcome])).toEqual([
      ["sent", "executed"],
      ["held", "not_delivered"],
    ]);
    expect(memberNudgeAudit(service)).toMatchObject({
      requested: 6,
      notified: 3,
      portal_notified: 3,
      executed: 1,
      not_delivered: 1,
      failed: 0,
      unknown: 0,
    });
    expect(memberNudgeAudit(service)).not.toHaveProperty("unknown_action_ids");
  });

  it("separates a send refused before it started from one whose outcome is unknown", async () => {
    // No executor at all: execution is refused with a 501 before anything is attempted.
    const service = new AdminBotService();
    unwrap(
      service.upsertLabMember({
        receives_nudges: true,
        id: "mei",
        name: "Mei",
        slack_user_id: "U-MEI",
      }),
    );

    const result = unwrap(
      await service.sendMemberNudge(
        { channel: "slack", recipient_member_ids: ["mei"], message: "Hello." },
        "admin-1",
      ),
    );

    expect(result.deliveries).toEqual([
      expect.objectContaining({
        member_id: "mei",
        outcome: "failed",
        reason: "no live connector is configured",
      }),
    ]);
    expect(memberNudgeAudit(service)).toMatchObject({ failed: 1, unknown: 0, executed: 0 });
  });
});
