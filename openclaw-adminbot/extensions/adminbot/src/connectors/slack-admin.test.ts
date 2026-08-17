import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { createAdminBotSlackAdminExecutor } from "./slack-admin.js";

function proposal(
  type: AdminBotStoredProposal["type"],
  proposed_payload: Record<string, unknown>,
): AdminBotStoredProposal {
  return {
    id: "act_1",
    type,
    summary: "test",
    proposed_payload,
    risk_tier: "T1",
    payload_hash: "hash",
    status: "approved",
    approval_requirement: {
      requires_approval: false,
      approver_roles: [],
      min_approvals: 0,
    },
    approvals: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("createAdminBotSlackAdminExecutor", () => {
  it("renames a channel", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", text: async () => '{"ok":true}' });
    const executor = createAdminBotSlackAdminExecutor({
      env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    const result = await executor.execute(
      proposal("slack.rename_channel", { channel_id: "C1", new_name: "proj-influence-functions" }),
    );

    expect(result).toEqual({ handled: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://slack.com/api/conversations.rename",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("DMs the owner for naming notices", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => '{"ok":true,"channel":{"id":"D1"}}',
      })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", text: async () => '{"ok":true}' });
    const executor = createAdminBotSlackAdminExecutor({
      env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    const result = await executor.execute(
      proposal("slack.channel_naming_notify_owner", {
        owner_user_id: "U1",
        message: "Please rename #eu-post-training",
      }),
    );

    expect(result).toEqual({ handled: true });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://slack.com/api/conversations.open",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns handled:false for unrelated action types", async () => {
    const fetchImpl = vi.fn();
    const executor = createAdminBotSlackAdminExecutor({
      env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    const result = await executor.execute(proposal("email.send", { to: "a@b.com", subject: "x", body: "y" }));
    expect(result).toEqual({ handled: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
