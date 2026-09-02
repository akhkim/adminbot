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

  // A configured channel id used to be searched for as a channel *name*, which never matched and
  // refused the send -- and standing-channel invites run before the mail, so that took the welcome
  // with it. An id now goes straight to the invite with no directory lookup at all.
  it("invites by id without looking the directory up", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => '{"ok":true}',
    });
    const executor = createAdminBotSlackAdminExecutor({
      env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    const result = await executor.execute(
      proposal("slack.invite_to_channel", { channel: "C0A06H6K6DV", user_id: "U-YANN" }),
    );

    expect(result).toEqual({ handled: true });
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes("conversations.list"))).toBe(false);
    expect(urls).toContain("https://slack.com/api/conversations.invite");
  });

  // A name still resolves through the directory, which is what the city-channel sweep passes.
  it("still resolves a channel name through the directory", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({ ok: true, channels: [{ id: "C-TORONTO", name: "group-toronto" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => '{"ok":true}',
      });
    const executor = createAdminBotSlackAdminExecutor({
      env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    const result = await executor.execute(
      proposal("slack.invite_to_channel", { channel: "group-toronto", user_id: "U-ADA" }),
    );

    expect(result).toEqual({ handled: true });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("conversations.list");
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
