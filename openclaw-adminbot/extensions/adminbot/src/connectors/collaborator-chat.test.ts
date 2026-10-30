import { describe, expect, it, vi } from "vitest";
import type { AdminBotStoredProposal } from "../contracts/actions.js";
import { executeCollaboratorChat } from "./collaborator-chat.js";

const proposal = {
  id: "act_00000000-0000-4000-8000-000000000001",
  type: "slack.collaborator_chat",
  proposed_payload: {
    participants: [
      { member_id: "ada", slack_user_id: "UADA" },
      { member_id: "bea", slack_user_id: "UBEA" },
    ],
    message: "Synthetic opening message",
  },
} as AdminBotStoredProposal;
const response = (value: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: async () => JSON.stringify(value),
});
function fetcher() {
  return vi
    .fn()
    .mockResolvedValueOnce(response({ ok: true, user: { id: "UADA", deleted: false } }))
    .mockResolvedValueOnce(response({ ok: true, user: { id: "UBEA", deleted: false } }))
    .mockResolvedValueOnce(response({ ok: true, channel: { id: "GEXAMPLE" } }));
}

describe("approved collaborator-chat connector", () => {
  it("revalidates every active identity and retains separate conversation/message receipts", async () => {
    const fetch = fetcher().mockResolvedValueOnce(response({ ok: true, ts: "1.2" }));
    const result = await executeCollaboratorChat(proposal, "synthetic-token", fetch);
    expect(result.artifacts).toEqual({
      outcome: "message_accepted",
      slack_channel: "GEXAMPLE",
      slack_ts: "1.2",
    });
    expect(fetch.mock.calls.map((call) => String(call[0]).split("/").at(-1))).toEqual([
      "users.info",
      "users.info",
      "conversations.open",
      "chat.postMessage",
    ]);
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toMatchObject({
      text: "Synthetic opening message",
      client_msg_id: "00000000-0000-4000-8000-000000000001",
      mrkdwn: false,
    });
  });
  it("preserves an opened group when message delivery becomes unknown", async () => {
    const fetch = fetcher().mockRejectedValueOnce(new Error("Synthetic network timeout"));
    expect(await executeCollaboratorChat(proposal, "synthetic-token", fetch)).toMatchObject({
      delivered: false,
      artifacts: { outcome: "message_unknown", slack_channel: "GEXAMPLE" },
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("does not open a group for a deactivated identity", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(response({ ok: true, user: { id: "UADA", deleted: true } }));
    await expect(executeCollaboratorChat(proposal, "synthetic-token", fetch)).rejects.toThrow(
      "active Slack user",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
