import { describe, expect, it, vi } from "vitest";
import { enforceActiveChannels } from "./service.active-channels.js";
import { AdminBotMemoryStore, AdminBotService } from "./service.js";

function lab() {
  const store = new AdminBotMemoryStore();
  const execute = vi.fn(async () => ({ handled: true }));
  const service = new AdminBotService(store, { executor: { execute } });
  for (const [id, type] of [
    ["UFULL", "full"],
    ["UALUM", "full, alumni"],
    ["UMAJOR", "coauthor-major"],
    ["UMINOR", "coauthor-minor"],
    ["UOWN", "own-pace-advisee"],
  ]) {
    const result = service.upsertLabMember({
      id,
      name: id,
      email: `${id.toLowerCase()}@example.org`,
      member_type: type,
      privilege_level: "member",
      slack_user_id: id,
      slack_channels: ["jinesis-active", "random-active"],
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
  }
  const read = vi.fn(async () => [
    {
      channel: "jinesis-active",
      userIds: ["UFULL", "UALUM", "UMAJOR", "UMINOR", "UOWN", "UUNKNOWN"],
    },
    { channel: "random-active", userIds: ["UFULL", "UUNKNOWN"] },
  ]);
  return { store, service, execute, read };
}

describe("weekly active-channel policy", () => {
  it("removes ineligible and unmatched accounts with audited T3 approvals, preserving eligible alumni", async () => {
    const { store, service, execute, read } = lab();
    const result = await service.syncActiveChannels(read);
    expect(result.failed).toEqual([]);
    expect(result.removed.map((p) => p.user_id)).toEqual([
      "UMINOR",
      "UOWN",
      "UUNKNOWN",
      "UUNKNOWN",
    ]);
    expect(execute).toHaveBeenCalledTimes(4);
    for (const proposal of store.listProposalsByType("slack.remove_from_channel")) {
      expect(proposal).toMatchObject({
        status: "executed",
        risk_tier: "T3",
        approvals: [
          {
            approver_id: "system:weekly-active-channel-policy",
            payload_hash: proposal.payload_hash,
          },
        ],
      });
    }
    expect(service.listAuditEvents().some((e) => e.type === "approval.recorded")).toBe(true);
  });
  it("does not duplicate removals on repeat or concurrent calls; a subsequent week checks again", async () => {
    const { store, service, execute, read } = lab();
    await Promise.all([service.syncActiveChannels(read), service.syncActiveChannels(read)]);
    await service.syncActiveChannels(read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(store.listProposalsByType("slack.remove_from_channel")).toHaveLength(4);
    await enforceActiveChannels(service, store, read, new Date("2030-01-06T08:00:00Z"));
    expect(execute).toHaveBeenCalledTimes(8);
  });
  it("does not remove anything after a read failure or incomplete snapshot", async () => {
    const { service, execute } = lab();
    await expect(
      service.syncActiveChannels(async () => {
        throw new Error("Slack unavailable");
      }),
    ).rejects.toThrow("Slack unavailable");
    await expect(
      service.syncActiveChannels(async () => [
        { channel: "jinesis-active", userIds: ["UUNKNOWN"] },
      ]),
    ).rejects.toThrow("snapshot");
    expect(execute).not.toHaveBeenCalled();
  });
  it("refuses an empty database and reports connector failures without recording success", async () => {
    const { service, execute, read, store } = lab();
    await expect(new AdminBotService().syncActiveChannels(read)).rejects.toThrow(
      "empty member database",
    );
    execute.mockRejectedValue(new Error("missing user token"));
    const result = await service.syncActiveChannels(read);
    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(4);
    expect(
      store.listProposalsByType("slack.remove_from_channel").every((p) => p.status !== "executed"),
    ).toBe(true);
  });
  it("does not approve a caller's conflicting proposal using a cleanup key", async () => {
    const { store, service, execute, read } = lab();
    const date = new Date("2030-01-06T08:00:00Z");
    const proposal = service.createProposal({
      type: "slack.remove_from_channel",
      summary: "Wrong channel",
      target: { service: "slack", channel: "slack", target: "other" },
      proposed_payload: { channel: "other", user_id: "UFULL" },
      idempotency_key: "active-channel-cleanup:2030-01-06:jinesis-active:UMINOR",
    });
    const result = await enforceActiveChannels(service, store, read, date);
    expect(result.failed).toEqual([
      { channel: "jinesis-active", user_id: "UMINOR", reason: "Conflicting cleanup proposal" },
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
    if (!proposal.ok) {
      throw new Error(proposal.error.message);
    }
    expect(store.getProposal(proposal.payload.id)?.status).toBe("pending");
  });
  it("does not weaken ordinary removal approvals", async () => {
    const { service, execute } = lab();
    const result = service.createProposal({
      type: "slack.remove_from_channel",
      summary: "Ordinary removal",
      proposed_payload: { channel: "other", user_id: "UFULL" },
    });
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.payload.status).toBe("pending");
    expect((await service.execute(result.payload.id, { dry_run: false })).ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
