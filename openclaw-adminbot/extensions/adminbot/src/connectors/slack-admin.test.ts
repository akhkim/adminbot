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
    const fetchImpl = vi.fn().mockResolvedValueOnce({
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

  it("opens one group DM for a paper integrity alert", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => '{"ok":true,"channel":{"id":"G1"}}',
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
      proposal("paper_integrity.alert", {
        user_ids: ["UZHIJING", "UADA", "UGRACE", "UADA"],
        message: "ICLR pre-deadline check",
      }),
    );

    expect(result).toEqual({ handled: true });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ users: "UZHIJING,UADA,UGRACE" });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      channel: "G1",
      text: "ICLR pre-deadline check",
    });
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

  // name_taken is success. It is what lets the sweep say "there should be a channel called this"
  // every run without first asking Slack what exists.
  it("treats an existing project channel as created", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => '{"ok":false,"error":"name_taken"}',
    });
    const executor = createAdminBotSlackAdminExecutor({
      env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    await expect(
      executor.execute(proposal("slack.create_channel", { name: "proj-cais" })),
    ).resolves.toEqual({ handled: true });
  });

  // The whole safety story for auto-approving creation: the action cannot open a room that is not
  // a project channel, however it is called, so a bug upstream cannot reshape the workspace.
  it("refuses to open anything that is not a proj- channel", async () => {
    const fetchImpl = vi.fn();
    const executor = createAdminBotSlackAdminExecutor({
      env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    await expect(
      executor.execute(proposal("slack.create_channel", { name: "lab-secret" })),
    ).rejects.toThrow(/only proj-<alias> channels/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe("slack.remove_from_channel", () => {
    // Slack answers `restricted_action` when a bot token tries to kick somebody out of a public
    // channel, and it answers it with HTTP 200 -- so the only signal is the body. Both active
    // channels are public, which is why no amount of bot scope fixes this and the kick has to run
    // on the user token. The directory lookup stays on the bot, which holds channels:read.
    const env = {
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_USER_TOKEN: "xoxp-test",
    } as NodeJS.ProcessEnv;

    function okJson(body: string) {
      return { ok: true, status: 200, statusText: "OK", text: async () => body };
    }

    it("looks the channel up as the bot and kicks as the user", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          okJson('{"ok":true,"channels":[{"id":"C0A06H6K6DV","name":"jinesis-active"}]}'),
        )
        .mockResolvedValueOnce(okJson('{"ok":true}'));
      const executor = createAdminBotSlackAdminExecutor({ env, fetchImpl });

      const result = await executor.execute(
        proposal("slack.remove_from_channel", {
          channel: "jinesis-active",
          user_id: "U09V5B5F0A1",
        }),
      );

      expect(result).toEqual({ handled: true });
      const [lookupUrl, lookupInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(lookupUrl).toContain("conversations.list");
      expect((lookupInit.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-test");

      const [kickUrl, kickInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
      expect(kickUrl).toBe("https://slack.com/api/conversations.kick");
      // The whole point of the change: this header is the user token, not the bot's.
      expect((kickInit.headers as Record<string, string>).Authorization).toBe("Bearer xoxp-test");
      expect(JSON.parse(String(kickInit.body))).toEqual({
        channel: "C0A06H6K6DV",
        user: "U09V5B5F0A1",
      });
    });

    it("surfaces restricted_action rather than reading the 200 as success", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          okJson('{"ok":true,"channels":[{"id":"C0A06H6K6DV","name":"jinesis-active"}]}'),
        )
        .mockResolvedValueOnce(okJson('{"ok":false,"error":"restricted_action"}'));
      const executor = createAdminBotSlackAdminExecutor({ env, fetchImpl });

      await expect(
        executor.execute(
          proposal("slack.remove_from_channel", {
            channel: "jinesis-active",
            user_id: "U09V5B5F0A1",
          }),
        ),
      ).rejects.toThrow(/restricted_action/u);
    });

    it("refuses before calling Slack when the user token is missing", async () => {
      // Falling back to the bot token here would record an approval against a call that Slack was
      // never going to honour, so a deployment without the token fails closed instead.
      const fetchImpl = vi.fn();
      const executor = createAdminBotSlackAdminExecutor({
        env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
        fetchImpl,
      });

      await expect(
        executor.execute(
          proposal("slack.remove_from_channel", {
            channel: "jinesis-active",
            user_id: "U09V5B5F0A1",
          }),
        ),
      ).rejects.toThrow(/SLACK_USER_TOKEN is required/u);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("returns handled:false for unrelated action types", async () => {
    const fetchImpl = vi.fn();
    const executor = createAdminBotSlackAdminExecutor({
      env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    const result = await executor.execute(
      proposal("email.send", { to: "a@b.com", subject: "x", body: "y" }),
    );
    expect(result).toEqual({ handled: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the ICLR digest as one channel message", () => {
  const reply = (body: Record<string, unknown>) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(body),
  });
  const executorWith = (fetchImpl: ReturnType<typeof vi.fn>) =>
    createAdminBotSlackAdminExecutor({
      env: { SLACK_BOT_TOKEN: "xoxb-test" } as NodeJS.ProcessEnv,
      fetchImpl,
    });

  it("posts the first digest and reports the message it created", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply({ ok: true, ts: "1758841200.000100" }));
    const result = await executorWith(fetchImpl).execute(
      proposal("paper_integrity.report", { channel_id: "C0ACTIVE1", message: "Digest 1" }),
    );
    expect(result).toEqual({
      handled: true,
      artifacts: { slack_channel: "C0ACTIVE1", slack_ts: "1758841200.000100" },
    });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://slack.com/api/chat.postMessage");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      channel: "C0ACTIVE1",
      text: "Digest 1",
    });
  });

  it("edits the same message on the next sweep instead of posting another", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply({ ok: true, ts: "1758841200.000100" }));
    const result = await executorWith(fetchImpl).execute(
      proposal("paper_integrity.report", {
        channel_id: "C0ACTIVE1",
        message: "Digest 2",
        update_ts: "1758841200.000100",
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://slack.com/api/chat.update");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      channel: "C0ACTIVE1",
      ts: "1758841200.000100",
      text: "Digest 2",
    });
    expect(result.artifacts?.slack_ts).toBe("1758841200.000100");
  });

  // Somebody deleted the digest: post a new one rather than fail every hour until the deadline.
  it("posts anew when the message to edit is gone", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply({ ok: false, error: "message_not_found" }))
      .mockResolvedValueOnce(reply({ ok: true, ts: "1758844800.000200" }));
    const result = await executorWith(fetchImpl).execute(
      proposal("paper_integrity.report", {
        channel_id: "C0ACTIVE1",
        message: "Digest 3",
        update_ts: "1758841200.000100",
      }),
    );
    expect(fetchImpl.mock.calls[1][0]).toBe("https://slack.com/api/chat.postMessage");
    expect(result.artifacts?.slack_ts).toBe("1758844800.000200");
  });

  it("does not paper over any other failure with a new post", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(reply({ ok: false, error: "not_in_channel" }));
    await expect(
      executorWith(fetchImpl).execute(
        proposal("paper_integrity.report", {
          channel_id: "C0ACTIVE1",
          message: "Digest",
          update_ts: "1758841200.000100",
        }),
      ),
    ).rejects.toThrow(/not_in_channel/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a channel id that is not one", async () => {
    await expect(
      executorWith(vi.fn()).execute(
        proposal("paper_integrity.report", { channel_id: "#jinesis-active", message: "x" }),
      ),
    ).rejects.toThrow(/channel_id must be a Slack channel id/u);
  });
});
